"""Resolution experiment (plan Phase 2): does the edge/corner check find TAG's corner and edge DINGs better
when it sees the card at higher resolution?

The owner has TAG's written permission to collect TAG reports and images for personal research. TAG data stays
outside this repository; only code lives here. Never run this on the sealed `test` split before the final
evaluation (it refuses unless --allow-test).

Arms, all from the same full-size TAG scan (prepared by tagprep.prep, on a dark background):
  A  today's app: photo downsized to 2400 px, card flattened at 750 px wide (~11.9 px/mm)
  B  full-size photo, card flattened at ~25 px/mm  (scale 2.1)
  C  full-size photo, card flattened at ~40 px/mm  (scale 3.36)
  D  full-size photo, card flattened at ~69 px/mm  (scale 5.8, about the scan's own resolution)

Per area (4 corners + 4 edges, front and back) the label is whether TAG listed a corner/edge DING there; the
score is the app's own candidate confidence there (0 if it raised nothing). Scores fixed before any result:
  corner: confidence if the corner has a severity, else 0
  edge:   the highest confidence of the edge's candidates (reflections included, as the app shows them), else 0
Areas the app marks not assessable in either arm of a comparison are left out of it (counted in the report).

  python -I resexp.py run   --root TAGDB --repo REPO --split dev-tune --out OUT [--arms A,B,C,D] [--jobs 3] [--limit N]
  python -I resexp.py score --root TAGDB --split dev-tune --out OUT [--boot 2000]
"""
import argparse
import json
import random
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tagprep import prep  # noqa: E402

PX_PER_MM = 750 / 63
ARMS = {"A": {"max_side": 2400, "scale": 1.0}, "B": {"max_side": 0, "scale": 2.1},
        "C": {"max_side": 0, "scale": 3.36}, "D": {"max_side": 0, "scale": 5.8}}
CORNERS = ("top_left", "top_right", "bottom_right", "bottom_left")
EDGES = ("top", "right", "bottom", "left")
TAG_CORNERS = {"topleft": "top_left", "topright": "top_right", "bottomleft": "bottom_left", "bottomright": "bottom_right"}


def records(root: Path):
    return {r["cert"]: r for r in map(json.loads, (root / "certs.jsonl").read_text().splitlines())}


def split_certs(root: Path, split: str, allow_test: bool, certs_file: str = ""):
    if certs_file:  # an explicit list (smoke runs); sealed test certs are still refused
        certs = Path(certs_file).read_text().split()
        recs = records(root)
        if not allow_test and any(recs[c].get("pool") == "test" for c in certs):
            sys.exit("refusing sealed test certs without --allow-test")
        return certs
    if split == "test" and not allow_test:
        sys.exit("refusing the sealed test split without --allow-test")
    s = json.loads((root / "splits.json").read_text())
    certs = sorted(c for c, sp in s["membership"].items() if sp == split)   # membership: cert -> split
    if not certs:
        sys.exit(f"no certs in split {split!r}; splits are {sorted(set(s['membership'].values()))}")
    return certs


# ---------------------------------------------------------------- labels from TAG's DING list

def kind(t: str):
    t = t.lower()
    if t.startswith("centering"):
        return None
    if any(w in t for w in ("surface", "crease", "dent", "roller", "print", "scratch")):
        return "surface"
    if "corner" in t:
        return "corner"
    return "edge"


def labels(rec: dict) -> dict:
    """{(side, 'corner'|'edge', location): 1} for every area TAG listed a corner or edge DING at."""
    pos = {}
    for d in rec["tag"]["ding_list"]:
        k, loc, side = kind(d["type"]), d["location"].lower().replace(" ", "").replace("-", ""), d["side"]
        if k in (None, "surface"):
            continue
        if k == "corner" and loc in TAG_CORNERS:
            pos[(side, "corner", TAG_CORNERS[loc])] = 1
        else:
            for e in EDGES:
                if e in loc:
                    pos[(side, "edge", e)] = 1
    return pos


def scores(details: dict) -> dict:
    """{(side, 'corner'|'edge', location): (score, assessable)} from photo_grade --details output."""
    out = {}
    for side, d in details.items():
        for c in d["corners"]:
            out[(side, "corner", c["location"])] = (c["confidence"] if c.get("severity") else 0.0, bool(c["assessable"]))
        for e in EDGES:
            cands = [x["confidence"] for x in d["edges"] if x["side"] == e]
            out[(side, "edge", e)] = (max(cands) if cands else 0.0, bool(d["sides"][e]["assessable"]))
    return out


# ---------------------------------------------------------------- running the arms

def run_one(cert, rec, a, prep):
    done = all((Path(a.out) / arm / cert / "details.json").exists() for arm in a.arms)
    if done:
        return cert, "skipped"
    tmp = Path(tempfile.mkdtemp(prefix=f"resexp_{cert}_", dir=a.tmp))
    try:
        paths = {}
        for side in ("front", "back"):
            img = cv2.imread(str(Path(a.root) / rec["images"][side]["path"]), cv2.IMREAD_COLOR)
            if img is None:
                return cert, f"no {side} image"
            paths[side] = tmp / f"{side}.png"
            cv2.imwrite(str(paths[side]), prep(img), [cv2.IMWRITE_PNG_COMPRESSION, 1])
        for arm in a.arms:
            o = Path(a.out) / arm / cert
            if (o / "details.json").exists():
                continue
            work = tmp / arm
            cfg = ARMS[arm]
            p = subprocess.run([a.python, "scripts/photo_grade.py", "scan", str(paths["front"]), str(paths["back"]),
                                "--out", str(work), "--scale", str(cfg["scale"]), "--max-side", str(cfg["max_side"]),
                                "--details", str(work / "details.json")], cwd=a.repo, capture_output=True, text=True)
            if p.returncode:
                return cert, f"{arm} failed: {(p.stderr or p.stdout)[-300:]}"
            o.mkdir(parents=True, exist_ok=True)
            for f in ("details.json", "scan.json"):
                shutil.copy(work / f, o / f)
        return cert, "ok"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_run(a):
    root = Path(a.root)
    recs = records(root)
    certs = split_certs(root, a.split, a.allow_test, a.certs)[: a.limit or None]
    a.arms = a.arms.split(",")
    Path(a.tmp).mkdir(parents=True, exist_ok=True)
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=a.repo, capture_output=True, text=True).stdout.strip()
    Path(a.out).mkdir(parents=True, exist_ok=True)
    (Path(a.out) / "config.json").write_text(json.dumps({"split": a.split, "arms": {k: ARMS[k] for k in a.arms},
                                                         "repo_commit": commit, "certs": len(certs)}, indent=1))
    with ThreadPoolExecutor(a.jobs) as ex:
        for cert, status in ex.map(lambda c: run_one(c, recs[c], a, prep), certs):
            print(cert, status, flush=True)


# ---------------------------------------------------------------- scoring

def auc(pos, neg):
    """Mann-Whitney AUC, ties count half."""
    if not pos or not neg:
        return None
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    rank, i, r_pos = 1, 0, 0.0
    while i < len(allv):
        j = i
        while j < len(allv) and allv[j][0] == allv[i][0]:
            j += 1
        avg = (rank + rank + (j - i) - 1) / 2
        r_pos += avg * sum(1 for k in range(i, j) if allv[k][1])
        rank += j - i
        i = j
    return (r_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def recall_at_fpr(pos, neg, fpr=0.10):
    """Recall at the lowest threshold whose false-positive rate on clean areas is <= fpr (score > thr flags)."""
    if not pos or not neg:
        return None
    for thr in sorted(set(neg + pos + [0.0])):
        if sum(v > thr for v in neg) / len(neg) <= fpr:
            return sum(v > thr for v in pos) / len(pos)
    return 0.0


def table(rows, arm_a, arm_b):
    """Paired rows for one comparison: areas assessable in both arms. rows: [(group, label, {arm: (score, ok)})]."""
    out = []
    for g, lab, sc in rows:
        if arm_a in sc and arm_b in sc and sc[arm_a][1] and sc[arm_b][1]:
            out.append((g, lab, sc[arm_a][0], sc[arm_b][0]))
    return out


def stats(paired):
    pa = [s for _, l, s, _ in paired if l]; na = [s for _, l, s, _ in paired if not l]
    pb = [s for _, l, _, s in paired if l]; nb = [s for _, l, _, s in paired if not l]
    return {"areas": len(paired), "positive": len(pa), "clean": len(na),
            "auc_a": auc(pa, na), "auc_b": auc(pb, nb), "recall10_a": recall_at_fpr(pa, na), "recall10_b": recall_at_fpr(pb, nb),
            "flag_rate_clean_a": sum(v > 0 for v in na) / len(na) if na else None,
            "flag_rate_clean_b": sum(v > 0 for v in nb) / len(nb) if nb else None,
            "recall_any_a": sum(v > 0 for v in pa) / len(pa) if pa else None,
            "recall_any_b": sum(v > 0 for v in pb) / len(pb) if pb else None}


def boot_diff(paired, n, seed=20261103):
    """95% CI of AUC(b) - AUC(a), resampling card groups."""
    groups = {}
    for row in paired:
        groups.setdefault(row[0], []).append(row)
    keys, rng, diffs = sorted(groups), random.Random(seed), []
    for _ in range(n):
        sample = [r for k in (rng.choice(keys) for _ in keys) for r in groups[k]]
        s = stats(sample)
        if s["auc_a"] is not None and s["auc_b"] is not None:
            diffs.append(s["auc_b"] - s["auc_a"])
    diffs.sort()
    return [round(diffs[int(0.025 * len(diffs))], 3), round(diffs[int(0.975 * len(diffs)) - 1], 3)] if diffs else None


def cmd_score(a):
    root = Path(a.root)
    recs = records(root)
    certs = split_certs(root, a.split, a.allow_test, a.certs)
    arms = [p.name for p in sorted(Path(a.out).iterdir()) if p.is_dir() and p.name in ARMS]
    rows = {"corner": [], "edge": []}
    missing = 0
    for cert in certs:
        det = {arm: Path(a.out) / arm / cert / "details.json" for arm in arms}
        if not all(p.exists() for p in det.values()):
            missing += 1
            continue
        sc = {arm: scores(json.loads(p.read_text())) for arm, p in det.items()}
        lab = labels(recs[cert])
        for key in sc[arms[0]]:
            rows[key[1]].append((recs[cert]["group_key"], lab.get(key, 0), {arm: sc[arm][key] for arm in arms}))
    report = {"split": a.split, "certs": len(certs), "certs_missing_results": missing, "arms": arms, "comparisons": {}}
    for area in ("corner", "edge"):
        for arm in arms:
            if arm == "A":
                continue
            paired = table(rows[area], "A", arm)
            s = stats(paired)
            s["auc_diff"] = None if s["auc_a"] is None or s["auc_b"] is None else round(s["auc_b"] - s["auc_a"], 3)
            s["auc_diff_ci95"] = boot_diff(paired, a.boot)
            report["comparisons"][f"{area}:A_vs_{arm}"] = {k: (round(v, 3) if isinstance(v, float) else v) for k, v in s.items()}
    text = json.dumps(report, indent=1)
    (Path(a.out) / f"score_{a.split}.json").write_text(text)
    print(text)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("run", cmd_run), ("score", cmd_score)):
        s = sub.add_parser(name)
        s.add_argument("--root", required=True); s.add_argument("--split", required=True); s.add_argument("--out", required=True)
        s.add_argument("--allow-test", action="store_true")
        s.add_argument("--certs", default="", help="score/run these certs instead of the split's (smoke runs)")
        s.set_defaults(fn=fn)
        if name == "run":
            s.add_argument("--repo", required=True); s.add_argument("--arms", default="A,B,C,D")
            s.add_argument("--jobs", type=int, default=3); s.add_argument("--limit", type=int, default=0)
            s.add_argument("--python", default=sys.executable); s.add_argument("--tmp", default=tempfile.gettempdir())
        else:
            s.add_argument("--boot", type=int, default=2000)
    a = ap.parse_args()
    if Path(a.out).resolve().is_relative_to(HERE.parent.parent):
        sys.exit("--out must be outside the repository (TAG-derived results stay out of the repo)")
    a.fn(a)
