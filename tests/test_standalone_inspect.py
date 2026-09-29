"""The standalone photo-quality gate and edge / corner wear candidates (standalone/src/inspect.js)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest
import yaml

from synthetic import (
    H,
    W,
    add_edge_lines,
    card_mask_worn,
    make_card,
    paint_corner_whitening,
    paint_edge_whitening,
    place_on_background,
)

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

SEV_RANK = {"micro": 1, "minor": 2, "moderate": 3, "major": 4}
NAVY, YELLOW, WHITE = (90, 45, 20), (40, 205, 245), (245, 245, 245)

SCRIPT = """
const V = require(%s), I = require(%s), fs = require("fs");
const jobs = JSON.parse(fs.readFileSync(0, "utf8"));
const out = jobs.map((j) => {
  const img = { width: j.width, height: j.height, data: new Uint8ClampedArray(fs.readFileSync(j.path)) };
  const s = V.scan(img, j.mode);
  const t0 = Date.now();
  const q = I.quality(img, s);
  const opts = { quality: q, face: "back" };
  if (j.mask_rect) {  // mark a rectangle of the flattened card as printed light (a reference-image mask)
    const [x0, y0, w, h] = j.mask_rect, m = new Uint8Array(s.width * s.height);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) m[y * s.width + x] = 1;
    opts.printedMask = m;
  }
  const e = I.edgesAndCorners(s, opts);
  const ms = Date.now() - t0;
  if (j.warped) fs.writeFileSync(j.warped, Buffer.from(s.warped.data.buffer));
  return { q, e, ms, width: s.width, height: s.height, margin: s.margin };
});
process.stdout.write(JSON.stringify(out));
"""


def run(images: list, tmp_path: Path, keep_warped: bool = False) -> list[dict]:
    """images: (bgr, mode) or (bgr, mode, extra job fields). Runs Vision.scan, Inspect.quality and Inspect.edgesAndCorners."""
    jobs = []
    for i, item in enumerate(images):
        bgr, mode = item[0], item[1]
        path = tmp_path / f"img{i}.rgba"
        path.write_bytes(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGBA).tobytes())
        job = {"path": str(path), "width": bgr.shape[1], "height": bgr.shape[0], "mode": mode}
        if keep_warped:
            job["warped"] = str(path) + ".warped"
        if len(item) > 2:
            job.update(item[2])
        jobs.append(job)
    script = SCRIPT % (json.dumps(str(ROOT / "standalone/src/vision.js")), json.dumps(str(ROOT / "standalone/src/inspect.js")))
    res = subprocess.run([NODE, "-e", script], input=json.dumps(jobs), capture_output=True, text=True, check=True)
    out = json.loads(res.stdout)
    for job, r in zip(jobs, out):
        if keep_warped:
            r["warped"] = np.frombuffer(Path(job["warped"]).read_bytes(), np.uint8).reshape(r["height"], r["width"], 4)
    return out


def likely_edges(e: dict, side: str | None = None) -> list[dict]:
    return [x for x in e["edges"] if x["likely"] and (side is None or x["side"] == side)]


def corner(e: dict, loc: str) -> dict:
    return next(c for c in e["corners"] if c["location"] == loc)


@pytest.fixture(scope="module")
def clean_photo():
    return place_on_background(make_card(40, 31, 44, 47, border_bgr=YELLOW), 3)


# ---------------------------------------------------------------- quality gate


def test_quality_passes_clean_photos(tmp_path, clean_photo):
    navy = place_on_background(make_card(33, 36, 30, 31, border_bgr=NAVY, frame_bgr=(40, 220, 240)), -2)
    for r in run([(clean_photo, "auto"), (navy, "auto")], tmp_path):
        q = r["q"]
        assert q["verdict"] == "ok", q["checks"]
        assert q["blocked"] == []
        assert all(c["status"] == "ok" and c["note"] for c in q["checks"].values())
        assert r["ms"] < 2000  # quality + edgesAndCorners on the 846 x 1144 flattened card


def test_quality_flags_blurred_photo(tmp_path, clean_photo):
    soft, blurred = run([(cv2.GaussianBlur(clean_photo, (0, 0), 2), "auto"), (cv2.GaussianBlur(clean_photo, (0, 0), 3), "auto")], tmp_path)
    assert soft["q"]["checks"]["sharpness"]["status"] == "warn"
    q = blurred["q"]
    assert q["checks"]["sharpness"]["status"] == "fail"
    assert q["verdict"] == "rescan"
    assert "edges:top" in q["blocked"] and "corners:top_left" in q["blocked"]
    assert "focus" in q["checks"]["sharpness"]["note"]


def test_quality_flags_glare_over_an_edge(tmp_path, clean_photo):
    img = clean_photo.copy()
    bh, bw = img.shape[:2]
    # a blown-out highlight crossing the card's top edge, left of centre
    cv2.ellipse(img, (int(bw / 2 - 120), int(bh / 2 - H / 2 + 4)), (110, 22), 0, 0, 360, (255, 255, 255), -1)
    [r] = run([(img, "auto")], tmp_path)
    q = r["q"]
    assert q["checks"]["glare"]["status"] != "ok"
    assert q["checks"]["glare"]["where"]["top"] > 0.02
    assert "edges:top" in q["blocked"]
    assert "edges:bottom" not in q["blocked"]
    assert "top edge" in q["checks"]["glare"]["note"] and "light" in q["checks"]["glare"]["note"]
    assert any(o["kind"] == "glare" for o in q["overlays"])
    # the edge check still runs but says why that edge isn't trusted
    assert r["e"]["sides"]["top"]["assessable"] is False
    assert not likely_edges(r["e"], "top")


def test_quality_flags_low_resolution(tmp_path, clean_photo):
    tiny, small = run([(cv2.resize(clean_photo, None, fx=0.4, fy=0.4, interpolation=cv2.INTER_AREA), "auto"),
                       (cv2.resize(clean_photo, None, fx=0.7, fy=0.7, interpolation=cv2.INTER_AREA), "auto")], tmp_path)
    assert tiny["q"]["checks"]["resolution"]["status"] == "fail"
    assert tiny["q"]["verdict"] == "rescan"
    assert small["q"]["checks"]["resolution"]["status"] == "warn"
    assert 480 < small["q"]["checks"]["resolution"]["value"] < 560
    for r in (tiny, small):
        assert {f"edges:{s}" for s in ("top", "right", "bottom", "left")} <= set(r["q"]["blocked"])
        assert "closer" in r["q"]["checks"]["resolution"]["note"]


def test_quality_flags_cut_off_card(tmp_path, clean_photo):
    bh, bw = clean_photo.shape[:2]
    bottom_cut = clean_photo[: int(bh / 2 + H * 0.35)]      # no card outline can be found
    side_cut = clean_photo[:, : int(bw / 2 + W * 0.3)]      # the detector settles on a wrong, smaller outline
    for r in run([(bottom_cut, "auto"), (side_cut, "auto")], tmp_path):
        q = r["q"]
        assert q["verdict"] == "rescan", q["checks"]
        assert q["checks"]["boundary"]["status"] == "fail"
        assert "whole card" in q["checks"]["boundary"]["note"]
        assert "centering" in q["blocked"]


def test_quality_sleeve_and_cropped_scan(tmp_path):
    from synthetic import place_in_clutter

    card = make_card(33, 36, 30, 31, border_bgr=NAVY, frame_bgr=(40, 220, 240))
    sleeved, cropped = run([(place_in_clutter(card, 1, sleeve_pad=(70, 80), sleeve_light=45), "auto"), (card, "cropped")], tmp_path)
    assert sleeved["q"]["checks"]["sleeve"]["status"] == "warn"
    assert "sleeve" in sleeved["q"]["checks"]["sleeve"]["note"]
    assert any("Sleeve, top-loader or graded slab" in s for s in sleeved["e"]["limitations"])
    assert "graded slab: edges and corners are seen through plastic" in sleeved["q"]["checks"]["sleeve"]["note"]
    assert cropped["q"]["checks"]["boundary"]["status"] == "warn"
    assert "cropped" in cropped["q"]["checks"]["boundary"]["note"]


# ---------------------------------------------------------------- edges and corners


def test_finds_painted_edge_whitening(tmp_path):
    navy = make_card(33, 36, 30, 31, border_bgr=NAVY, frame_bgr=(40, 220, 240))
    worn = paint_edge_whitening(navy, "top", 200, 60, 6, seed=1)       # 5 mm long
    worn = paint_edge_whitening(worn, "bottom", 300, 200, 9, seed=3)   # 17 mm long, deeper
    worn = paint_edge_whitening(worn, "left", 500, 12, 3, seed=2)      # 1 mm speck
    yellow = paint_edge_whitening(make_card(40, 31, 44, 47, border_bgr=YELLOW), "right", 400, 40, 5, seed=4)
    rn, ry = run([(place_on_background(worn, 2), "auto"), (place_on_background(yellow, -3), "auto")], tmp_path)

    painted = {"top": (200, 260, W), "bottom": (300, 500, W), "left": (500, 512, H)}
    found = {}
    for side, (s, e, length) in painted.items():
        runs = likely_edges(rn["e"], side)
        assert len(runs) == 1, (side, rn["e"]["edges"])
        run_ = runs[0]
        assert abs(run_["start_px"] - s) <= 6 and abs(run_["end_px"] - e) <= 6, run_
        assert abs(run_["start"] - s / length) <= 0.01
        assert run_["type"] == "edge_whitening"
        found[side] = run_
    assert not likely_edges(rn["e"], "right")
    # longer / deeper whitening ranks as more severe
    assert SEV_RANK[found["bottom"]["severity"]] > SEV_RANK[found["top"]["severity"]] > SEV_RANK[found["left"]["severity"]]
    assert found["bottom"]["depth"] > found["left"]["depth"]

    # yellow border: whitening is mostly a loss of colour, not of lightness
    [r] = likely_edges(ry["e"], "right")
    assert abs(r["start_px"] - 400) <= 6 and abs(r["end_px"] - 440) <= 6
    assert likely_edges(ry["e"]) == [r]

    # DING-shaped candidates, with type keys from the defect catalog
    types = yaml.safe_load((ROOT / "cardgrader/criteria/defects.yaml").read_text())["types"]
    assert {d["location"] for d in rn["e"]["defects"]} == {"top", "bottom", "left"}
    for d in rn["e"]["defects"]:
        assert set(d) == {"side", "location", "type", "severity", "note"}  # exactly the app's DING shape
        assert d["type"] in types and "edges" in types[d["type"]]["applies_to"]
        assert d["side"] == "back" and d["severity"] in SEV_RANK and d["note"]
    rects = [o for o in rn["e"]["overlays"] if o["kind"] == "edge" and o["likely"]]
    assert len(rects) == 3
    top = next(o for o in rects if o["label"].startswith("top"))
    assert abs(top["x"] - (rn["margin"] + 200)) <= 6 and top["y"] <= rn["margin"] + 2
    assert "Possible edge whitening" in rn["e"]["summary"]


def test_slab_rail_line_is_not_whitening(tmp_path):
    """A bright line hugging the card's left and right edges (a slab's inner rail, on a dark background) used to
    read as 70+ mm of "major" whitening. It is reported as a greyed-out reflection, and real whitening painted
    under it, and elsewhere on the card, is still found."""
    navy = make_card(33, 36, 30, 31, border_bgr=NAVY, frame_bgr=(40, 220, 240))
    worn = paint_edge_whitening(paint_edge_whitening(navy, "left", 500, 60, 6, seed=2), "top", 200, 60, 6, seed=1)
    photos = [(add_edge_lines(place_on_background(worn, 2, bg=8), 2, gap=gap, width=width), "auto") for gap, width in ((0, 2), (1, 3))]
    for r in run(photos, tmp_path):
        e = r["e"]
        rails = [x for x in e["edges"] if x["reflection"]]
        assert {x["side"] for x in rails} == {"left", "right"}
        assert all(not x["likely"] and x["length_mm"] > 60 and "slab rail" in x["note"] for x in rails)
        assert not likely_edges(e, "right") and not likely_edges(e, "bottom")
        [left] = likely_edges(e, "left")  # the painted patch under the line
        assert abs(left["start_px"] - 500) <= 6 and abs(left["end_px"] - 560) <= 6 and "deeper" in left["note"]
        [top] = likely_edges(e, "top")
        assert abs(top["start_px"] - 200) <= 6 and not top["reflection"]
        assert {d["location"] for d in e["defects"]} == {"left", "top"}
        assert "bright line runs along the right and left edges" in e["summary"]


def test_clean_cards_report_nothing_but_never_claim_flawless(tmp_path):
    cards = [make_card(33, 36, 30, 31, border_bgr=NAVY, frame_bgr=(40, 220, 240)), make_card(40, 31, 44, 47, border_bgr=YELLOW)]
    for r in run([(place_on_background(c, a), "auto") for c, a in zip(cards, (2, -4))], tmp_path):
        e = r["e"]
        assert not likely_edges(e)
        assert not [c for c in e["corners"] if c["likely"]]
        assert e["defects"] == []
        assert all(s["assessable"] for s in e["sides"].values())
        assert "No edge whitening detected above threshold on assessable edges (top, right, bottom, left)" in e["summary"]
        assert "No corner wear detected above threshold" in e["summary"]
        assert any("angled lighting" in s for s in e["limitations"])


def test_white_border_is_not_assessable(tmp_path):
    card = paint_edge_whitening(make_card(40, 31, 44, 47, border_bgr=WHITE), "top", 200, 60, 6)
    [r] = run([(place_on_background(card, 3), "auto")], tmp_path)
    e = r["e"]
    for side in ("top", "right", "bottom", "left"):
        assert e["sides"][side] == {**e["sides"][side], "assessable": False, "reason": "white border"}
    assert e["edges"] == [] and e["defects"] == []
    assert "none were assessable" in e["summary"] and "top edge (white border)" in e["summary"]
    assert any("top edge not assessed: white border" in s for s in e["limitations"])
    assert all(c["whitening"] is None for c in e["corners"])  # can't tell white stock from a white border


def test_finds_corner_whitening_and_rounding(tmp_path):
    navy = make_card(33, 36, 30, 31, border_bgr=NAVY, frame_bgr=(40, 220, 240))
    card = paint_corner_whitening(navy, "top_right", depth=7)
    [r] = run([(place_on_background(card, 2, mask=card_mask_worn(36, {"bottom_left": 70})), "auto")], tmp_path)
    e = r["e"]
    tr, bl = corner(e, "top_right"), corner(e, "bottom_left")
    assert tr["likely"] and tr["whitening"]["severity"] and tr["whitening"]["fraction"] > 0.7
    assert not tr["rounding"]["severity"]
    assert bl["likely"] and bl["rounding"]["severity"] in ("moderate", "major")
    assert 60 < bl["rounding"]["radius_px"] < 80
    for loc in ("top_left", "bottom_right"):
        assert corner(e, loc)["severity"] is None
        assert abs(corner(e, loc)["rounding"]["radius_px"] - 36) < 4
    kinds = {(d["location"], d["type"]) for d in e["defects"]}
    assert kinds == {("top_right", "corner_whitening"), ("bottom_left", "corner_softening")}
    assert tr["dings"] == [d for d in e["defects"] if d["location"] == "top_right"]
    polys = [o for o in e["overlays"] if o["kind"] == "corner"]
    assert len(polys) == 2 and all(len(o["points"]) >= 5 for o in polys)
    assert "Possible corner wear" in e["summary"]


def test_corner_rounding_is_judged_against_the_cards_own_corners(tmp_path):
    """Photos through slab plastic read every corner a little rounder than a new card's 3.02 mm (median 3.5 mm
    in the blind test). Four corners that read alike at 3.7 mm are not softening; one clearly rounder than the
    other three is, and so are four that are all far rounder than a new corner."""
    navy = make_card(33, 36, 30, 31, border_bgr=NAVY, frame_bgr=(40, 220, 240))
    locs = ("top_left", "top_right", "bottom_right", "bottom_left")
    alike = card_mask_worn(36, {loc: 44 for loc in locs})
    one = card_mask_worn(36, {**{loc: 44 for loc in locs}, "bottom_left": 70})
    worn = card_mask_worn(36, {loc: 72 for loc in locs})
    ra, ro, rw = run([(place_on_background(navy, 2, mask=m), "auto") for m in (alike, one, worn)], tmp_path)
    for loc in locs:
        c = corner(ra["e"], loc)
        assert 40 < c["rounding"]["radius_px"] < 48 and c["rounding"]["severity"] is None
    assert not [d for d in ra["e"]["defects"] if d["type"] == "corner_softening"]
    bl = corner(ro["e"], "bottom_left")
    assert bl["likely"] and bl["rounding"]["severity"] in ("moderate", "major")
    assert "rounder than the card's other corners" in bl["note"]
    assert {d["location"] for d in ro["e"]["defects"] if d["type"] == "corner_softening"} == {"bottom_left"}
    assert {d["location"] for d in rw["e"]["defects"] if d["type"] == "corner_softening"} == set(locs)


def test_printed_mask_suppresses_candidates(tmp_path):
    navy = make_card(33, 36, 30, 31, border_bgr=NAVY, frame_bgr=(40, 220, 240))
    photo = place_on_background(paint_edge_whitening(navy, "top", 200, 60, 6, seed=1), 2)
    m = 48  # Vision's margin: the top edge is at y = 48 in the flattened card
    plain, masked = run([(photo, "auto"), (photo, "auto", {"mask_rect": [m + 150, m - 4, 160, 30]})], tmp_path)
    assert likely_edges(plain["e"], "top")
    assert not [x for x in masked["e"]["edges"] if x["side"] == "top"]
    assert not any("No reference image" in s for s in masked["e"]["limitations"])


# ---------------------------------------------------------------- real photos (print only)

PHOTOS = os.environ.get("CARD_PHOTOS_DIR")
COLORS = {"micro": (0, 220, 255), "minor": (0, 160, 255), "moderate": (0, 80, 255), "major": (0, 0, 255)}


def draw_overlays(warped_rgba: np.ndarray, overlays: list[dict]) -> np.ndarray:
    vis = cv2.cvtColor(warped_rgba, cv2.COLOR_RGBA2BGR).copy()
    for o in overlays:
        col = (255, 0, 255) if o["kind"] == "glare" else (150, 150, 150) if o["kind"] == "unassessable" or not o.get("likely") else COLORS[o["severity"]]
        if o["type"] == "rect":
            x, y, w, h = (int(round(o[k])) for k in "xywh")
            cv2.rectangle(vis, (x - 3, y - 3), (x + w + 3, y + h + 3), col, 2)
            cv2.putText(vis, o["label"], (x + 4, y - 6 if y > 100 else y + h + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1)
        else:
            pts = np.array(o["points"], np.int32)
            cv2.polylines(vis, [pts], False, col, 3)
            cv2.putText(vis, o["label"], tuple(int(v) for v in pts[len(pts) // 2]), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1)
    return vis


@pytest.mark.skipif(not PHOTOS, reason="set CARD_PHOTOS_DIR to a folder of real card photos (*.jpg)")
def test_real_photos_print_results(tmp_path):
    """Runs on real phone photos and prints what it finds; asserts only that it runs. Overlays are saved to
    CARD_OVERLAY_DIR (default: the pytest temp dir)."""
    out_dir = Path(os.environ.get("CARD_OVERLAY_DIR", tmp_path))
    paths = sorted(Path(PHOTOS).glob("*.jpg"))
    images = []
    for p in paths:
        img = cv2.imread(str(p))
        s = min(1, 2400 / max(img.shape[:2]))  # the app downscales photos to 2400 px
        images.append((cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA), "auto"))
    for p, r in zip(paths, run(images, tmp_path, keep_warped=True)):
        q, e = r["q"], r["e"]
        print(f"\n== {p.name}: verdict {q['verdict']}, blocked {q['blocked']} ({r['ms']} ms)")
        for name, c in q["checks"].items():
            print(f"  {name:12s} {c['status']:5s} {c['value']!s:8s} {c['note']}")
        for x in e["edges"]:
            print(f"  edge   {x['side']:6s} {x['start']:.3f}-{x['end']:.3f} {x['severity']:8s} conf {x['confidence']:.2f}  {x['note']}")
        for c in e["corners"]:
            print(f"  corner {c['location']:12s} {c['severity']!s:8s} conf {c['confidence']:.2f}  {c['note']}")
        print("  summary:", e["summary"])
        print("  limitations:", *e["limitations"], sep="\n    ")
        cv2.imwrite(str(out_dir / f"{p.stem}_inspect.jpg"), draw_overlays(r["warped"], q["overlays"] + e["overlays"]))
        assert q["verdict"] in ("ok", "warn", "rescan")
