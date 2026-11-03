"""Surface preview filters, reference alignment and EXPERIMENTAL surface-mark candidates (standalone/src/surface.js).

Synthetic cards only. These tests pin behaviour on drawn marks and on synthetic hard cases; they say nothing about
precision or recall on real photos, which is unmeasured."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest
import yaml

from synthetic import H, W, add_sparkle, make_card, place_on_background

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

YELLOW = (40, 205, 245)
SURFACE_TYPES = {k for k, v in yaml.safe_load((ROOT / "cardgrader/criteria/defects.yaml").read_text())["types"].items() if "surface" in v["applies_to"]}

# Scan each photo, run the quality gate and edge/corner check, then findMarks with the job's options.
SCRIPT = """
const V = require(%(vision)s), I = require(%(inspect)s), S = require(%(surface)s), fs = require("fs");
const jobs = JSON.parse(fs.readFileSync(0, "utf8"));
const load = (j) => ({ width: j.width, height: j.height, data: new Uint8ClampedArray(fs.readFileSync(j.path)) });
const out = jobs.map((j) => {
  const img = load(j);
  const scan = V.scan(img, "auto");
  const quality = I.quality(img, scan);
  const check = I.edgesAndCorners(scan, { quality });
  const runs = (j.variants || [{}]).map((v) => {
    const o = { quality, check, side: "front", revision: 3, ...v };
    if (v.fakeOverlay) o.check = { ...check, overlays: [...check.overlays, v.fakeOverlay] };
    if (v.maskRect) {  // printedMask over a rectangle of the card (normalized), in warp pixels
      const [x, y, w, h] = v.maskRect, m = new Uint8Array(scan.width * scan.height), cw = scan.width - 2 * scan.margin, ch = scan.height - 2 * scan.margin;
      for (let yy = Math.floor(scan.margin + y * ch); yy < scan.margin + (y + h) * ch; yy++) for (let xx = Math.floor(scan.margin + x * cw); xx < scan.margin + (x + w) * cw; xx++) m[yy * scan.width + xx] = 1;
      o.printedMask = m;
    }
    if (v.referencePath) {
      const ref = load(v.referencePath);
      const c = S.compareReference(scan.warped, scan.margin, ref);
      o.reference = c;
    }
    delete o.fakeOverlay; delete o.maskRect; delete o.referencePath;
    const before = Buffer.from(scan.warped.data.buffer).toString("base64").length;
    const r = S.findMarks(scan, o);
    if (v.filterBetween) { S.filter(scan.warped, { kind: "contrast", intensity: 1 }); r.again = S.findMarks(scan, o); }
    return r;
  });
  return { runs, margin: scan.margin, width: scan.width, height: scan.height, quality: { verdict: quality.verdict, blocked: quality.blocked } };
});
process.stdout.write(JSON.stringify(out));
"""

FILTERS = """
const S = require(%(surface)s);
const src = { width: 2, height: 2, data: new Uint8ClampedArray([10, 20, 30, 255, 200, 100, 50, 255, 0, 0, 0, 128, 255, 255, 255, 255]) };
const copy = Uint8ClampedArray.from(src.data);
const r = {};
for (const kind of ["original", "grayscale", "red", "green", "blue", "invert"]) { const o = S.filter(src, { kind }); r[kind] = { w: o.width, h: o.height, d: Array.from(o.data), same: o.data === src.data }; }
r.contrast0 = Array.from(S.filter(src, { kind: "contrast", intensity: 0 }).data);
// a step: local contrast pushes the two sides apart, more with more intensity, and reuses a cache
const step = { width: 40, height: 8, data: new Uint8ClampedArray(40 * 8 * 4) };
for (let y = 0; y < 8; y++) for (let x = 0; x < 40; x++) { const p = (y * 40 + x) * 4; const v = x < 20 ? 100 : 120; step.data[p] = step.data[p + 1] = step.data[p + 2] = v; step.data[p + 3] = 255; }
const cache = {};
const half = S.filter(step, { kind: "contrast", intensity: 0.5 }, cache), full = S.filter(step, { kind: "contrast", intensity: 1 }, cache);
const at = (img, x) => img.data[(4 * 40 + x) * 4];
r.step = { half: [at(half, 18), at(half, 21)], full: [at(full, 18), at(full, 21)], cacheKeys: Object.keys(cache).length };
r.diffNoRef = S.filter(src, { kind: "difference" });
r.diffBadRef = S.filter(src, { kind: "difference", reference: { ok: false, reason: "no match" } });
r.diffSizeRef = S.filter(src, { kind: "difference", reference: { width: 3, height: 3, data: new Uint8ClampedArray(36) } });
const ref = { width: 2, height: 2, data: new Uint8ClampedArray([0, 20, 40, 255, 200, 100, 50, 255, 0, 0, 0, 255, 250, 255, 255, 255]) };
r.diff0 = Array.from(S.filter(src, { kind: "difference", intensity: 0, reference: ref }).data);
r.diff1 = Array.from(S.filter(src, { kind: "difference", intensity: 1, reference: { ok: true, aligned: ref } }).data);
try { S.filter(src, { kind: "sepia" }); r.unknown = "no error"; } catch (e) { r.unknown = e.message; }
try { S.filter({ width: 2, height: 2, data: new Uint8ClampedArray(3) }, { kind: "invert" }); r.bad = "no error"; } catch (e) { r.bad = e.message; }
r.unchanged = Array.from(src.data).every((v, i) => v === copy[i]);
process.stdout.write(JSON.stringify(r));
"""

REFERENCE = """
const V = require(%(vision)s), S = require(%(surface)s), fs = require("fs");
const job = JSON.parse(fs.readFileSync(0, "utf8"));
const load = (j) => ({ width: j.width, height: j.height, data: new Uint8ClampedArray(fs.readFileSync(j.path)) });
const scan = V.scan(load(job.photo), "auto");
const out = {};
for (const r of job.refs) {
  const c = S.compareReference(scan.warped, scan.margin, load(r));
  const o = { ok: c.ok, reason: c.reason, correlation: c.correlation, shift: c.shift, exposure: c.exposure, coverage: c.coverage, aligned: !!c.aligned };
  if (c.ok) {
    const d = S.filter(scan.warped, { kind: "difference", intensity: 0, reference: c });
    // mean difference over the card, and at the scratch drawn only on the photo
    const cw = scan.width - 2 * scan.margin, ch = scan.height - 2 * scan.margin;
    let s = 0, n = 0;
    for (let y = scan.margin; y < scan.height - scan.margin; y += 3) for (let x = scan.margin; x < scan.width - scan.margin; x += 3) { const p = (y * scan.width + x) * 4; s += (d.data[p] + d.data[p + 1] + d.data[p + 2]) / 3; n++; }
    o.meanDiff = s / n;
    const [sx, sy] = job.scratchAt, p = ((scan.margin + Math.round(sy * ch)) * scan.width + scan.margin + Math.round(sx * cw)) * 4;
    let best = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const q = p + (dy * scan.width + dx) * 4; best = Math.max(best, (d.data[q] + d.data[q + 1] + d.data[q + 2]) / 3); }
    o.scratchDiff = best;
  }
  out[r.name] = o;
}
process.stdout.write(JSON.stringify(out));
"""


def _paths() -> dict:
    return {k: json.dumps(str(SRC / f)) for k, f in (("vision", "vision.js"), ("inspect", "inspect.js"), ("surface", "surface.js"))}


def _dump(tmp: Path, name: str, bgr: np.ndarray) -> dict:
    path = tmp / f"{name}.rgba"
    path.write_bytes(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGBA).tobytes())
    return {"name": name, "path": str(path), "width": bgr.shape[1], "height": bgr.shape[0]}


def run_marks(cases: dict, tmp: Path) -> dict:
    """cases: name -> photo or (photo, [variant opts...]). Returns name -> {runs: [findMarks result...], ...}."""
    jobs = []
    for name, item in cases.items():
        photo, variants = item if isinstance(item, tuple) else (item, [{}])
        jobs.append({**_dump(tmp, name, photo), "variants": variants})
    res = subprocess.run([NODE, "-e", SCRIPT % _paths()], input=json.dumps(jobs), capture_output=True, text=True, check=True)
    return dict(zip(cases, json.loads(res.stdout)))


def jpeg(img: np.ndarray, q: int) -> np.ndarray:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])
    assert ok
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


# Card-pixel positions of the drawn marks (the card is 750 x 1048; normalized = px / size).
SCRATCH = ((250, 400), (420, 470))          # light 2 px line across the artwork, ~16 mm
BORDER_SPOT = (20, 600)                       # dark dot on the left border
ART_SPOT = (560, 820)                         # dark dot in a plain patch of the artwork
PLAIN_PATCH = ((500, 760), (620, 880))


def base_card():
    card = make_card(40, 31, 44, 47, border_bgr=YELLOW)
    cv2.rectangle(card, *PLAIN_PATCH, (70, 60, 150), -1)  # a plain stretch of the artwork's background colour
    return card


def marked_card():
    card = base_card()
    cv2.line(card, *SCRATCH, (225, 225, 225), 2)
    cv2.circle(card, BORDER_SPOT, 4, (30, 30, 30), -1)
    cv2.circle(card, ART_SPOT, 3, (20, 20, 20), -1)
    return card


def inside(c: dict, x: float, y: float, pad: float = 0.01) -> bool:
    return c["x"] - pad <= x <= c["x"] + c["w"] + pad and c["y"] - pad <= y <= c["y"] + c["h"] + pad


@pytest.fixture(scope="module")
def results(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("surface")
    base, marked = base_card(), marked_card()
    yy, xx = np.mgrid[0:H, 0:W]
    text = base.copy()
    for k in range(8):
        cv2.putText(text, "Pikachu HP 60 Thunder", (70, 300 + 40 * k), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (20, 20, 20), 2)
    # a soft, wide, bright diagonal band (a sleeve / slab reflection) and a thin straight light streak across the card
    dist = np.abs((xx - yy * 0.6) - 100) / np.hypot(1, 0.6)
    band = np.clip(base.astype(np.float32) + (np.exp(-((dist / 12) ** 2)) * 90)[..., None], 0, 255).astype(np.uint8)
    streak = base.copy()
    cv2.line(streak, (100, 120), (650, 980), (245, 245, 245), 3)
    shadow = (base.astype(np.float32) * (0.55 + 0.45 * (xx / W))[..., None]).astype(np.uint8)
    glare = marked.copy()
    cv2.ellipse(glare, (330, 600), (60, 40), 0, 0, 360, (255, 255, 255), -1)  # big blown-out patch
    cv2.circle(glare, (560, 790), 5, (255, 255, 255), -1)                     # small glare speck in the plain patch
    printed = base.copy()
    cv2.line(printed, (150, 700), (400, 760), (235, 235, 235), 2)            # part of the print: also in the reference
    printed_scratched = printed.copy()
    cv2.line(printed_scratched, *SCRATCH, (225, 225, 225), 2)
    stain = make_card(70, 70, 70, 70, border_bgr=YELLOW)
    cv2.circle(stain, (38, 500), 13, (60, 140, 175), -1)                     # brownish blotch on a wide border
    stain = cv2.GaussianBlur(stain, (0, 0), 1.2)
    ref_path = _dump(tmp, "reference", printed)

    o = place_on_background
    marked_photo = o(marked, 3)
    cases = {
        "marked": (marked_photo, [{}, {"maxCandidates": 1}, {"timeBudgetMs": 0}, {"filterBetween": True},
                                  {"maskRect": [0.3, 0.36, 0.26, 0.1]}, {"analysisMaxSide": 400}]),
        "marked_jpeg": jpeg(marked_photo, 60),
        "clean": o(base, 3),
        "text": o(text, 3),
        "foil": o(add_sparkle(base, n=8000), 3),
        "sleeve_band": o(band, 3),
        "streak": o(streak, 3),
        "shadow": o(shadow, 3),
        "soft": cv2.GaussianBlur(o(base, 3), (0, 0), 1.5),
        "blurry": cv2.GaussianBlur(marked_photo, (0, 0), 3),
        "tiny": cv2.resize(marked_photo, None, fx=0.4, fy=0.4, interpolation=cv2.INTER_AREA),
        "jpeg30": jpeg(o(base, 3), 30),
        "jpeg50": jpeg(o(base, 3), 50),
        "glare": o(glare, 3),
        "printed": (o(printed_scratched, 3), [{}, {"referencePath": ref_path}]),
        "stain": o(stain, 3),
    }
    return run_marks(cases, tmp)


def candidates(results, name, run=0):
    return results[name]["runs"][run]["candidates"]


# ---------------------------------------------------------------- filters


def test_filters_on_a_tiny_image():
    r = json.loads(subprocess.run([NODE, "-e", FILTERS % _paths()], capture_output=True, text=True, check=True).stdout)
    assert r["unchanged"] is True  # nothing mutated the source
    assert r["original"]["d"] == [10, 20, 30, 255, 200, 100, 50, 255, 0, 0, 0, 128, 255, 255, 255, 255]
    assert all(not r[k]["same"] and r[k]["w"] == 2 and r[k]["h"] == 2 for k in ("original", "grayscale", "red", "invert"))
    y0 = round(0.299 * 10 + 0.587 * 20 + 0.114 * 30)
    assert r["grayscale"]["d"][:4] == [y0, y0, y0, 255]
    assert r["red"]["d"][:8] == [10, 10, 10, 255, 200, 200, 200, 255]
    assert r["green"]["d"][:8] == [20, 20, 20, 255, 100, 100, 100, 255]
    assert r["blue"]["d"][:8] == [30, 30, 30, 255, 50, 50, 50, 255]
    assert r["invert"]["d"] == [245, 235, 225, 255, 55, 155, 205, 255, 255, 255, 255, 128, 0, 0, 0, 255]
    assert r["contrast0"] == r["original"]["d"]
    (h18, h21), (f18, f21) = r["step"]["half"], r["step"]["full"]
    assert f18 < h18 < 100 and f21 > h21 > 120  # local contrast widens the step, more at higher intensity
    assert r["step"]["cacheKeys"] >= 3
    for k in ("diffNoRef", "diffBadRef", "diffSizeRef"):
        assert r[k]["unavailable"] is True and r[k]["reason"]
    assert "no match" in r["diffBadRef"]["reason"]
    assert r["diff0"] == [10, 0, 10, 255, 0, 0, 0, 255, 0, 0, 0, 255, 5, 0, 0, 255]
    assert r["diff1"][:4] == [50, 0, 50, 255]  # x (1 + 4 x intensity)
    assert "unknown kind" in r["unknown"] and "malformed" in r["bad"]


# ---------------------------------------------------------------- reference


def test_reference_alignment_and_rejection(tmp_path):
    printed = base_card()
    scratched = printed.copy()
    cv2.line(scratched, *SCRATCH, (225, 225, 225), 2)
    photo = place_on_background(scratched, 3)
    warm = np.clip(printed.astype(np.float32) * [0.8, 0.9, 1.1] + 10, 0, 255).astype(np.uint8)
    refs = [
        _dump(tmp_path, "same", printed),
        _dump(tmp_path, "warm", warm),  # different exposure and white balance
        _dump(tmp_path, "padded", cv2.copyMakeBorder(printed, 50, 50, 60, 60, cv2.BORDER_CONSTANT, value=(255, 255, 255))),
        _dump(tmp_path, "small", cv2.resize(printed, (375, 524), interpolation=cv2.INTER_AREA)),
        _dump(tmp_path, "other_card", make_card(40, 31, 44, 47, border_bgr=YELLOW, seed=7)),
        _dump(tmp_path, "upside_down", cv2.rotate(printed, cv2.ROTATE_180)),
        _dump(tmp_path, "shifted", np.roll(printed, (60, 40), axis=(0, 1))),
        _dump(tmp_path, "landscape", cv2.rotate(printed, cv2.ROTATE_90_CLOCKWISE)),
    ]
    job = {"photo": _dump(tmp_path, "photo", photo), "refs": refs, "scratchAt": [335 / W, 435 / H]}
    r = json.loads(subprocess.run([NODE, "-e", REFERENCE % _paths()], input=json.dumps(job), capture_output=True, text=True, check=True).stdout)
    for name in ("same", "warm", "padded", "small"):
        assert r[name]["ok"], (name, r[name])
        assert r[name]["correlation"] >= 0.9 and r[name]["coverage"] >= 0.95
        assert abs(r[name]["shift"]["dx"]) <= 4 and abs(r[name]["shift"]["dy"]) <= 4
        assert r[name]["meanDiff"] < 12, (name, r[name]["meanDiff"])   # aligned and exposure-matched: little difference ...
        assert r[name]["scratchDiff"] > 60, (name, r[name])             # ... except where the photo has a mark
    assert r["warm"]["exposure"]["gain"][2] > 1.15  # the warm reference's blue was brought back up
    for name in ("other_card", "upside_down", "shifted", "landscape"):
        assert not r[name]["ok"] and not r[name]["aligned"] and r[name]["reason"], name
    assert "card-shaped" in r["landscape"]["reason"]
    assert "doesn't match" in r["other_card"]["reason"]


# ---------------------------------------------------------------- candidates


def test_finds_drawn_scratch_and_spots(results):
    run = results["marked"]["runs"][0]
    assert run["status"] == "ok"
    cands = run["candidates"]
    lines = [c for c in cands if c["kind"] == "line"]
    spots = [c for c in cands if c["kind"] == "spot"]
    mid = ((SCRATCH[0][0] + SCRATCH[1][0]) / 2 / W, (SCRATCH[0][1] + SCRATCH[1][1]) / 2 / H)
    assert len(lines) == 1 and inside(lines[0], *mid), lines
    assert abs(lines[0]["x"] - SCRATCH[0][0] / W) < 0.02 and abs(lines[0]["x"] + lines[0]["w"] - SCRATCH[1][0] / W) < 0.02
    assert 12 < lines[0]["lengthMm"] < 20
    assert set(lines[0]["suggestedTypes"]) == {"surface_scratch", "print_line"}
    assert any(inside(s, BORDER_SPOT[0] / W, BORDER_SPOT[1] / H) for s in spots), spots
    assert any(inside(s, ART_SPOT[0] / W, ART_SPOT[1] / H) for s in spots), spots
    assert len(cands) == 3, cands
    for c in cands:
        assert set(c["suggestedTypes"]) <= SURFACE_TYPES
        assert c["status"] == "pending" and c["side"] == "front" and c["revision"] == 3
        assert c["detection"] in ("low", "medium", "high") and 0 <= c["score"] <= 1
        assert "not a probability" in c["detectionNote"]
        assert c["id"].startswith("front-r3-m") and c["method"] and c["reason"]
        assert all(0 <= c[k] <= 1 for k in ("x", "y", "w", "h"))
    assert "nothing is added to the grade" in run["note"]
    # JPEG-compressed photo: the same three
    assert sorted(c["kind"] for c in candidates(results, "marked_jpeg")) == ["line", "spot", "spot"]


HARD_CASES = ("clean", "text", "foil", "sleeve_band", "streak", "shadow", "soft", "jpeg30", "jpeg50")


def test_hard_cases_give_few_or_no_candidates(results):
    counts = {name: len(candidates(results, name)) for name in HARD_CASES}
    print("\nsurface candidates on synthetic hard cases:", counts)
    print("texture tiles:", {n: results[n]["runs"][0]["stats"].get("textureTiles") for n in HARD_CASES}, {n: [(r["reason"][:12], r["w"], r["h"]) for r in results[n]["runs"][0]["cannotAssess"]] for n in ("foil", "text")})
    print("rejections:", {name: {k: v for k, v in results[name]["runs"][0]["stats"]["rejected"].items() if v} for name in HARD_CASES})
    assert all(n <= 1 for n in counts.values()), counts
    assert sum(counts.values()) == 0, counts
    st = {name: results[name]["runs"][0]["stats"]["rejected"] for name in HARD_CASES}
    assert st["streak"]["reflection"] >= 1                 # the long straight light line was recognised as a reflection
    assert st["foil"]["texture"] > 100                       # sparkle is texture, not marks ...
    foil_ca = results["foil"]["runs"][0]["cannotAssess"]
    assert any("Foil" in r["reason"] for r in foil_ca)       # ... and those areas are reported as not assessable
    assert sum(r["w"] * r["h"] for r in foil_ca if "Foil" in r["reason"]) > 0.2
    assert any("Busy print" in r["reason"] or "Foil" in r["reason"] for r in results["text"]["runs"][0]["cannotAssess"])
    assert results["clean"]["runs"][0]["cannotAssess"] == []
    assert "isn't evidence of a clean surface" in results["clean"]["runs"][0]["note"]


def test_quality_failures_mean_cannot_assess(results):
    for name in ("blurry", "tiny"):
        run = results[name]["runs"][0]
        assert run["status"] == "cannot_assess", (name, results[name]["quality"])
        assert run["candidates"] == [] and run["cannotAssess"][0]["w"] == 1 and run["cannotAssess"][0]["h"] == 1


def test_glare_is_cannot_assess_not_candidates(results):
    run = results["glare"]["runs"][0]
    glare = [r for r in run["cannotAssess"] if r["reason"].startswith("Glare")]
    assert any(inside(r, 330 / W, 600 / H, 0) for r in glare), glare
    assert any(inside(r, 560 / W, 790 / H, 0) for r in glare), glare     # the small speck too
    for c in run["candidates"]:
        assert not inside(c, 330 / W, 600 / H, 0.0) and not inside(c, 560 / W, 790 / H, 0.0), c
    # the marks outside the glare are still found
    assert any(c["kind"] == "line" for c in run["candidates"])


def test_dedupes_against_edge_corner_regions(results, tmp_path):
    base = results["marked"]
    spot = next(c for c in base["runs"][0]["candidates"] if inside(c, BORDER_SPOT[0] / W, BORDER_SPOT[1] / H))
    m, cw, ch = base["margin"], base["width"] - 2 * base["margin"], base["height"] - 2 * base["margin"]
    rect = {"type": "rect", "kind": "edge", "x": m, "y": m + spot["y"] * ch - 5, "w": 12, "h": spot["h"] * ch + 10, "label": "left minor"}
    poly = {"type": "polyline", "kind": "corner", "points": [[m + ART_SPOT[0] * cw / W, m + ART_SPOT[1] * ch / H], [m + ART_SPOT[0] * cw / W + 2, m + ART_SPOT[1] * ch / H + 2]]}
    r = run_marks({"marked": (place_on_background(marked_card(), 3), [{"fakeOverlay": rect}, {"fakeOverlay": poly}])}, tmp_path)["marked"]["runs"]
    for run, gone in ((r[0], BORDER_SPOT), (r[1], ART_SPOT)):
        assert run["stats"]["rejected"]["deduped"] >= 1
        assert not any(inside(c, gone[0] / W, gone[1] / H, 0) for c in run["candidates"])
        assert len(run["candidates"]) == 2


def test_caps_timeout_and_options(results):
    runs = results["marked"]["runs"]
    capped = runs[1]
    assert len(capped["candidates"]) == 1 and capped["stats"]["truncated"] == 2 and "weaker" in capped["note"]
    assert capped["candidates"][0]["score"] == max(c["score"] for c in runs[0]["candidates"])
    timed = runs[2]
    assert timed["status"] == "timeout" and timed["recoverable"] is True
    assert isinstance(timed["candidates"], list) and "partial" in timed["note"]
    # a filter between two runs changes nothing: marks always read the original warp
    again = runs[3].pop("again")
    strip = lambda r: {**r, "stats": {**r["stats"], "elapsedMs": 0}}  # noqa: E731
    assert strip(again) == strip(runs[3]) == strip(runs[0])
    # a printed-mask over the scratch: not offered
    assert not any(c["kind"] == "line" for c in runs[4]["candidates"])
    # a smaller analysis size still finds the scratch, faster
    small = runs[5]
    assert small["stats"]["analysisScale"] < 0.6
    assert any(c["kind"] == "line" for c in small["candidates"])


def test_reference_suppresses_printed_structure(results):
    plain, with_ref = results["printed"]["runs"]
    printed_mid = (275 / W, 730 / H)
    scratch_mid = (335 / W, 435 / H)
    assert any(inside(c, *printed_mid) for c in plain["candidates"])          # without a reference: looks like a mark
    assert not any(inside(c, *printed_mid) for c in with_ref["candidates"])  # with it: it's part of the print
    assert with_ref["stats"]["rejected"]["reference"] >= 1
    assert any(inside(c, *scratch_mid) and c["kind"] == "line" for c in with_ref["candidates"])  # the real mark stays


def test_discoloration_on_the_border(results):
    cands = candidates(results, "stain")
    stains = [c for c in cands if c["kind"] == "discoloration"]
    assert len(stains) == 1, cands
    assert inside(stains[0], 38 / W, 500 / H) and stains[0]["suggestedTypes"] == ["stain"]


def test_deterministic(results, tmp_path):
    again = run_marks({"marked": place_on_background(marked_card(), 3)}, tmp_path)["marked"]["runs"][0]
    first = results["marked"]["runs"][0]
    for r in (first, again):
        r["stats"]["elapsedMs"] = 0
    assert again == first
