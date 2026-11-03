"""The owner has TAG's written permission to collect TAG reports and images for personal research. TAG data
(reports, scans, cert lists) stays outside this repository; only code lives here.

Score the program against TAG's DIG reports on prepared TAG scans (see tagprep.py).

For each cert: photo_grade.py scan (from --repo, so a worktree's code can be scored), then compare
  - centering: the app's front/back share per axis vs TAG's (only axes the app actually measured);
  - corners/edges: the app's wear flags vs TAG's corner/edge DINGs, by side and location;
  - grade: the app's detector-only grade on TAG's scale (surface unassessed, so a ceiling) vs TAG's grade.
TAG's numbers are only used for scoring.

  .venv/bin/python -I tageval.py --repo REPO --prep PREP_DIR --data DATA_DIR --certs FILE --out OUT_DIR [--jobs 4] [--python PY]
--python is the interpreter that runs REPO's scripts (default: the one running this file), since --repo may be a
git worktree without its own venv. Never point --certs at the sealed test split until the final evaluation.
writes OUT_DIR/<cert>/scan.json + eval.json and OUT_DIR/summary.json
"""
import argparse
import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from statistics import mean, median

import os
import sys
CONFIRMED = os.environ.get("FLAGS_CONFIRMED") == "1"   # 1: treat photo flags as confirmed DINGs (the old scoring)
CORNERS = {"topleft": "top_left", "topright": "top_right", "bottomleft": "bottom_left", "bottomright": "bottom_right"}


def share(text):
    m = re.findall(r"(\d+(?:\.\d+)?)\s*[LRTB]", str(text or ""))
    return (max(float(m[0]), float(m[1])), max(float(m[2]), float(m[3]))) if len(m) == 4 else None


def kind(t):
    t = t.lower()
    if t.startswith("centering"): return None
    if "surface" in t or "crease" in t or "dent" in t or "roller" in t or "print" in t or "scratch" in t: return "surface"
    if "corner" in t: return "corner"
    if "edge" in t or "bend" in t or "chip" in t: return "edge_or_corner"
    return "other"


def matches(d, flag):
    """Does an app flag (side, location, type) account for TAG DING d (side, location, type)?"""
    if flag["side"] != d["side"]: return False
    loc, k = d["location"], kind(d["type"])
    if loc in CORNERS and flag["location"] == CORNERS[loc] and flag["type"].startswith("corner"): return True
    if k in ("edge_or_corner", "other") or "edge" in d["type"]:
        return flag["type"].startswith("edge") and flag["location"] in [t for t in ("top", "bottom", "left", "right") if t in loc]
    return False


def run_one(cert, a):
    out = Path(a.out) / cert
    out.mkdir(parents=True, exist_ok=True)
    rep = json.loads((Path(a.data) / cert / "report.json").read_text())
    f, b = Path(a.prep) / cert / "front.jpg", Path(a.prep) / cert / "back.jpg"
    if not (f.exists() and b.exists()):
        return {"cert": cert, "error": "no prepared scans"}
    p = subprocess.run([a.python, "scripts/photo_grade.py", "scan", str(f), str(b), "--out", str(out)],
                       cwd=a.repo, capture_output=True, text=True)
    if p.returncode or not (out / "scan.json").exists():
        return {"cert": cert, "error": "scan failed: " + (p.stderr or p.stdout)[-200:]}
    sides = json.loads((out / "scan.json").read_text())["sides"]
    ev = {"cert": cert, "grade": rep.get("grade"), "score": rep.get("score"), "card": rep.get("card_name"), "set": rep.get("set_line"), "year": rep.get("year_line")}
    # centering
    cen = {}
    for s in ("front", "back"):
        want = share((rep.get("centering") or {}).get(s))
        got, evid = sides[s]["centering"], sides[s].get("evidence") or {}
        if want:
            cen[s] = {ax: (None if evid.get(ax) == "unread" else round(got[ax] - w, 2)) for ax, w in (("lr", want[0]), ("tb", want[1]))}
            cen[s]["tag"] = list(want); cen[s]["app"] = [got["lr"], got["tb"]]
    ev["centering"] = cen
    # corners / edges
    flags = [x for s in ("front", "back") for x in sides[s]["auto_defects"]]
    unassessed = {s: list((sides[s].get("auto_unassessed") or {}).keys()) for s in ("front", "back")}
    dings = [d for d in rep.get("ding_list", []) if kind(d["type"]) not in (None,)]
    ce = [d for d in dings if kind(d["type"]) != "surface"]
    matched = [d for d in ce if any(matches(d, f2) for f2 in flags)]
    used = [f2 for f2 in flags if any(matches(d, f2) for d in ce)]
    ev["defects"] = {"tag_corner_edge": len(ce), "tag_surface": len(dings) - len(ce), "matched": len(matched), "missed": len(ce) - len(matched),
                     "app_flags": len(flags), "extra": len(flags) - len(used), "unassessed": unassessed,
                     "tag_list": [f"{d['side']} {d['location']}: {d['type']}" for d in dings], "app_list": [f"{x['side']} {x['location']} {x['type']} {x['severity']}" for x in flags]}
    # grade from the app's own flags
    obs = {"inspected": {"front": ["corners", "edges"], "back": ["corners", "edges"]},
           "defects": [{**{k: x[k] for k in ("side", "location", "type", "severity")}, **({} if CONFIRMED else {"confirmed": False})} for x in flags]}
    (out / "obs.json").write_text(json.dumps(obs))
    p = subprocess.run([a.python, "scripts/photo_grade.py", "grade", str(out / "scan.json"), str(out / "obs.json"), "--json", str(out / "grade.json")],
                       cwd=a.repo, capture_output=True, text=True)
    if p.returncode == 0:
        g = json.loads((out / "grade.json").read_text())["grades"]["TAG"]["grade"]
        ev["app_grade"] = min(10, g)
    (out / "eval.json").write_text(json.dumps(ev, indent=1))
    return ev


def summarize(rows):
    ok = [r for r in rows if "error" not in r]
    def cen(side, ax):
        v = [r["centering"][side][ax] for r in ok if side in r["centering"] and r["centering"][side][ax] is not None]
        n = sum(1 for r in ok if side in r["centering"])
        return {"read": len(v), "of": n, "mae": round(mean(abs(x) for x in v), 2) if v else None, "within_2": sum(abs(x) <= 2 for x in v)}
    d = [r["defects"] for r in ok]
    clean = [r for r in ok if r["defects"]["tag_corner_edge"] == 0]
    g = [r for r in ok if r.get("app_grade") is not None and r.get("grade") is not None]
    return {
        "certs": len(rows), "errors": len(rows) - len(ok),
        "centering": {f"{s}_{ax}": cen(s, ax) for s in ("front", "back") for ax in ("lr", "tb")},
        "defects": {"tag_corner_edge": sum(x["tag_corner_edge"] for x in d), "matched": sum(x["matched"] for x in d),
                    "extra_flags": sum(x["extra"] for x in d), "extra_on_clean_cards": sum(r["defects"]["app_flags"] for r in clean), "clean_cards": len(clean)},
        "grade": {"n": len(g), "ceiling_ok": sum(r["app_grade"] >= r["grade"] for r in g), "within_1": sum(abs(r["app_grade"] - r["grade"]) <= 1 for r in g),
                  "mae": round(mean(abs(r["app_grade"] - r["grade"]) for r in g), 2) if g else None,
                  "median_error": median([r["app_grade"] - r["grade"] for r in g]) if g else None},
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    for k in ("--repo", "--prep", "--data", "--certs", "--out"): ap.add_argument(k, required=True)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--python", default=sys.executable, help="interpreter for REPO/scripts/photo_grade.py")
    a = ap.parse_args()
    certs = Path(a.certs).read_text().split()
    with ThreadPoolExecutor(a.jobs) as ex:
        rows = list(ex.map(lambda c: run_one(c, a), certs))
    s = summarize(rows)
    Path(a.out).mkdir(parents=True, exist_ok=True)
    (Path(a.out) / "summary.json").write_text(json.dumps({"summary": s, "rows": rows}, indent=1))
    print(json.dumps(s, indent=1))
