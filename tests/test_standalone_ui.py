"""The standalone app's interface, driven offline in a headless browser (tests/ui_harness.js).

Covers: no horizontal overflow at phone widths, scan-confidence states, stale async results being dropped,
de-duplicated card lookups with a deadline, compatibility with old History/backups (and the DINGS -> Defects
wording), possible marks and filters never changing grades, and one end-to-end flow. Nothing leaves the machine:
the harness aborts every network request.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import pytest

from synthetic import make_card, make_swirl_back, place_on_background

ROOT = Path(__file__).resolve().parents[1]
HARNESS = Path(__file__).with_name("ui_harness.js")
NODE = shutil.which("node")


def _node_path() -> str | None:
    if NODE is None:
        return None
    env_path = os.environ.get("NODE_PATH", "")
    try:
        root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True, timeout=60).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        root = ""
    path = os.pathsep.join(p for p in (env_path, root) if p)
    ok = subprocess.run([NODE, "-e", "require.resolve('playwright')"], env={**os.environ, "NODE_PATH": path}, capture_output=True, timeout=60)
    return path if ok.returncode == 0 else None


NODE_PATH = _node_path()
pytestmark = pytest.mark.skipif(NODE_PATH is None, reason="node with playwright is not installed")


@pytest.fixture(scope="module")
def app(tmp_path_factory):
    out = tmp_path_factory.mktemp("ui")
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_standalone.py"), "--single", str(out / "lab.html"), "--site", str(out / "site")],
        check=True, capture_output=True, timeout=600,
    )
    front = place_on_background(make_card(40, 34, 42, 44, seed=1), angle=2.0, seed=1)
    back = place_on_background(make_swirl_back(38, 40, 40, 42, hidden=0.2, seed=2), angle=-1.5, seed=2)
    cv2.imwrite(str(out / "front.jpg"), front, [cv2.IMWRITE_JPEG_QUALITY, 92])
    cv2.imwrite(str(out / "back.jpg"), back, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return out


def run(app: Path, scenario: str) -> dict:
    res = subprocess.run(
        [NODE, str(HARNESS), scenario, str(app / "site" / "index.html"), str(app / "front.jpg"), str(app / "back.jpg")],
        env={**os.environ, "NODE_PATH": NODE_PATH}, capture_output=True, text=True, timeout=900,
    )
    assert res.returncode == 0, res.stderr[-3000:]
    data = json.loads(res.stdout)
    return data


def test_inline_scripts_parse(app, tmp_path):
    for page in (app / "lab.html", app / "site" / "index.html"):
        html = page.read_text(encoding="utf-8")
        scripts = re.findall(r"<script>(.*?)</script>", html, flags=re.S)
        assert len(scripts) >= 10
        for i, code in enumerate(scripts):
            f = tmp_path / f"{page.stem}-{i}.js"
            f.write_text(code, encoding="utf-8")
            res = subprocess.run([NODE, "--check", str(f)], capture_output=True, text=True)
            assert res.returncode == 0, res.stderr
        assert "fonts.googleapis.com" not in html and "fonts.gstatic.com" not in html
    assert "fonts" not in (app / "site" / "sw.js").read_text(encoding="utf-8")


def test_no_horizontal_overflow(app):
    r = run(app, "layout")
    for width in ("320", "390"):
        screens = {k: v for k, v in r[width].items() if k != "errors"}
        assert all(screens.values()), (width, screens)
        assert r[width]["errors"] == []


def test_confidence_states(app):
    r = run(app, "confidence")
    assert r["initial"].strip() == ""                       # nothing rated before a photo
    assert "Assessing scan…" in r["during"] and "High" not in r["during"] and "Medium" not in r["during"]
    assert "Back\nNot scanned" in r["during"]
    assert r["duringReviewDisabled"] is True
    assert r["frontLevel"] in ("high", "medium", "low", "cannot_assess")
    assert "Back\nNot scanned" in r["after"] and "Back\nNot scanned" in r["review"]
    assert "Limited — surface needs inspection" in r["after"]
    assert r["live"].startswith("Front scanned. Scan confidence:")
    for area in ("Outline", "Centering", "Corners & edges", "Surface visibility"):
        assert area in r["why"]
    assert not re.search(r"\d\s?%", r["bodyText"])        # never a percentage
    assert "%" not in re.sub(r"<[^>]+>", "", r["confHtml"])
    assert "0 /" not in r["review"] and "complete" not in r["review"].lower()
    assert r["confUnchangedByFilter"] is True
    assert r["errors"] == []


def test_stale_results_are_ignored(app):
    r = run(app, "stale")
    assert r["scanAfterReset"] == {"scan": False, "thumb": False, "conf": None}
    assert r["lookupAfterReset"]["resultsHidden"] is True
    assert r["lookupAfterReset"]["status"] == ""
    assert r["errors"] == []


def test_lookup_dedup_and_deadline(app):
    r = run(app, "lookup")
    assert r["rawMax"] > 1                  # without de-duplication the fallbacks repeat requests
    assert r["dedupMax"] == 1               # with it, each distinct request is sent once per read
    assert r["dedupDistinct"] == r["rawDistinct"]
    assert r["timedOut"] is True and r["elapsed"] < 5000
    assert "timed out" in r["timeoutText"] and r["rowStatus"] == "Timed out"
    assert r["errors"] == []


def test_old_history_and_backups_still_load(app):
    r = run(app, "legacy")
    assert r["resume"] == "Resume Draft Ahri"                  # a v2 draft still resumes
    assert "Old Pikachu" in r["history"] and "Checked Eevee" in r["history"]
    assert "Incomplete" in r["history"]                        # no inspection record: only a ceiling
    loaded = r["loaded"]
    assert loaded["name"] == "Old Pikachu" and loaded["complete"] is False
    assert [d["type"] for d in loaded["defects"]] == ["corner_whitening"]   # the unconfirmed flag isn't kept
    assert r["v3"]["inHand"] == {"front": ["surface", "edges"], "back": ["surface"]}
    assert r["v3"]["evidence"]["front"] == {"lr": "measured", "tb": "typed"}
    assert r["v3"]["complete"] is True
    # The UI says "defects"; stored data keeps its fields and wording.
    assert "Logged in defects" in r["defectsText"]
    for text in (r["defectsText"], r["reviewText"]):
        assert not re.search(r"\bDINGS?\b", text, flags=re.I)
    stored_notes = [d.get("note") for c in r["stored"] for d in c["assessment"]["defects"]]
    assert "Logged in DINGS" in stored_notes
    assert all(set(c) >= {"id", "created_at", "assessment"} for c in r["stored"])
    assert "Old Pikachu" in r["restored"]
    assert r["restoredStored"][0][0]["note"] == "Logged in DINGS"
    assert r["errors"] == []


def test_marks_and_filters_never_change_grades(app):
    r = run(app, "marks")
    assert r["unassessed0"] == ["front surface (photo can't show it)"]
    assert "Detection confidence: Medium" in r["listText"] and "Detection confidence: Low" in r["listText"]
    assert r["afterFind"] is True and r["afterFilters"] is True and r["afterDismissAndInHand"] is True
    assert r["filterCalls"] >= 1
    assert r["diffDisabled"] is True                           # no confirmed reference image
    assert "uncalibrated heuristic" in r["detail"]
    assert r["sheetTypes"] == ["surface_scratch", "print_spot"]  # suggested types first; the user chooses
    assert r["focusAfterSheet"].strip()                        # focus returns somewhere useful
    d = r["defect"]
    assert d["confirmed"] is True and d["side"] == "front" and d["location"] == "surface"
    assert d["region"] == {"x": 0.4, "y": 0.3, "w": 0.05, "h": 0.04}
    assert d["scan_revision"] and d["method"] == "local-contrast" and d["evidence"] == "A small light spot"
    # One accepted mark doesn't mark the surface as inspected.
    assert r["unassessed1"] == ["front surface (photo can't show it)"] and r["completeAfterAdd"] is False
    # Once checked in hand, the confirmed defect lowers the grade through the normal rules.
    assert r["completeWith"] is True and r["tagWith"] < r["tagWithout"]
    # A new photo clears the candidates but keeps the accepted defect, flagged for a re-check.
    assert r["afterNewPhoto"]["marks"] is None
    assert r["afterNewPhoto"]["defect"]["recheck"] is True
    assert "Re-check this defect" in r["recheckText"]
    backup = r["backup"]
    for secret in ("AIzaSyTESTKEY", "a" * 40, "cs_TESTKEY"):
        assert secret not in backup
    assert "candidates" not in backup and "cannotAssess" not in backup and "filtered" not in backup.lower()
    cards = json.loads(backup)["cards"]
    allowed = {"id", "created_at", "assessment", "report", "front_thumb", "back_thumb"}
    assert all(set(c) <= allowed for c in cards)
    assert r["errors"] == []


def test_end_to_end(app):
    r = run(app, "e2e")
    assert r["steps"] == ["scanned", "offline identify", "marks", "graded", "reloaded", "restored"]
    assert "You're offline" in r["offlineSheet"] and "Offline" in r["offlineRow"]
    assert r["focusBack"] == "open-details"                    # focus returns to the row that opened the sheet
    assert "Added as a defect" in r["marksList"] and "Dismissed" in r["marksList"]
    assert r["complete"] is True and "PSA" in r["grades"] and "Incomplete" not in r["grades"]
    assert "Test Card" in r["historyAfterReload"] and r["reloadedDefects"] == 1
    assert "Test Card" in r["historyAfterRestore"]
    data = json.loads(r["backup"])
    assert data["app"] == "card-grading-lab" and len(data["cards"]) == 1
    assert "candidates" not in r["backup"] and "AIza" not in r["backup"]
    assert r["errors"] == []
