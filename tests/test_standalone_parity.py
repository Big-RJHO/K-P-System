"""The standalone JavaScript engine must grade exactly like the Python package."""

from __future__ import annotations

import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from cardgrader import criteria_loader
from cardgrader.engine import grade_all
from cardgrader.models import CORNER_LOCATIONS, EDGE_LOCATIONS, CardAssessment

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_standalone import criteria_json  # noqa: E402

NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


COMPONENTS = ["corners", "edges", "surface"]
ALL = {"front": COMPONENTS, "back": COMPONENTS}


def random_evidence(rng: random.Random) -> dict:
    """Random inspection record and centering evidence; sometimes left out to exercise the defaults."""
    out: dict = {}
    pick = rng.random()
    if pick < 0.35:
        out["inspected"] = ALL
    elif pick < 0.85:
        out["inspected"] = {side: [c for c in COMPONENTS if rng.random() < 0.5] for side in ("front", "back")}
    if rng.random() < 0.6:
        out["centering_evidence"] = {
            side: {axis: rng.choice(["measured", "typed", "unread"]) for axis in ("lr", "tb") if rng.random() < 0.8}
            for side in ("front", "back")
            if rng.random() < 0.9
        }
    return out


def random_assessments(n: int, seed: int = 7) -> list[dict]:
    rng = random.Random(seed)
    erng = random.Random(seed + 1)  # separate stream, so the defect/centering cases stay as before
    types = criteria_loader.defects()["types"]
    out = []
    for i in range(n):
        def split():
            # mostly near-centered, sometimes way off; include exact thresholds and ties
            pick = rng.random()
            if pick < 0.15:
                return rng.choice([50, 51, 52, 55, 55.5, 60, 62.5, 65, 70, 75, 85, 90, 97.5])
            if pick < 0.8:
                return round(rng.uniform(50, 62), 2)
            return round(rng.uniform(50, 100), 2)

        defects = []
        for _ in range(rng.choice([0, 0, 1, 1, 2, 3, 5])):
            key = rng.choice(list(types))
            if key == "altered" and rng.random() < 0.8:
                continue
            comp = rng.choice(types[key]["applies_to"])
            loc = {"corners": rng.choice(CORNER_LOCATIONS), "edges": rng.choice(EDGE_LOCATIONS), "surface": "surface"}[comp]
            defects.append(
                {
                    "side": rng.choice(["front", "back"]),
                    "location": loc,
                    "type": key,
                    "severity": rng.choice(["micro", "minor", "moderate", "major"]),
                }
            )
        out.append(
            {
                "card": {"name": f"card {i}"},
                "centering": {"front": {"lr": split(), "tb": split()}, "back": {"lr": split(), "tb": split()}},
                "defects": defects,
                **random_evidence(erng),
            }
        )
    return out


def c(front=(50, 50), back=(50, 50)) -> dict:
    return {"front": {"lr": front[0], "tb": front[1]}, "back": {"lr": back[0], "tb": back[1]}}


CORNER = {"side": "back", "location": "top_left", "type": "corner_whitening", "severity": "minor"}
SCRATCH = {"side": "front", "location": "surface", "type": "holo_scratch", "severity": "micro"}

# Named cases: every rule about assessment evidence, on both engines.
EVIDENCE_CASES = {
    "nothing inspected, good centering": {"centering": c()},
    "nothing inspected, no centering given": {},
    "everything inspected, no defects": {"centering": c(), "inspected": ALL},
    "everything inspected, off-center": {"centering": c((62, 51), (70, 60)), "inspected": ALL},
    "partial inspection": {"centering": c(), "inspected": {"front": ["corners", "edges", "surface"], "back": ["edges"]}},
    "defects present, nothing else inspected": {"centering": c(), "defects": [CORNER, SCRATCH]},
    "defects present, everything inspected": {"centering": c((53, 50)), "defects": [CORNER, SCRATCH], "inspected": ALL},
    "unread front axis, everything inspected": {
        "centering": c((51, 50)),
        "inspected": ALL,
        "centering_evidence": {"front": {"lr": "unread", "tb": "measured"}, "back": {"lr": "measured", "tb": "typed"}},
    },
    "unread back side, off-center front": {
        "centering": c((60, 52)),
        "inspected": ALL,
        "centering_evidence": {"back": {"lr": "unread", "tb": "unread"}},
    },
    "altered, nothing inspected": {
        "centering": c(),
        "defects": [{"side": "front", "location": "top", "type": "altered", "severity": "major"}],
    },
}


def run_js(assessments: list[dict]) -> list[dict]:
    script = f"""
const G = require({json.dumps(str(ROOT / "standalone" / "src" / "grading.js"))});
const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(input.assessments.map((a) => G.gradeAll(a, input.criteria))));
"""
    payload = json.dumps({"criteria": criteria_json(), "assessments": assessments})
    res = subprocess.run([NODE, "-e", script], input=payload, capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def test_js_engine_matches_python():
    assessments = random_assessments(400)
    js_reports = run_js(assessments)
    for a, js in zip(assessments, js_reports):
        py = json.loads(grade_all(CardAssessment.model_validate(a)).model_dump_json())
        assert js == py, f"mismatch for {a}"


@pytest.mark.parametrize("name", list(EVIDENCE_CASES))
def test_js_matches_python_on_evidence_cases(name):
    a = EVIDENCE_CASES[name]
    (js,) = run_js([a])
    py = json.loads(grade_all(CardAssessment.model_validate(a)).model_dump_json())
    assert js == py
    # Sanity: only cases with everything assessed (or an altered card) are complete.
    complete = ("everything inspected" in name and "unread" not in name) or name.startswith("altered")
    assert py["complete"] is complete and (py["best_fit"] is None) is not complete


def test_random_cases_cover_incomplete_and_complete():
    reports = [grade_all(CardAssessment.model_validate(a)) for a in random_assessments(400)]
    assert 50 < sum(r.complete for r in reports) < 350


def test_js_rejects_unknown_defect():
    script = f"""
const G = require({json.dumps(str(ROOT / "standalone" / "src" / "grading.js"))});
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
try {{ G.gradeAll({{defects: [{{side: "front", location: "surface", type: "nope", severity: "minor"}}]}}, c); console.log("no error"); }}
catch (e) {{ console.log("error"); }}
"""
    res = subprocess.run([NODE, "-e", script], input=json.dumps(criteria_json()), capture_output=True, text=True)
    assert res.stdout.strip() == "error"
