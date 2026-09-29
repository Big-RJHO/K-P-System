"""scripts/photo_grade.py: the surface limit of a flat photo, and a grade printout that shows every limit."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import pytest

from synthetic import make_card, place_in_clutter, place_on_background

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/photo_grade.py"
NAVY = (90, 45, 20)
ALL = ["corners", "edges", "surface"]


def photo_grade(*args: str) -> str:
    res = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True, cwd=ROOT)
    assert res.returncode == 0, res.stderr
    return res.stdout


def side_scan(**extra) -> dict:
    """One side of a scan.json as `scan` writes it: a clean, measured photo with the flat-photo surface limit."""
    return {"centering": {"lr": 50.0, "tb": 50.0}, "evidence": {"lr": "measured", "tb": "measured"},
            "quality": "ok", "blocked": [], "blocked_reasons": {}, "warnings": {}, "angled_light": False,
            "photo_limits": ["surface"], "auto_defects": [], "auto_unassessed": {}, **extra}


def grade(tmp_path: Path, sides: dict, obs: dict) -> tuple[str, dict]:
    (tmp_path / "scan.json").write_text(json.dumps({"sides": sides}))
    (tmp_path / "obs.json").write_text(json.dumps(obs))
    out = photo_grade("grade", tmp_path / "scan.json", tmp_path / "obs.json", "--json", tmp_path / "result.json")
    return out, json.loads((tmp_path / "result.json").read_text())


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_scan_limits_the_surface_unless_seen_under_angled_light(tmp_path):
    card = make_card(33, 36, 30, 31, border_bgr=NAVY, frame_bgr=(40, 220, 240))
    cv2.imwrite(str(tmp_path / "front.png"), place_on_background(card, 2))
    cv2.imwrite(str(tmp_path / "back.png"), place_in_clutter(card, 1, sleeve_pad=(70, 80), sleeve_light=45))
    flat = photo_grade("scan", tmp_path / "front.png", tmp_path / "back.png", "--out", tmp_path / "flat")
    angled = photo_grade("scan", tmp_path / "front.png", tmp_path / "back.png", "--out", tmp_path / "angled", "--angled-light")
    assert "surface needs angled light" in flat and "surface needs angled light" not in angled
    flat_scan = json.loads((tmp_path / "flat/scan.json").read_text())["sides"]
    angled_scan = json.loads((tmp_path / "angled/scan.json").read_text())["sides"]
    for side in ("front", "back"):
        assert "surface" in flat_scan[side]["photo_limits"] and flat_scan[side]["angled_light"] is False
        assert "surface" not in angled_scan[side]["photo_limits"] and angled_scan[side]["angled_light"] is True
    # the sleeve warning is kept for `grade`, worded for slabs too
    assert "graded slab: edges and corners are seen through plastic" in flat_scan["back"]["warnings"]["sleeve"]

    # Everything listed as inspected: the flat photo's surface stays unassessed, the angled-light one doesn't.
    (tmp_path / "obs.json").write_text(json.dumps({"inspected": {"front": ALL, "back": ALL}}))
    out = photo_grade("grade", tmp_path / "flat/scan.json", tmp_path / "obs.json")
    assert "INCOMPLETE" in out and "front: surface (surface needs angled light)" in out
    assert "front surface: the photo can't show it (surface needs angled light)" in out
    assert "back photo: The card seems to be in a sleeve, top-loader or graded slab" in out
    out = photo_grade("grade", tmp_path / "angled/scan.json", tmp_path / "obs.json")
    assert "front: none" in out and "surface needs angled light" not in out


def test_surface_claimed_as_inspected_on_a_flat_photo_is_not_a_complete_grade(tmp_path):
    out, res = grade(tmp_path, {"front": side_scan(), "back": side_scan()}, {"inspected": {"front": ALL, "back": ALL}})
    assert res["complete"] is False and res["psa_grade_is_ceiling"] is True
    assert res["photo_limited"] == ["front surface", "back surface"]
    assert "COMPLETE — every area was assessed" not in out
    assert "front: none" not in out and "back: surface (surface needs angled light)" in out
    assert "listed as inspected, but the photo check wins" in out


def test_surface_defects_lower_the_ceiling_and_in_hand_lifts_the_limit(tmp_path):
    scratch = {"side": "back", "location": "surface", "type": "surface_scratch", "severity": "moderate"}
    _, capped = grade(tmp_path, {"front": side_scan(), "back": side_scan()},
                      {"inspected": {"front": ALL, "back": ALL}, "defects": [scratch]})
    assert capped["complete"] is False and capped["psa_grade"] < 10
    out, res = grade(tmp_path, {"front": side_scan(), "back": side_scan()},
                     {"inspected": {"front": ALL, "back": ALL}, "inspected_in_hand": {"front": ["surface"], "back": ["surface"]},
                      "defects": [scratch]})
    assert res["complete"] is True and res["psa_grade"] == capped["psa_grade"]
    assert "back: surface (surface needs angled light) -> checked in hand" in out
    assert "COMPLETE — every area was assessed" in out
    # a scan made with --angled-light has no surface limit
    _, angled = grade(tmp_path, {s: side_scan(angled_light=True, photo_limits=[]) for s in ("front", "back")},
                      {"inspected": {"front": ALL, "back": ALL}})
    assert angled["complete"] is True and angled["photo_limited"] == []


def test_grade_lists_scan_cautions_and_never_calls_a_retake_complete(tmp_path):
    sleeve = "The card seems to be in a sleeve, top-loader or graded slab: edges and corners are seen through plastic."
    back = side_scan(quality="rescan", blocked=["surface", "edges:left"],
                     blocked_reasons={"surface": ["resolution"], "edges:left": ["resolution"]},
                     photo_limits=["edges", "surface"], warnings={"sleeve": sleeve, "resolution": "Card is only 300 px wide."},
                     auto_unassessed={"left edge": "white border"})
    in_hand = {"front": ALL, "back": ALL}
    out, res = grade(tmp_path, {"front": side_scan(warnings={"sleeve": sleeve}), "back": back},
                     {"inspected": in_hand, "inspected_in_hand": in_hand})
    assert res["complete"] is True and res["scan_quality"] == {"front": "ok", "back": "rescan"}
    assert "COMPLETE — every area was assessed" not in out
    assert "COMPLETE ON THE OBSERVATIONS ONLY — the scan said to retake the back photo" in out
    assert "back: edges (resolution) -> checked in hand; surface (surface needs angled light, resolution) -> checked in hand" in out
    assert f"front photo: {sleeve}" in out and f"back photo: {sleeve}" in out
    assert "back photo: the scan's verdict is RETAKE THIS PHOTO" in out
    assert "back: the automatic edge/corner check couldn't judge the left edge (white border)" in out
