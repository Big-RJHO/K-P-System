"""Scan confidence (standalone/src/confidence.js): how well a photo supports inspection, never a grade probability."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import cv2
import pytest

from synthetic import H, W, make_borderless, make_card, place_on_background

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

YELLOW = (40, 205, 245)
LEVELS = {"high", "medium", "low", "cannot_assess", "not_scanned", "assessing"}
LABELS = {"High", "Medium", "Low", "Cannot assess", "Not scanned", "Assessing scan…"}

# Scans each photo, runs the photo-quality gate and edge/corner check, derives centering evidence the way the app
# does (a side is read when its border confidence is at least 0.3), then assesses confidence with each variant.
SCRIPT = """
const V = require(%(vision)s), I = require(%(inspect)s), C = require(%(conf)s), S = require(%(surface)s), fs = require("fs");
const jobs = JSON.parse(fs.readFileSync(0, "utf8"));
const out = jobs.map((j) => {
  const img = { width: j.width, height: j.height, data: new Uint8ClampedArray(fs.readFileSync(j.path)) };
  let scan = V.scan(img, "auto");
  if (j.rescanWithCorners) scan = V.scan(img, "auto", scan.corners);   // the outline placed by hand
  const quality = I.quality(img, scan);
  const check = I.edgesAndCorners(scan, { quality });
  const per = scan.confidence.per_side, ok = (s) => per[s] >= 0.3;
  const evidence = j.evidence || { lr: ok("left") && ok("right") ? "measured" : "unread", tb: ok("top") && ok("bottom") ? "measured" : "unread" };
  const base = { scan, quality, check, evidence, outlineAdjusted: !!j.rescanWithCorners };
  const res = { flat: C.assess(base), angled: C.assess({ ...base, angledLight: true }) };
  // a filter preview is not an input: an extra key, or filtering the warp, changes nothing
  res.withFilterKey = C.assess({ ...base, filter: { kind: "contrast", intensity: 1 } });
  S.filter(scan.warped, { kind: "contrast", intensity: 1 });
  res.afterFilter = C.assess(base);
  res.quality = { verdict: quality.verdict, blocked: quality.blocked, checks: Object.fromEntries(Object.entries(quality.checks).map(([k, v]) => [k, v.status])) };
  return res;
});
process.stdout.write(JSON.stringify(out));
"""

# Pure-function checks on hand-made inputs (no image needed).
PURE = """
const C = require(%(conf)s);
const scan = { confidence: { card: 0.95, borders: 0.8, per_side: { left: 0.9, right: 0.9, top: 0.9, bottom: 0.9 } } };
const ok = (note) => ({ status: "ok", note: note || "ok" });
const checks = () => ({ sharpness: ok(), glare: { status: "ok", note: "", where: {} }, resolution: ok(), boundary: ok(), perspective: ok(), detection: ok(), sleeve: { status: "ok", value: false, note: "" } });
const sides = () => Object.fromEntries(["top", "right", "bottom", "left"].map((s) => [s, { assessable: true, reason: null }]));
const corners = () => ["top_left", "top_right", "bottom_right", "bottom_left"].map((location) => ({ location, assessable: true, reason: null }));
const q = (over) => { const c = checks(); Object.assign(c, over || {}); return { verdict: "ok", checks: c, blocked: [], blocked_reasons: {} }; };
const check = () => ({ sides: sides(), corners: corners() });
const ev = { lr: "measured", tb: "measured" };
const r = {};
r.clean = C.assess({ scan, quality: q(), check: check(), evidence: ev });
r.angled = C.assess({ scan, quality: q(), check: check(), evidence: ev, angledLight: true });
const detWarn = q({ detection: { status: "warn", note: "uncertain" } });
r.detWarn = C.assess({ scan, quality: detWarn, check: check(), evidence: ev });
r.detWarnAdjusted = C.assess({ scan, quality: detWarn, check: check(), evidence: ev, outlineAdjusted: true });
const detFail = q({ detection: { status: "fail", note: "x" } }); detFail.blocked_reasons = { centering: ["detection"] };
r.detFail = C.assess({ scan, quality: detFail, check: check(), evidence: ev });
const cut = q({ boundary: { status: "fail", note: "The card is cut off at the top-left corner." } }); cut.blocked_reasons = { centering: ["boundary"] };
r.cutOff = C.assess({ scan, quality: cut, check: check(), evidence: ev });
const lowRes = q({ resolution: { status: "fail", note: "small" } }); lowRes.blocked_reasons = { surface: ["resolution"] };
r.lowRes = C.assess({ scan, quality: lowRes, check: check(), evidence: ev });
r.noCheck = C.assess({ scan, quality: q(), check: null, evidence: ev });
r.unreadBoth = C.assess({ scan, quality: q(), check: check(), evidence: { lr: "unread", tb: "unread" } });
r.unreadTb = C.assess({ scan, quality: q(), check: check(), evidence: { lr: "measured", tb: "unread" } });
r.typed = C.assess({ scan, quality: q(), check: check(), evidence: { lr: "typed", tb: "measured" } });
r.missingEvidence = C.assess({ scan, quality: q(), check: check() });
const faint = { confidence: { card: 0.95, per_side: { left: 0.9, right: 0.1, top: 0.9, bottom: 0.9 } } };
r.faint = C.assess({ scan: faint, quality: q(), check: check(), evidence: ev });
const sleeve = q({ sleeve: { status: "warn", value: true, note: "" } });
r.sleeve = C.assess({ scan, quality: sleeve, check: check(), evidence: ev });
const many = check(); for (const s of ["top", "right", "bottom", "left"]) many.sides[s] = { assessable: false, reason: "white border" };
r.whiteBorder = C.assess({ scan, quality: q(), check: many, evidence: ev });
r.notScanned = C.notScanned();
r.assessing = C.assessing();
r.combineMissingBack = C.combine(r.clean, C.notScanned());
r.combineNullBack = C.combine(r.clean, null);
r.combineWeakBack = C.combine(r.angled, r.detFail);
r.combineBothHigh = C.combine(r.angled, r.angled);
r.combineNone = C.combine(null, null);
r.combinePending = C.combine(r.angled, C.assessing());
r.combineOnlyAssessing = C.combine(C.assessing(), null);
r.T = C.THRESHOLDS; r.LEVELS = C.LEVELS; r.RULES = C.RULES;
process.stdout.write(JSON.stringify(r));
"""


def _paths() -> dict:
    return {k: json.dumps(str(SRC / f)) for k, f in (("vision", "vision.js"), ("inspect", "inspect.js"), ("conf", "confidence.js"), ("surface", "surface.js"))}


def run_photos(images: list, tmp_path: Path) -> list[dict]:
    jobs = []
    for i, item in enumerate(images):
        bgr, extra = item if isinstance(item, tuple) else (item, {})
        path = tmp_path / f"conf{i}.rgba"
        path.write_bytes(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGBA).tobytes())
        jobs.append({"path": str(path), "width": bgr.shape[1], "height": bgr.shape[0], **extra})
    res = subprocess.run([NODE, "-e", SCRIPT % _paths()], input=json.dumps(jobs), capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


@pytest.fixture(scope="module")
def pure():
    res = subprocess.run([NODE, "-e", PURE % _paths()], capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


@pytest.fixture(scope="module")
def clean_photo():
    return place_on_background(make_card(40, 31, 44, 47, border_bgr=YELLOW), 3)


@pytest.fixture(scope="module")
def photos(tmp_path_factory, clean_photo):
    """One node run for every real-photo case (each scan takes a second or two)."""
    bh, bw = clean_photo.shape[:2]
    glare = clean_photo.copy()
    # a blown-out highlight on the card's top-right corner only (the card is rotated 3 degrees about the centre)
    cv2.ellipse(glare, (int(bw / 2 + W / 2 - 4), int(bh / 2 - H / 2 + 22)), (34, 30), 0, 0, 360, (255, 255, 255), -1)
    cases = {
        "clean": clean_photo,
        "soft": cv2.GaussianBlur(clean_photo, (0, 0), 2),
        "blurry": cv2.GaussianBlur(clean_photo, (0, 0), 3),
        "glare_corner": glare,
        "borderless": place_on_background(make_borderless(), 2),
        "adjusted": (clean_photo, {"rescanWithCorners": True}),
        "unread_forced": (clean_photo, {"evidence": {"lr": "unread", "tb": "unread"}}),
    }
    out = run_photos(list(cases.values()), tmp_path_factory.mktemp("conf"))
    return dict(zip(cases, out))


def walk(value, path="$"):
    """Every (path, leaf) in a JSON value."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield from walk(v, f"{path}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from walk(v, f"{path}[{i}]")
    else:
        yield path, value


def assert_well_formed(sc: dict):
    assert sc["level"] in LEVELS and sc["label"] in LABELS
    assert set(sc["areas"]) == {"outline", "centering", "corners_edges", "surface_visibility"}
    for a in sc["areas"].values():
        assert a["level"] in LEVELS and isinstance(a["reason"], str) and a["reason"]
    assert isinstance(sc["summary"], str) and sc["summary"].endswith((".", "…")) and sc["summary"].count(". ") == 0  # one sentence
    assert all(a["id"] in {"retake", "adjust_outline", "angled_light"} and a["label"] for a in sc["actions"])
    # never a number or a percentage: no numeric leaves, no "%" anywhere
    for path, leaf in walk(sc):
        assert not isinstance(leaf, (int, float)) or isinstance(leaf, bool), (path, leaf)
        if isinstance(leaf, str):
            assert "%" not in leaf, (path, leaf)


# ---------------------------------------------------------------- real photos


def test_clean_scan_is_surface_limited_not_unqualified_high(photos):
    r = photos["clean"]
    assert r["quality"]["verdict"] == "ok"
    flat = r["flat"]
    assert_well_formed(flat)
    assert {k: a["level"] for k, a in flat["areas"].items()} == {"outline": "high", "centering": "high", "corners_edges": "high", "surface_visibility": "low"}
    assert flat["surfaceLimited"] is True
    assert flat["level"] == "medium" and flat["label"] == "Medium"  # capped: a flat photo can't show the surface
    assert "limited — surface needs inspection" in flat["summary"].lower()
    assert flat["summary"].startswith("Clear outline")
    assert "R_FLAT" in flat["rules"]
    assert [a["id"] for a in flat["actions"]] == ["angled_light"]
    # the same photo taken under angled light would support everything
    angled = r["angled"]
    assert angled["level"] == "high" and angled["surfaceLimited"] is False and angled["actions"] == []


def test_blur(photos):
    soft, blurry = photos["soft"], photos["blurry"]
    assert soft["quality"]["checks"]["sharpness"] == "warn"
    assert soft["flat"]["areas"]["corners_edges"]["level"] == "medium"
    assert soft["flat"]["level"] == "medium"
    assert "soft" in soft["flat"]["summary"]
    assert any(a["id"] == "retake" for a in soft["flat"]["actions"])
    assert blurry["quality"]["checks"]["sharpness"] == "fail"
    b = blurry["flat"]
    assert_well_formed(b)
    assert b["areas"]["corners_edges"]["level"] == "cannot_assess"
    assert b["areas"]["surface_visibility"]["level"] == "cannot_assess"
    assert b["level"] == "low" and "R_CE_FAIL" in b["rules"]  # hard rule: a focus failure caps the photo at low
    assert "corners_edges" in b["notCovered"] and "blurry" in b["summary"]
    assert b["actions"][0]["id"] == "retake"
    assert blurry["angled"]["level"] == "low"  # angled light doesn't rescue a blurry photo


def test_glare_localized_to_one_corner(photos):
    r = photos["glare_corner"]
    sc = r["flat"]
    assert_well_formed(sc)
    ce = sc["areas"]["corners_edges"]
    assert ce["level"] == "medium"
    assert "top-right corner" in ce["blocked"]
    assert all("top-right" in b or "top edge" in b or "right edge" in b for b in ce["blocked"])
    assert "glare obscures the top-right corner" in sc["summary"]
    assert sc["summary"].startswith("Clear outline")
    assert any(a["id"] == "retake" for a in sc["actions"])
    assert sc["level"] == "medium"


def test_unread_borders_are_not_covered_rather_than_low(photos):
    forced = photos["unread_forced"]["flat"]
    assert forced["areas"]["centering"]["level"] == "cannot_assess"
    assert "centering" in forced["notCovered"] and "centering" not in forced["covered"]
    assert forced["level"] == "medium"  # the same as the clean photo: missing evidence isn't "low"
    assert "centering can't be measured" in forced["summary"]
    full_art = photos["borderless"]["flat"]
    assert_well_formed(full_art)
    assert full_art["areas"]["centering"]["level"] == "cannot_assess"
    assert "centering" in full_art["notCovered"] and "centering" not in full_art["covered"]
    # the overall level comes only from the areas it covers (the unread centering doesn't drag it down)
    order = ["cannot_assess", "low", "medium", "high"]
    covered = [full_art["areas"][a]["level"] for a in full_art["covered"]]
    if covered:
        assert order.index(full_art["level"]) <= order.index(min(covered, key=order.index))


def test_outline_correction_recomputes(photos):
    adj = photos["adjusted"]
    sc = adj["flat"]
    assert adj["quality"]["checks"]["detection"] == "ok"
    assert sc["areas"]["outline"]["level"] == "high"
    assert sc["areas"]["outline"]["adjusted"] is True
    assert sc["summary"].startswith("Outline set by hand")


def test_filters_cannot_change_confidence(photos):
    for name, r in photos.items():
        assert r["withFilterKey"] == r["flat"], name
        assert r["afterFilter"] == r["flat"], name


def test_no_numbers_anywhere_on_real_photos(photos):
    for r in photos.values():
        for key in ("flat", "angled"):
            assert_well_formed(r[key])


# ---------------------------------------------------------------- rules on hand-made inputs


def test_hard_fail_rules(pure):
    assert pure["detFail"]["level"] == "cannot_assess" and "R_OUTLINE" in pure["detFail"]["rules"]
    assert any(a["id"] == "adjust_outline" for a in pure["detFail"]["actions"])
    assert pure["cutOff"]["level"] == "cannot_assess" and pure["cutOff"]["summary"].startswith("Card outline not usable")
    assert pure["lowRes"]["areas"]["corners_edges"]["level"] == "cannot_assess"
    assert pure["lowRes"]["areas"]["surface_visibility"]["level"] == "cannot_assess"
    assert pure["lowRes"]["level"] == "low"
    # the edge/corner check not having run is "not covered", not a photo failure
    assert pure["noCheck"]["areas"]["corners_edges"]["level"] == "cannot_assess"
    assert pure["noCheck"]["level"] == "medium" and "R_CE_FAIL" not in pure["noCheck"]["rules"]
    assert pure["whiteBorder"]["areas"]["corners_edges"]["level"] == "low"


def test_outline_adjustment_lifts_detector_doubt(pure):
    assert pure["detWarn"]["areas"]["outline"]["level"] == "medium"
    assert any(a["id"] == "adjust_outline" for a in pure["detWarn"]["actions"])
    adj = pure["detWarnAdjusted"]
    assert adj["areas"]["outline"]["level"] == "high" and adj["areas"]["outline"]["adjusted"] is True
    assert not any(a["id"] == "adjust_outline" for a in adj["actions"])


def test_flat_photo_surface_limit(pure):
    clean, angled = pure["clean"], pure["angled"]
    assert clean["surfaceLimited"] and clean["level"] == "medium"
    assert clean["areas"]["surface_visibility"]["level"] == "low"
    assert "angled light" in clean["areas"]["surface_visibility"]["reason"]
    assert not angled["surfaceLimited"] and angled["level"] == "high"
    assert pure["sleeve"]["areas"]["corners_edges"]["level"] == "medium"
    assert "sleeve" in pure["sleeve"]["summary"]


def test_centering_evidence(pure):
    assert pure["unreadBoth"]["areas"]["centering"]["level"] == "cannot_assess"
    tb = pure["unreadTb"]["areas"]["centering"]
    assert tb["level"] == "high" and tb["unread"] == ["tb"]
    assert "top/bottom centering not read" in pure["unreadTb"]["summary"]
    assert "typed in" in pure["typed"]["areas"]["centering"]["reason"]
    assert pure["missingEvidence"]["areas"]["centering"]["level"] == "cannot_assess"
    assert pure["faint"]["areas"]["centering"]["level"] == "low"
    assert any(a["id"] == "adjust_outline" for a in pure["faint"]["actions"])


def test_missing_back_and_combine(pure):
    m = pure["combineMissingBack"]
    assert m["missing"] == ["back"] and m["level"] == pure["clean"]["level"]
    assert any("Back not scanned" in r for r in m["reasons"]) and "back not scanned" in m["summary"]
    assert pure["combineNullBack"] == m
    weak = pure["combineWeakBack"]
    assert weak["level"] == "cannot_assess" and weak["missing"] == []  # the weaker side, never an average
    assert pure["combineBothHigh"]["level"] == "high"
    assert pure["combineNone"]["level"] == "not_scanned" and pure["combineNone"]["missing"] == ["front", "back"]
    assert pure["combinePending"]["level"] == "high" and pure["combinePending"]["pending"] == ["back"]
    assert pure["combineOnlyAssessing"]["level"] == "assessing" and pure["combineOnlyAssessing"]["missing"] == ["back"]
    for key in ("combineMissingBack", "combineWeakBack", "combineNone", "combinePending"):
        assert pure[key]["label"] in LABELS
        assert all("%" not in r for r in pure[key]["reasons"])


def test_placeholders_and_tables(pure):
    assert pure["notScanned"]["level"] == "not_scanned" and pure["notScanned"]["label"] == "Not scanned"
    assert pure["assessing"]["level"] == "assessing" and pure["assessing"]["label"] == "Assessing scan…"
    assert set(pure["LEVELS"]) == LEVELS and set(pure["LEVELS"].values()) == LABELS
    assert {"axisHigh", "axisMedium", "ceMediumMax", "ceLowMax", "status", "flatCap", "failCap"} <= set(pure["T"])
    assert {"R_OUTLINE", "R_NOTHING", "R_WEAKEST", "R_CE_FAIL", "R_SURFACE_FAIL", "R_FLAT"} <= set(pure["RULES"])
    for key in ("clean", "angled", "detWarn", "detFail", "cutOff", "lowRes", "noCheck", "unreadBoth", "unreadTb", "faint", "sleeve", "whiteBorder", "notScanned", "assessing"):
        assert_well_formed(pure[key])
