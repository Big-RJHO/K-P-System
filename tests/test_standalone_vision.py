"""The standalone (pure JavaScript) centering measurement on synthetic scans and photos."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from synthetic import make_card, place_in_clutter, place_on_background, tilt_photo

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

CASES = [
    ((40, 30, 45, 45), 3, (40, 205, 245)),     # yellow border, L/R off
    ((42, 42, 40, 55), -4, (185, 175, 170)),   # silver border, T/B off
    ((35, 48, 50, 40), 0, (160, 90, 20)),      # blue (back-like) border, both off
    ((45, 45, 46, 46), 7, (40, 205, 245)),     # centered, rotated more
    ((50, 38, 40, 52), -12, (40, 205, 245)),   # strongly rotated
]

SCRIPT = """
const V = require(%s);
const fs = require("fs");
const jobs = JSON.parse(fs.readFileSync(0, "utf8"));
const out = jobs.map((j) => {
  const data = new Uint8ClampedArray(fs.readFileSync(j.path));
  const r = V.scan({ width: j.width, height: j.height, data }, j.mode);
  return { centering: r.centering, confidence: r.confidence, lines: r.lines };
});
process.stdout.write(JSON.stringify(out));
"""


def run(images: list[tuple[np.ndarray, str]], tmp_path: Path) -> list[dict]:
    jobs = []
    for i, (bgr, mode) in enumerate(images):
        rgba = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGBA)
        path = tmp_path / f"img{i}.rgba"
        path.write_bytes(rgba.tobytes())
        jobs.append({"path": str(path), "width": bgr.shape[1], "height": bgr.shape[0], "mode": mode})
    script = SCRIPT % json.dumps(str(ROOT / "standalone" / "src" / "vision.js"))
    res = subprocess.run([NODE, "-e", script], input=json.dumps(jobs), capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def expected(l, r, t, b):
    return max(l, r) / (l + r) * 100, max(t, b) / (t + b) * 100


def test_js_centering_within_one_point(tmp_path):
    images, truth = [], []
    for borders, angle, color in CASES:
        card = make_card(*borders, border_bgr=color)
        images += [(card, "auto"), (place_on_background(card, angle), "auto")]
        truth += [expected(*borders)] * 2
    results = run(images, tmp_path)
    for (lr, tb), res, (_, mode) in zip(truth, results, images):
        got = res["centering"]
        assert abs(got["lr"] - lr) <= 1.0, (lr, tb, res)
        assert abs(got["tb"] - tb) <= 1.0, (lr, tb, res)
        assert res["confidence"]["borders"] > 0.6


def test_js_riftbound_style_cards(tmp_path):
    from test_vision import RIFTBOUND_CASES

    images, truth = [], []
    for borders, angle, color, bg in RIFTBOUND_CASES:
        images.append((place_on_background(make_card(*borders, border_bgr=color), angle, bg=bg), "auto"))
        truth.append(expected(*borders))
    for (lr, tb), res in zip(truth, run(images, tmp_path)):
        assert abs(res["centering"]["lr"] - lr) <= 1.0, (lr, tb, res)
        assert abs(res["centering"]["tb"] - tb) <= 1.0, (lr, tb, res)


def test_js_card_in_sleeve_on_busy_desk(tmp_path):
    """Photos like real phone shots: a sleeved card on a laptop, with keys, a laptop edge and wood grain around it."""
    cards = [
        (make_card(40, 31, 44, 47, border_bgr=(40, 205, 245), frame_bgr=(60, 150, 190)), (40, 31, 44, 47), 2),  # Pokemon-style front
    ]
    images = [(place_in_clutter(card, angle), "auto") for card, _, angle in cards]
    for (card, borders, _), res in zip(cards, run(images, tmp_path)):
        lr, tb = expected(*borders)
        assert abs(res["centering"]["lr"] - lr) <= 1.5, (lr, tb, res["centering"])
        assert abs(res["centering"]["tb"] - tb) <= 1.5, (lr, tb, res["centering"])


def test_js_off_angle_photos(tmp_path):
    """Phone not held square to the card: the card is keystoned in the photo and must come out straight."""
    cases = [((40, 31, 44, 47), (40, 205, 245), 0.05, 1), ((36, 44, 45, 40), (150, 70, 25), 0.07, 2), ((45, 45, 46, 46), (40, 205, 245), 0.06, 4)]
    images, truth = [], []
    for borders, color, amount, seed in cases:
        images.append((tilt_photo(place_on_background(make_card(*borders, border_bgr=color), 2), amount, seed), "auto"))
        truth.append(expected(*borders))
    for (lr, tb), res in zip(truth, run(images, tmp_path)):
        assert abs(res["centering"]["lr"] - lr) <= 1.5, (lr, tb, res["centering"])
        assert abs(res["centering"]["tb"] - tb) <= 1.5, (lr, tb, res["centering"])


def test_js_cropped_mode_and_guides(tmp_path):
    card = make_card(40, 30, 45, 45)
    [res] = run([(card, "cropped")], tmp_path)
    lines = res["lines"]
    assert lines["inner"]["left"] > lines["outer"]["left"]
    assert lines["inner"]["right"] < lines["outer"]["right"]
