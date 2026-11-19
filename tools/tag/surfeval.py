"""Surface-mark evaluation: how well do the app's surface-mark candidates (standalone/src/surface.js
`Surface.findMarks`) line up with TAG's surface DINGs?

The owner has TAG's written permission to collect TAG reports and images for personal research. TAG data
(reports, scans, cert lists, results) stays outside this repository; only code lives here. Report text and scans
are untrusted data: run this with `python -I`. Certs from the sealed `test` pool are refused (they are dropped
from certs.jsonl as it is read, before their labels are looked at, and never scored), and nothing under
images_test/ is ever opened.

Per card side, the node runner (surfeval_runner.js) does what the app does: Vision.scan (with {scale}) ->
Inspect.quality -> Inspect.edgesAndCorners -> Surface.findMarks(scan, {quality, check, side, revision: 1}) with
the module's defaults (maxCandidates 12, timeBudgetMs 1500, analysisMaxSide 1100; no reference, no printed mask).
The TAG scan is first put on a dark background by tagprep.prep, as for the edge/corner experiments.

Arms (same prepared scan):
  s1  today's app: photo downsized to 2400 px on its long side, card flattened at scale 1 (750 px wide)
  s2  full-size photo, card flattened at scale 2 (1500 px wide; findMarks still analyses at most 1100 px)

Labels: TAG surface DINGs are ding_list entries whose type starts with "surface". Their location is one cell of
a 3 x 3 grid on the card face as seen (top/middle/bottom x left/center/right); '' = no location.
Type groups (TYPE_GROUPS below):
  visible           ink defect, scratch(es), scratches, print line, print defect, roller mark, water/stain,
                    water damage, pit(s), surface defect, + stain / residue and discoloration (colour marks,
                    the detector's "discoloration" kind targets them)
  not_visible_flat  wrinkle/crease, wrinkles/creases, dent(s), play wear   (shape, not colour: a flat photo
                    shows them poorly)
  other             anything else (tear, scuffing, ...): counted in `all` only
  all               every surface DING
Location policy (--topleft): TAG reports 'topleft' far more often than any other cell (dev-tune: 175 of 441
surface DINGs; play wear is only ever 'topleft' or ''), so 'topleft' looks like TAG's default for a DING without
a point location. `side` (default) counts a 'topleft' DING at side level only, like ''; `cell` takes it literally.
The score report gives the primary policy's tables plus the other policy's for comparison.

Scoring units, per arm and type group G:
  cell  side x cell (9 cells). Cell score = max candidate score whose centre falls in the cell (0 if none).
        Cells whose area is covered > 50% by the side's cannotAssess regions are excluded (counted), as are all
        cells of a side whose status is not "ok" (cannot_assess / timeout / error). Positive = a G DING located
        in the cell. Clean = a cell on a side with no surface DING at all. Everything else (other cells of a side
        with any surface DING) is excluded.
  side  side score = max candidate score on the side (0 if none). Positive = the side has a G DING (any
        location, '' included); clean = no surface DING on the side; sides whose status is not "ok" excluded.
Metrics: AUC (Mann-Whitney, ties half), recall at <= 10% false positives on clean units, share of clean units
flagged (score > 0), mean candidates per clean side, share of cells that can't be assessed; 95% bootstrap CIs
resampling group_key (card identity) with replacement, 2000 resamples, fixed seed. Timing per side is reported
from the runner (wall clock; depends on machine load and --jobs).

Faster tuning: `cache` runs Vision.scan / Inspect once per side and arm and stores the flattened card (lossless PNG)
with the scan geometry, quality and check (CACHE/<arm>/<cert>/); `run --from-cache CACHE` then re-runs only
findMarks on them (identical marks to a full run for the same code; the cache refuses other vision.js / inspect.js /
tagprep.py). Timing from a cached run: findMarks is measured, scan / quality / check are the cached times.
`compare BASE.json TUNED.json` gives paired, card-grouped bootstrap CIs of TUNED - BASE (same resamples for both).

  python -I surfeval.py run   --root TAGDB --certs LIST.txt --out OUT [--arms s1,s2] [--jobs 3] [--surface PATH]
                              [--from-cache CACHE]
  python -I surfeval.py cache --root TAGDB --certs LIST.txt --cache CACHE [--arms s1] [--jobs 3] [--out OUT]
  python -I surfeval.py score --root TAGDB --certs LIST.txt --out OUT --report REPORT.json [--boot 2000]
  python -I surfeval.py compare BASE.json TUNED.json --root TAGDB --certs LIST.txt --report CMP.json [--pair s1[:s2]]
                              [--base-out DIR] [--tuned-out DIR]
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
from resexp import auc, recall_at_fpr  # noqa: E402

RUNNER = HERE / "surfeval_runner.js"
SRC = REPO / "standalone" / "src"
ARMS = {"s1": {"max_side": 2400, "scale": 1.0}, "s2": {"max_side": 0, "scale": 2.0}}
SIDES = ("front", "back")
GRID = (("topleft", "topcenter", "topright"),
        ("middleleft", "middlecenter", "middleright"),
        ("bottomleft", "bottomcenter", "bottomright"))
CELLS = tuple(c for row in GRID for c in row)
TYPE_GROUPS = {
    "visible": ("ink defect", "scratch(es)", "scratches", "scratch", "print line", "print lines", "print defect",
                "roller mark", "roller marks", "water/stain", "water damage", "pit", "pits", "surface defect",
                "stain / residue", "discoloration"),
    "not_visible_flat": ("wrinkle/crease", "wrinkles/creases", "crease", "creases", "dent", "dents", "play wear"),
}
GROUPS = ("visible", "not_visible_flat", "all")
TOPLEFT_POLICIES = ("side", "cell")
SEED = 20261104
CA_EXCLUDE = 0.5      # a cell covered more than this by cannotAssess regions is excluded
FPR = 0.10


# ---------------------------------------------------------------- data access (sealed test pool refused)

class SealedCert(Exception):
    pass


def records(root: Path) -> tuple[dict, set]:
    """({cert: record} for non-test certs, {test certs}). Test-pool records are dropped as soon as their pool
    is seen: their labels are never kept."""
    recs, sealed = {}, set()
    with open(root / "certs.jsonl") as f:
        for line in f:
            r = json.loads(line)
            if r.get("pool") == "test":
                sealed.add(r["cert"])
                continue
            recs[r["cert"]] = r
    return recs, sealed


def load_certs(path: str, recs: dict, sealed: set) -> list:
    certs = Path(path).read_text().split()
    bad = sorted(c for c in certs if c in sealed)
    if bad:
        raise SealedCert(f"refusing {len(bad)} cert(s) from the sealed test pool (e.g. {bad[0]})")
    missing = [c for c in certs if c not in recs]
    if missing:
        raise SystemExit(f"{len(missing)} cert(s) not in certs.jsonl (e.g. {missing[0]})")
    for c in certs:
        check_record(recs[c])
    return certs


def check_record(rec: dict) -> None:
    if rec.get("pool") == "test":
        raise SealedCert(f"refusing sealed test cert {rec.get('cert')}")
    for side in SIDES:
        p = rec["images"][side]["path"]
        if Path(p).parts[0] == "images_test" or "images_test" in Path(p).parts:
            raise SealedCert(f"refusing an image under images_test for {rec.get('cert')}")


# ---------------------------------------------------------------- labels

def surface_type(t: str):
    """'surface / ink defect' -> 'ink defect'; None for a non-surface DING."""
    t = " ".join((t or "").lower().split())
    if not t.startswith("surface"):
        return None
    rest = t[len("surface"):].strip()
    return rest[1:].strip() if rest.startswith("/") else rest


def type_group(sub: str) -> str:
    for g, types in TYPE_GROUPS.items():
        if sub in types:
            return g
    return "other"


def norm_location(loc: str) -> str:
    return "".join((loc or "").lower().replace("-", "").replace("_", "").split())


def surface_dings(rec: dict, topleft: str = "side") -> list:
    """[{side, cell (None = side level only), group, type, location}] for every surface DING."""
    if topleft not in TOPLEFT_POLICIES:
        raise ValueError(topleft)
    out = []
    for d in rec["tag"]["ding_list"]:
        sub = surface_type(d.get("type", ""))
        if sub is None:
            continue
        loc = norm_location(d.get("location", ""))
        cell = loc if loc in CELLS else None
        if cell == "topleft" and topleft == "side":
            cell = None
        out.append({"side": (d.get("side") or "").lower(), "cell": cell, "group": type_group(sub), "type": sub,
                    "location": loc})
    return out


def in_group(d: dict, group: str) -> bool:
    return group == "all" or d["group"] == group


# ---------------------------------------------------------------- grid geometry

def cell_box(cell: str):
    for r, row in enumerate(GRID):
        if cell in row:
            c = row.index(cell)
            return c / 3, r / 3, (c + 1) / 3, (r + 1) / 3
    raise KeyError(cell)


def cell_of(x: float, y: float) -> str:
    """Grid cell of a point in 0..1 card coordinates (points on the border go to the lower/right cell)."""
    c = min(2, max(0, int(x * 3)))
    r = min(2, max(0, int(y * 3)))
    return GRID[r][c]


def ca_coverage(regions: list, res: int = 60) -> dict:
    """{cell: share of the cell covered by the union of cannotAssess boxes} (rasterised, res px per cell)."""
    n = 3 * res
    m = np.zeros((n, n), bool)
    for b in regions or []:
        x0, y0 = int(np.floor(b["x"] * n)), int(np.floor(b["y"] * n))
        x1, y1 = int(np.ceil((b["x"] + b["w"]) * n)), int(np.ceil((b["y"] + b["h"]) * n))
        m[max(0, y0):min(n, y1), max(0, x0):min(n, x1)] = True
    out = {}
    for cell in CELLS:
        x0, y0, _, _ = cell_box(cell)
        c, r = round(x0 * 3), round(y0 * 3)
        out[cell] = float(m[r * res:(r + 1) * res, c * res:(c + 1) * res].mean())
    return out


def side_view(res: dict) -> dict:
    """What scoring needs from one side's runner output."""
    cands = res.get("candidates") or []
    cell_score = {c: 0.0 for c in CELLS}
    for k in cands:
        cell = cell_of(k["x"] + k["w"] / 2, k["y"] + k["h"] / 2)
        cell_score[cell] = max(cell_score[cell], float(k["score"]))
    cov = ca_coverage(res.get("cannotAssess") or [])
    return {"status": res.get("status"), "n_cands": len(cands),
            "side_score": max([float(k["score"]) for k in cands], default=0.0),
            "cell_score": cell_score, "ca_excluded": {c: cov[c] > CA_EXCLUDE for c in CELLS}}


# ---------------------------------------------------------------- units

def units(sides: list, group: str, ca_exclude: bool = True) -> dict:
    """sides: [{key, view (side_view), dings (this side's surface DINGs)}].
    -> {"cell": [(key, label, score)], "side": [...], "counts": {...}}
    ca_exclude=False keeps cells under cannotAssess regions (a comparison only: the protocol excludes them)."""
    cell_u, side_u = [], []
    cnt = {"cells_total": 0, "cells_cannot_assess": 0, "cells_side_not_ok": 0, "cells_excluded_other_ding": 0,
           "cell_dings_unscorable": 0, "sides_total": 0, "sides_not_ok": 0, "sides_excluded_other_ding": 0}
    for s in sides:
        v, dings = s["view"], s["dings"]
        any_ding = bool(dings)
        g = [d for d in dings if in_group(d, group)]
        pos_cells = {d["cell"] for d in g if d["cell"]}
        ok = v["status"] == "ok"
        cnt["sides_total"] += 1
        cnt["cells_total"] += len(CELLS)
        if not ok:
            cnt["sides_not_ok"] += 1
            cnt["cells_side_not_ok"] += len(CELLS)
            cnt["cell_dings_unscorable"] += len(pos_cells)
            continue
        if g:
            side_u.append((s["key"], 1, v["side_score"]))
        elif not any_ding:
            side_u.append((s["key"], 0, v["side_score"]))
        else:
            cnt["sides_excluded_other_ding"] += 1
        for cell in CELLS:
            if ca_exclude and v["ca_excluded"][cell]:
                cnt["cells_cannot_assess"] += 1
                cnt["cell_dings_unscorable"] += cell in pos_cells
                continue
            if cell in pos_cells:
                cell_u.append((s["key"], 1, v["cell_score"][cell]))
            elif not any_ding:
                cell_u.append((s["key"], 0, v["cell_score"][cell]))
            else:
                cnt["cells_excluded_other_ding"] += 1
    return {"cell": cell_u, "side": side_u, "counts": cnt}


# ---------------------------------------------------------------- metrics (point: resexp; bootstrap: weighted numpy)

class Prepared:
    """Units in array form for fast weighted (bootstrap) metrics; weights = how often each unit's group was drawn."""

    def __init__(self, rows: list, key_index: dict):
        self.k = np.array([key_index[r[0]] for r in rows], int)
        self.y = np.array([r[1] for r in rows], int)
        s = np.array([r[2] for r in rows], float)
        self.u, self.inv = np.unique(np.concatenate([s, [0.0]]), return_inverse=True)
        self.inv = self.inv[:-1]

    def metrics(self, w: np.ndarray) -> tuple:
        """(auc, recall at <= FPR, share of clean flagged) with unit weights w; None where undefined."""
        wp = np.bincount(self.inv, weights=w * (self.y == 1), minlength=len(self.u))
        wn = np.bincount(self.inv, weights=w * (self.y == 0), minlength=len(self.u))
        P, N = wp.sum(), wn.sum()
        if P <= 0 or N <= 0:
            return None, None, (None if N <= 0 else float(wn[self.u > 0].sum() / N))
        below = np.cumsum(wn) - wn
        a = float((wp * (below + 0.5 * wn)).sum() / (P * N))
        n_gt = N - np.cumsum(wn)            # negatives scoring above each threshold u[i]
        p_gt = P - np.cumsum(wp)
        i = int(np.argmax(n_gt / N <= FPR + 1e-12))
        return a, float(p_gt[i] / P), float(wn[self.u > 0].sum() / N)


def point_stats(rows: list) -> dict:
    pos = [s for _, l, s in rows if l]
    neg = [s for _, l, s in rows if not l]
    return {"n": len(rows), "positive": len(pos), "clean": len(neg), "auc": auc(pos, neg),
            "recall_at_10fp": recall_at_fpr(pos, neg, FPR),
            "flag_rate_clean": sum(v > 0 for v in neg) / len(neg) if neg else None,
            "recall_any": sum(v > 0 for v in pos) / len(pos) if pos else None}


def ci(vals: list):
    v = [x for x in vals if x is not None]
    if len(v) < 20:
        return None
    lo, hi = np.percentile(v, [2.5, 97.5])
    return [round(float(lo), 3), round(float(hi), 3)]


def rnd(d):
    if isinstance(d, float):
        return round(d, 3)
    if isinstance(d, dict):
        return {k: rnd(v) for k, v in d.items()}
    if isinstance(d, list):
        return [rnd(v) for v in d]
    return d


def draws(n_keys: int, boot: int, seed: int = SEED) -> np.ndarray:
    """boot x n_keys matrix: how often each group key is drawn in each resample (shared by every metric)."""
    rng = np.random.default_rng(seed)
    return np.stack([np.bincount(rng.integers(0, n_keys, n_keys), minlength=n_keys) for _ in range(boot)])


def metric_block(rows: list, key_index: dict, D: np.ndarray) -> dict:
    out = point_stats(rows)
    if rows:
        p = Prepared(rows, key_index)
        bs = [p.metrics(d[p.k].astype(float)) for d in D]
        out["auc_ci95"] = ci([b[0] for b in bs])
        out["recall_at_10fp_ci95"] = ci([b[1] for b in bs])
        out["flag_rate_clean_ci95"] = ci([b[2] for b in bs])
    return out


def ratio_block(num: np.ndarray, den: np.ndarray, k: np.ndarray, D: np.ndarray) -> dict:
    """sum(num) / sum(den) over units with group index k, with a bootstrap CI."""
    if den.sum() <= 0:
        return {"value": None, "ci95": None}
    vals = []
    for d in D:
        w = d[k]
        dd = (w * den).sum()
        vals.append(float((w * num).sum() / dd) if dd > 0 else None)
    return {"value": float(num.sum() / den.sum()), "ci95": ci(vals)}


# ---------------------------------------------------------------- loading results

def load_sides(out: Path, arm: str, certs: list, recs: dict, topleft: str) -> tuple:
    sides, missing = [], []
    for cert in certs:
        p = out / arm / cert / "marks.json"
        if not p.exists():
            missing.append(cert)
            continue
        res = json.loads(p.read_text())
        dings = surface_dings(recs[cert], topleft)
        for side in SIDES:
            sides.append({"cert": cert, "key": recs[cert]["group_key"], "side": side,
                          "view": side_view(res["sides"][side]), "raw": res["sides"][side],
                          "dings": [d for d in dings if d["side"] == side]})
    return sides, missing


def timing(sides: list) -> dict:
    out = {}
    for k in ("total", "scan", "quality", "check", "findMarks"):
        v = [s["raw"]["timing_ms"][k] for s in sides if s["raw"].get("timing_ms")]
        if v:
            out[k] = {"median": float(np.median(v)), "mean": float(np.mean(v)), "p90": float(np.percentile(v, 90)),
                      "max": float(np.max(v))}
    return out


def group_tables(sides: list, key_index: dict, D: np.ndarray, ca_exclude: bool = True) -> dict:
    out = {}
    for g in GROUPS:
        u = units(sides, g, ca_exclude)
        out[g] = {"cell": metric_block(u["cell"], key_index, D), "side": metric_block(u["side"], key_index, D),
                  "counts": u["counts"]}
    return out


def arm_report(sides: list, key_index: dict, D: np.ndarray) -> dict:
    rep = {"sides": len(sides), "status": {}}
    for s in sides:
        rep["status"][s["view"]["status"]] = rep["status"].get(s["view"]["status"], 0) + 1
    rep["groups"] = group_tables(sides, key_index, D)
    # group independent: candidates per clean side, share of cells that can't be assessed
    clean = [s for s in sides if not s["dings"] and s["view"]["status"] == "ok"]
    k = np.array([key_index[s["key"]] for s in clean], int)
    rep["mean_candidates_per_clean_side"] = ratio_block(np.array([s["view"]["n_cands"] for s in clean], float),
                                                        np.ones(len(clean)), k, D)
    k = np.array([key_index[s["key"]] for s in sides], int)
    ca = np.array([9 if s["view"]["status"] != "ok" else sum(s["view"]["ca_excluded"].values()) for s in sides], float)
    rep["share_cells_cannot_assess"] = ratio_block(ca, np.full(len(sides), 9.0), k, D)
    rep["timing_ms_per_side"] = timing(sides)
    return rep


# ---------------------------------------------------------------- diagnostics (labels; run on the tuning split only)

LOC_MAPS = {
    "identity": lambda c: c,
    "lr": lambda c: c.replace("left", "@").replace("right", "left").replace("@", "right"),
    "tb": lambda c: c.replace("top", "@").replace("bottom", "top").replace("@", "bottom"),
    "rot180": lambda c: LOC_MAPS["lr"](LOC_MAPS["tb"](c)),
}


def label_summary(certs: list, recs: dict) -> dict:
    by_type, by_loc, by_group_loc = {}, {}, {}
    for c in certs:
        for d in surface_dings(recs[c], "cell"):
            loc = d["location"] or "''"
            by_type.setdefault(d["type"], {}).setdefault(loc, 0)
            by_type[d["type"]][loc] += 1
            by_loc[loc] = by_loc.get(loc, 0) + 1
            gl = by_group_loc.setdefault(d["group"], {})
            gl[loc] = gl.get(loc, 0) + 1
    return {"surface_dings": sum(by_loc.values()), "by_location": dict(sorted(by_loc.items(), key=lambda x: -x[1])),
            "by_group_location": by_group_loc,
            "by_type": {t: dict(sorted(v.items(), key=lambda x: -x[1])) for t, v in sorted(by_type.items(), key=lambda x: -sum(x[1].values()))}}


def diagnostics(sides: list, ca_exclude: bool = False) -> dict:
    """Grid orientation (does a mirrored / rotated reading of TAG's cells agree better with the candidates?) and the
    'topleft' question (do 'topleft' cells look like real locations?). Cell AUC vs clean cells, 'all' group,
    'topleft' taken literally; per face. Cells under cannotAssess regions are kept unless ca_exclude (the texture
    regions often cover most of the card, which would leave nothing to compare)."""
    def usable(s, c):
        return not (ca_exclude and s["view"]["ca_excluded"][c])

    out = {"orientation": {}, "topleft": {}}
    for face in SIDES:
        fs = [s for s in sides if s["side"] == face and s["view"]["status"] == "ok"]
        clean = [s["view"]["cell_score"][c] for s in fs if not s["dings"] for c in CELLS if usable(s, c)]
        for name, f in LOC_MAPS.items():
            pos = [s["view"]["cell_score"][f(c)] for s in fs
                   for c in {d["location"] for d in s["dings"] if d["location"] in CELLS and d["location"] != "topleft"}
                   if usable(s, f(c))]
            out["orientation"].setdefault(name, {})[face] = {"positive_cells": len(pos), "auc": auc(pos, clean),
                                                             "recall_any": sum(v > 0 for v in pos) / len(pos) if pos else None}
        # 'topleft' DING cells vs other located DING cells vs clean topleft cells
        tl_clean = [s["view"]["cell_score"]["topleft"] for s in fs if not s["dings"] and usable(s, "topleft")]
        for nm, sel in (("topleft_playwear", lambda d: d["location"] == "topleft" and d["type"] == "play wear"),
                        ("topleft_other_types", lambda d: d["location"] == "topleft" and d["type"] != "play wear"),
                        ("other_cells", lambda d: d["location"] in CELLS and d["location"] != "topleft")):
            pos = []
            for s in fs:
                for c in {d["location"] for d in s["dings"] if sel(d)}:
                    if usable(s, c):
                        pos.append(s["view"]["cell_score"][c])
            out["topleft"].setdefault(nm, {})[face] = {"cells": len(pos), "auc_vs_clean_same_cell" if nm != "other_cells" else "auc_vs_clean": auc(pos, tl_clean if nm != "other_cells" else clean),
                                                       "recall_any": sum(v > 0 for v in pos) / len(pos) if pos else None}
        out["topleft"].setdefault("clean_topleft_flag_rate", {})[face] = sum(v > 0 for v in tl_clean) / len(tl_clean) if tl_clean else None
        out["topleft"].setdefault("clean_any_cell_flag_rate", {})[face] = sum(v > 0 for v in clean) / len(clean) if clean else None
    return out


def cmd_score(a):
    root, out = Path(a.root), Path(a.out)
    recs, sealed = records(root)
    try:
        certs = load_certs(a.certs, recs, sealed)
    except SealedCert as e:
        sys.exit(str(e))
    cfg_path = out / "config.json"
    cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else None
    arms = [x for x in a.arms.split(",") if (out / x).is_dir()]
    keys = sorted({recs[c]["group_key"] for c in certs})
    key_index = {k: i for i, k in enumerate(keys)}
    D = draws(len(keys), a.boot)
    report = {"split": a.split or Path(a.certs).stem, "certs": len(certs), "group_keys": len(keys),
              "out": str(out.resolve()), "certs_file": str(Path(a.certs).resolve()),
              "bootstrap": {"resamples": a.boot, "seed": SEED, "unit": "group_key"},
              "primary_topleft_policy": a.topleft, "run_config": cfg,
              "score_code": {"repo_commit": git(REPO, "rev-parse", "HEAD"), "repo_dirty": bool(git(REPO, "status", "--porcelain")),
                             "surfeval_sha256": sha256(Path(__file__))}, "labels": label_summary(certs, recs), "arms": {}}
    policies = [a.topleft] + [p for p in TOPLEFT_POLICIES if p != a.topleft]
    for arm in arms:
        arep = {}
        for pol in policies:
            sides, missing = load_sides(out, arm, certs, recs, pol)
            r = arm_report(sides, key_index, D)
            r["certs_missing_results"] = len(missing)
            if pol == a.topleft:
                arep.update(r)
                arep["diagnostics"] = diagnostics(sides)
                # comparison only: cells under cannotAssess regions kept (the protocol excludes them)
                arep["groups_cannot_assess_kept"] = group_tables(sides, key_index, D, ca_exclude=False)
            else:  # comparison: only the group tables
                arep[f"groups_topleft_{pol}"] = r["groups"]
        report["arms"][arm] = arep
    report = rnd(report)
    text = json.dumps(report, indent=1)
    Path(a.report).write_text(text)
    print(summary_table(report))
    print(f"\nwrote {a.report}")


def summary_table(rep: dict) -> str:
    f = lambda v: "  -  " if v is None else f"{v:.3f}"
    c = lambda v: "" if not v else f" [{v[0]:.2f},{v[1]:.2f}]"
    lines = [f"split {rep['split']}: {rep['certs']} certs, {rep['group_keys']} group keys; topleft policy {rep['primary_topleft_policy']}",
             f"{'arm':4} {'group':17} {'unit':5} {'pos':>5} {'clean':>6}  {'AUC [95% CI]':22} {'recall@10%FP [95% CI]':24} {'clean flagged':14}"]
    for arm, ar in rep["arms"].items():
        for g, gr in ar["groups"].items():
            for unit in ("cell", "side"):
                m = gr[unit]
                lines.append(f"{arm:4} {g:17} {unit:5} {m['positive']:5d} {m['clean']:6d}  {f(m['auc']) + c(m.get('auc_ci95')):22} "
                             f"{f(m['recall_at_10fp']) + c(m.get('recall_at_10fp_ci95')):24} {f(m['flag_rate_clean'])}")
        for g, gr in ar.get("groups_cannot_assess_kept", {}).items():
            m = gr["cell"]
            lines.append(f"{arm:4} {g:17} {'cell*':5} {m['positive']:5d} {m['clean']:6d}  {f(m['auc']) + c(m.get('auc_ci95')):22} "
                         f"{f(m['recall_at_10fp']) + c(m.get('recall_at_10fp_ci95')):24} {f(m['flag_rate_clean'])}   (* cannot-assess cells kept)")
        mc, ca = ar["mean_candidates_per_clean_side"], ar["share_cells_cannot_assess"]
        t = ar["timing_ms_per_side"].get("total", {})
        tf = ar["timing_ms_per_side"].get("findMarks", {})
        lines.append(f"{arm:4} candidates/clean side {f(mc['value'])}{c(mc['ci95'])}; cells cannot-assess {f(ca['value'])}{c(ca['ci95'])}; "
                     f"status {ar['status']}; ms/side total median {t.get('median')} p90 {t.get('p90')}, findMarks median {tf.get('median')} p90 {tf.get('p90')}")
    return "\n".join(lines)


# ---------------------------------------------------------------- paired comparison of two runs

def paired_metric(rows_a: list, rows_b: list, key_index: dict, D: np.ndarray, m: int) -> dict:
    """Metric m (0 AUC, 1 recall at <= FPR, 2 share of clean flagged) of runs a and b and of b - a, with a paired
    bootstrap: every resample draws the same group keys for both runs."""
    pa, pb = Prepared(rows_a, key_index), Prepared(rows_b, key_index)
    va, vb = pa.metrics(np.ones(len(rows_a)))[m], pb.metrics(np.ones(len(rows_b)))[m]
    diffs, wins = [], 0
    for d in D:
        x, y = pa.metrics(d[pa.k].astype(float))[m], pb.metrics(d[pb.k].astype(float))[m]
        if x is not None and y is not None:
            diffs.append(y - x)
            wins += y > x
    return {"base": va, "tuned": vb, "diff": None if va is None or vb is None else vb - va, "diff_ci95": ci(diffs),
            "share_resamples_tuned_better": wins / len(diffs) if diffs else None}


def paired_ratio(a: tuple, b: tuple, D: np.ndarray) -> dict:
    """a, b: (num, den, k) arrays as ratio_block; difference b - a with a paired bootstrap."""
    def val(t, w):
        num, den, k = t
        ww = w[k] if w is not None else np.ones(len(k))
        dd = (ww * den).sum()
        return float((ww * num).sum() / dd) if dd > 0 else None
    va, vb = val(a, None), val(b, None)
    diffs, lower = [], 0
    for d in D:
        x, y = val(a, d), val(b, d)
        if x is not None and y is not None:
            diffs.append(y - x)
            lower += y < x
    return {"base": va, "tuned": vb, "diff": None if va is None or vb is None else vb - va, "diff_ci95": ci(diffs),
            "share_resamples_tuned_lower": lower / len(diffs) if diffs else None}


def ratio_arrays(sides: list, key_index: dict, what: str) -> tuple:
    if what == "candidates_per_clean_side":
        clean = [s for s in sides if not s["dings"] and s["view"]["status"] == "ok"]
        return (np.array([s["view"]["n_cands"] for s in clean], float), np.ones(len(clean)),
                np.array([key_index[s["key"]] for s in clean], int))
    if what == "share_clean_sides_flagged":
        clean = [s for s in sides if not s["dings"] and s["view"]["status"] == "ok"]
        return (np.array([s["view"]["n_cands"] > 0 for s in clean], float), np.ones(len(clean)),
                np.array([key_index[s["key"]] for s in clean], int))
    ca = np.array([9 if s["view"]["status"] != "ok" else sum(s["view"]["ca_excluded"].values()) for s in sides], float)
    return ca, np.full(len(sides), 9.0), np.array([key_index[s["key"]] for s in sides], int)


def cmd_compare(a):
    """Paired, card-grouped bootstrap comparison of two runs (BASE and TUNED score reports, or --base-out /
    --tuned-out result directories) on the same cert list."""
    root = Path(a.root)
    recs, sealed = records(root)
    try:
        certs = load_certs(a.certs, recs, sealed)
    except SealedCert as e:
        sys.exit(str(e))
    reps = [json.loads(Path(p).read_text()) for p in (a.base, a.tuned)]
    outs = []
    for rep, override, name in ((reps[0], a.base_out, "base"), (reps[1], a.tuned_out, "tuned")):
        o = override or rep.get("out")
        if not o:
            sys.exit(f"the {name} report doesn't name its results directory: pass --{name}-out")
        if rep.get("certs") != len(certs):
            sys.exit(f"the {name} report was scored on {rep.get('certs')} certs, --certs lists {len(certs)}")
        outs.append(Path(o))
    arm_a, _, arm_b = a.pair.partition(":")
    arm_b = arm_b or arm_a
    keys = sorted({recs[c]["group_key"] for c in certs})
    key_index = {k: i for i, k in enumerate(keys)}
    D = draws(len(keys), a.boot)
    sa, miss_a = load_sides(outs[0], arm_a, certs, recs, a.topleft)
    sb, miss_b = load_sides(outs[1], arm_b, certs, recs, a.topleft)
    if miss_a or miss_b:
        sys.exit(f"missing results: base {len(miss_a)}, tuned {len(miss_b)} cert(s) (e.g. {(miss_a + miss_b)[0]})")
    rep = {"split": a.split or Path(a.certs).stem, "certs": len(certs), "group_keys": len(keys),
           "base": {"report": str(Path(a.base).resolve()), "out": str(outs[0]), "arm": arm_a,
                    "surface_js_sha256": (reps[0].get("run_config") or {}).get("surface_js_sha256")},
           "tuned": {"report": str(Path(a.tuned).resolve()), "out": str(outs[1]), "arm": arm_b,
                     "surface_js_sha256": (reps[1].get("run_config") or {}).get("surface_js_sha256")},
           "bootstrap": {"resamples": a.boot, "seed": SEED, "unit": "group_key", "paired": True},
           "topleft_policy": a.topleft, "groups": {}}
    for g in GROUPS:
        ua, ub = units(sa, g), units(sb, g)
        ka, kb = units(sa, g, ca_exclude=False), units(sb, g, ca_exclude=False)
        rep["groups"][g] = {
            "side_auc": paired_metric(ua["side"], ub["side"], key_index, D, 0),
            "side_recall_at_10fp": paired_metric(ua["side"], ub["side"], key_index, D, 1),
            "side_flag_rate_clean": paired_metric(ua["side"], ub["side"], key_index, D, 2),
            "cell_auc": paired_metric(ua["cell"], ub["cell"], key_index, D, 0),
            "cell_auc_cannot_assess_kept": paired_metric(ka["cell"], kb["cell"], key_index, D, 0),
            "side_units": {"base": [len(ua["side"]), sum(r[1] for r in ua["side"])],
                           "tuned": [len(ub["side"]), sum(r[1] for r in ub["side"])]},
        }
    for what in ("candidates_per_clean_side", "share_clean_sides_flagged", "share_cells_cannot_assess"):
        rep[what] = paired_ratio(ratio_arrays(sa, key_index, what), ratio_arrays(sb, key_index, what), D)
    rep = rnd(rep)
    Path(a.report).write_text(json.dumps(rep, indent=1))
    print(compare_table(rep))
    print(f"\nwrote {a.report}")


def compare_table(rep: dict) -> str:
    f = lambda v: "  -   " if v is None else f"{v:+.3f}" if isinstance(v, float) and v < 0 else f"{v:.3f}"
    c = lambda v: "" if not v else f" [{v[0]:+.3f},{v[1]:+.3f}]"
    lines = [f"paired comparison on {rep['split']}: {rep['certs']} certs, {rep['group_keys']} group keys; "
             f"base {rep['base']['arm']} vs tuned {rep['tuned']['arm']}; topleft policy {rep['topleft_policy']}",
             f"{'group':17} {'metric':28} {'base':>7} {'tuned':>7}  {'tuned - base [95% CI, paired]'}"]
    for g, gr in rep["groups"].items():
        for m in ("side_auc", "side_recall_at_10fp", "side_flag_rate_clean", "cell_auc", "cell_auc_cannot_assess_kept"):
            v = gr[m]
            lines.append(f"{g:17} {m:28} {f(v['base']):>7} {f(v['tuned']):>7}  {f(v['diff'])}{c(v['diff_ci95'])}")
    for m in ("candidates_per_clean_side", "share_clean_sides_flagged", "share_cells_cannot_assess"):
        v = rep[m]
        lines.append(f"{'':17} {m:28} {f(v['base']):>7} {f(v['tuned']):>7}  {f(v['diff'])}{c(v['diff_ci95'])}")
    return "\n".join(lines)


# ---------------------------------------------------------------- running the arms

def sha256(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def git(repo: Path, *args) -> str:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True).stdout.strip()


def load_arm_image(img: np.ndarray, max_side: int) -> np.ndarray:
    """As scripts/photo_grade.py load(): downsize to max_side on the long side with INTER_AREA (0 = full size)."""
    import cv2
    s = min(1.0, max_side / max(img.shape[:2])) if max_side > 0 else 1.0
    return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img


def run_node(images: dict, scale: float, surface: Path, tmp: Path, node: str = "node", mode: str = "full",
             cached: dict = None) -> list:
    """images: {side: BGR photo} (mode full / cache) or {side: RGBA warp} (mode marks, with cached[side] = the
    runner's `cache` output for that side). Mode cache adds each side's `cache` and `warp` (RGBA array)."""
    import cv2
    jobs = []
    for side, img in images.items():
        p = tmp / f"{side}.rgba"
        p.write_bytes((img if mode == "marks" else cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)).tobytes())
        j = {"side": side, "path": str(p), "width": int(img.shape[1]), "height": int(img.shape[0]), "scale": scale}
        if mode == "cache":
            j["warp_out"] = str(tmp / f"{side}.warp.rgba")
        if mode == "marks":
            j["cached"] = cached[side]
        jobs.append(j)
    cfg = {"vision": str(SRC / "vision.js"), "inspect": str(SRC / "inspect.js"), "surface": str(surface), "mode": mode,
           "jobs": jobs}
    try:
        p = subprocess.run([node, "--max-old-space-size=4096", str(RUNNER)], input=json.dumps(cfg),
                           capture_output=True, text=True)
        if p.returncode:
            raise RuntimeError(f"node failed ({p.returncode}): {(p.stderr or p.stdout)[-400:]}")
        res = json.loads(p.stdout)
        if mode == "cache":
            for r, j in zip(res, jobs):
                if r.get("status") != "error":
                    w, h = r["cache"]["scan"]["width"], r["cache"]["scan"]["height"]
                    r["warp"] = np.frombuffer(Path(j["warp_out"]).read_bytes(), np.uint8).reshape(h, w, 4)
        return res
    finally:
        for j in jobs:
            Path(j["path"]).unlink(missing_ok=True)
            if j.get("warp_out"):
                Path(j["warp_out"]).unlink(missing_ok=True)


def run_one(cert: str, rec: dict, a) -> tuple:
    import cv2
    from tagprep import prep
    out = Path(a.out)
    todo = [arm for arm in a.arms if not (out / arm / cert / "marks.json").exists()]
    if not todo:
        return cert, "skipped"
    check_record(rec)
    if a.from_cache:
        return run_one_cached(cert, todo, a)
    tmp = Path(tempfile.mkdtemp(prefix=f"surfeval_{cert}_", dir=a.tmp))
    try:
        t0 = time.time()
        prepped = {}
        for side in SIDES:
            img = cv2.imread(str(Path(a.root) / rec["images"][side]["path"]), cv2.IMREAD_COLOR)
            if img is None:
                return cert, f"no {side} image"
            prepped[side] = prep(img)
        prep_ms = round((time.time() - t0) * 1000)
        for arm in todo:
            cfg = ARMS[arm]
            res = run_node({s: load_arm_image(prepped[s], cfg["max_side"]) for s in SIDES}, cfg["scale"],
                           Path(a.surface), tmp)
            write_marks(out, arm, cert, res, prep_ms)
        return cert, "ok " + " ".join(f"{arm}:" + ",".join(f"{s}={doc_status(out, arm, cert, s)}" for s in SIDES) for arm in todo)
    except Exception as e:  # noqa: BLE001 - report and carry on with the other certs
        return cert, f"failed: {e}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def write_marks(out: Path, arm: str, cert: str, res: list, prep_ms) -> None:
    o = out / arm / cert
    o.mkdir(parents=True, exist_ok=True)
    doc = {"cert": cert, "arm": arm, "prep_ms": prep_ms, "sides": {r["side"]: r for r in res}}
    part = o / "marks.json.part"
    part.write_text(json.dumps(doc))
    os.replace(part, o / "marks.json")


def run_one_cached(cert: str, todo: list, a) -> tuple:
    """findMarks only, on the cached warp + scan / quality / check of each side (see `cache`)."""
    import cv2
    out, cdir = Path(a.out), Path(a.from_cache)
    tmp = Path(tempfile.mkdtemp(prefix=f"surfeval_{cert}_", dir=a.tmp))
    try:
        for arm in todo:
            d = cdir / arm / cert
            if not (d / "meta.json").exists():
                return cert, f"not cached ({arm})"
            meta = json.loads((d / "meta.json").read_text())
            if meta["cert"] != cert or meta["arm"] != arm:
                return cert, f"cache mismatch ({arm})"
            ok = {s: v for s, v in meta["sides"].items() if v.get("status") != "error"}
            images = {}
            for side in ok:
                bgra = cv2.imread(str(d / f"{side}.png"), cv2.IMREAD_UNCHANGED)
                images[side] = cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA)
            res = run_node(images, ARMS[arm]["scale"], Path(a.surface), tmp, mode="marks",
                           cached={s: v["cache"] for s, v in ok.items()}) if images else []
            res += [{"side": s, "status": "error", "error": v.get("error")} for s, v in meta["sides"].items() if s not in ok]
            write_marks(out, arm, cert, sorted(res, key=lambda r: SIDES.index(r["side"])), meta.get("prep_ms"))
        return cert, "ok " + " ".join(f"{arm}:" + ",".join(f"{s}={doc_status(out, arm, cert, s)}" for s in SIDES) for arm in todo)
    except Exception as e:  # noqa: BLE001 - report and carry on with the other certs
        return cert, f"failed: {e}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cache_one(cert: str, rec: dict, a) -> tuple:
    """Vision.scan / Inspect once per side and arm: OUT_CACHE/<arm>/<cert>/{front,back}.png (the flattened card,
    RGBA, lossless) + meta.json ({side: {status, cache: {scan without pixels, quality, check, timing_ms, input}}}).
    With --out, the full-path marks of --surface are written there too (as `run`)."""
    import cv2
    from tagprep import prep
    cdir = Path(a.cache)
    todo = [arm for arm in a.arms if not (cdir / arm / cert / "meta.json").exists()]
    if not todo:
        return cert, "skipped"
    check_record(rec)
    tmp = Path(tempfile.mkdtemp(prefix=f"surfcache_{cert}_", dir=a.tmp))
    try:
        t0 = time.time()
        prepped = {}
        for side in SIDES:
            img = cv2.imread(str(Path(a.root) / rec["images"][side]["path"]), cv2.IMREAD_COLOR)
            if img is None:
                return cert, f"no {side} image"
            prepped[side] = prep(img)
        prep_ms = round((time.time() - t0) * 1000)
        for arm in todo:
            cfg = ARMS[arm]
            res = run_node({s: load_arm_image(prepped[s], cfg["max_side"]) for s in SIDES}, cfg["scale"],
                           Path(a.surface), tmp, mode="cache")
            d = cdir / arm / cert
            d.mkdir(parents=True, exist_ok=True)
            meta = {"cert": cert, "arm": arm, "prep_ms": prep_ms, "sides": {}}
            for r in res:
                if r.get("status") == "error":
                    meta["sides"][r["side"]] = {"status": "error", "error": r.get("error")}
                    continue
                cv2.imwrite(str(d / f"{r['side']}.png"), cv2.cvtColor(r.pop("warp"), cv2.COLOR_RGBA2BGRA),
                            [cv2.IMWRITE_PNG_COMPRESSION, 3])
                meta["sides"][r["side"]] = {"status": r["status"], "cache": r.pop("cache")}
            if a.out:
                write_marks(Path(a.out), arm, cert, res, prep_ms)
            part = d / "meta.json.part"
            part.write_text(json.dumps(meta))
            os.replace(part, d / "meta.json")
        return cert, "cached " + ",".join(todo)
    except Exception as e:  # noqa: BLE001
        return cert, f"failed: {e}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def doc_status(out: Path, arm: str, cert: str, side: str) -> str:
    s = json.loads((out / arm / cert / "marks.json").read_text())["sides"][side]
    return f"{s['status']}/{len(s.get('candidates') or [])}"


def write_config(a, n_certs: int) -> None:
    out = Path(a.out)
    surface = Path(a.surface).resolve()
    cfg = {"split": a.split or Path(a.certs).stem, "certs": n_certs, "arms": ARMS,
           "repo_commit": git(REPO, "rev-parse", "HEAD"), "repo_dirty": bool(git(REPO, "status", "--porcelain")),
           "surface_js": str(surface), "surface_js_sha256": sha256(surface),
           "vision_js_sha256": sha256(SRC / "vision.js"), "inspect_js_sha256": sha256(SRC / "inspect.js"),
           "runner_sha256": sha256(RUNNER), "surfeval_sha256": sha256(Path(__file__)),
           "node": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip(),
           "findMarks_options": {"revision": 1, "defaults": "module (maxCandidates 12, timeBudgetMs 1500, analysisMaxSide 1100)"},
           "from_cache": str(Path(a.from_cache).resolve()) if getattr(a, "from_cache", None) else None}
    path = out / "config.json"
    if path.exists():
        old = json.loads(path.read_text())
        for k in ("surface_js_sha256", "vision_js_sha256", "inspect_js_sha256"):
            if old.get(k) != cfg[k] and any((out / arm).is_dir() and any((out / arm).iterdir()) for arm in ARMS):
                sys.exit(f"{path} was written with a different {k}; use a new --out instead of mixing results")
        cfg["arms"] = {**old.get("arms", {}), **cfg["arms"]}
        cfg["first_written"] = old.get("first_written", old.get("written"))
    cfg["written"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    out.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=1))


def cache_config() -> dict:
    return {"vision_js_sha256": sha256(SRC / "vision.js"), "inspect_js_sha256": sha256(SRC / "inspect.js"),
            "tagprep_sha256": sha256(HERE / "tagprep.py"), "arms": ARMS}


def check_cache(cdir: Path) -> None:
    """A cache made with other vision.js / inspect.js / tagprep.py would not be what a full run sees: refuse it."""
    p = cdir / "config.json"
    if not p.exists():
        sys.exit(f"{cdir} has no config.json: build it with `surfeval.py cache` first")
    old, cur = json.loads(p.read_text()), cache_config()
    for k in ("vision_js_sha256", "inspect_js_sha256", "tagprep_sha256"):
        if old.get(k) != cur[k]:
            sys.exit(f"{p} was made with a different {k}; rebuild the cache (a new --cache directory)")


def cmd_cache(a):
    root, cdir = Path(a.root), Path(a.cache)
    recs, sealed = records(root)
    try:
        certs = load_certs(a.certs, recs, sealed)
    except SealedCert as e:
        sys.exit(str(e))
    certs = certs[: a.limit or None]
    a.arms = a.arms.split(",")
    for arm in a.arms:
        if arm not in ARMS:
            sys.exit(f"unknown arm {arm!r}; arms are {', '.join(ARMS)}")
    a.surface = str(Path(a.surface).resolve())
    Path(a.tmp).mkdir(parents=True, exist_ok=True)
    cdir.mkdir(parents=True, exist_ok=True)
    if (cdir / "config.json").exists():
        check_cache(cdir)
    else:
        (cdir / "config.json").write_text(json.dumps({**cache_config(), "written": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                                      "repo_commit": git(REPO, "rev-parse", "HEAD")}, indent=1))
    if a.out:
        a.from_cache = None
        write_config(a, len(certs))
    with ThreadPoolExecutor(a.jobs) as ex:
        for cert, status in ex.map(lambda c: cache_one(c, recs[c], a), certs):
            print(cert, status, flush=True)


def cmd_run(a):
    root = Path(a.root)
    recs, sealed = records(root)
    try:
        certs = load_certs(a.certs, recs, sealed)
    except SealedCert as e:
        sys.exit(str(e))
    certs = certs[: a.limit or None]
    a.arms = a.arms.split(",")
    for arm in a.arms:
        if arm not in ARMS:
            sys.exit(f"unknown arm {arm!r}; arms are {', '.join(ARMS)}")
    a.surface = str(Path(a.surface).resolve())
    Path(a.tmp).mkdir(parents=True, exist_ok=True)
    if a.from_cache:
        check_cache(Path(a.from_cache))
    write_config(a, len(certs))
    with ThreadPoolExecutor(a.jobs) as ex:
        for cert, status in ex.map(lambda c: run_one(c, recs[c], a), certs):
            print(cert, status, flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("run", cmd_run), ("cache", cmd_cache), ("score", cmd_score)):
        s = sub.add_parser(name)
        s.add_argument("--root", required=True, help="TAG database directory (certs.jsonl, images/)")
        s.add_argument("--certs", required=True, help="cert list file (one cert per line); test-pool certs are refused")
        s.add_argument("--split", default="", help="name for the cert list (default: the file's stem)")
        s.add_argument("--out", required=name != "cache", default="",
                       help="results directory: OUT/<arm>/<cert>/marks.json, OUT/config.json"
                            + (" (optional for cache: also write the full-path marks of --surface there)" if name == "cache" else ""))
        s.add_argument("--arms", default="s1,s2")
        s.set_defaults(fn=fn)
        if name in ("run", "cache"):
            s.add_argument("--jobs", type=int, default=3)
            s.add_argument("--limit", type=int, default=0)
            s.add_argument("--surface", default=str(SRC / "surface.js"), help="surface.js to evaluate (default: the repo's)")
            s.add_argument("--tmp", default=tempfile.gettempdir(), help="where per-cert temp images go (deleted after)")
            if name == "run":
                s.add_argument("--from-cache", default="", metavar="CACHE",
                               help="re-run only findMarks on the warps / quality / check stored by `cache` in CACHE")
            else:
                s.add_argument("--cache", required=True, help="cache directory: CACHE/<arm>/<cert>/{front,back}.png, meta.json")
        else:
            s.add_argument("--report", required=True, help="score report JSON to write")
            s.add_argument("--boot", type=int, default=2000)
            s.add_argument("--topleft", choices=TOPLEFT_POLICIES, default="side",
                           help="'topleft' DINGs: side level only (default) or taken as the top-left cell")
    s = sub.add_parser("compare", help="paired, card-grouped bootstrap CIs of TUNED - BASE")
    s.add_argument("base", help="score report of the baseline run (its `out` names the results directory)")
    s.add_argument("tuned", help="score report of the tuned run")
    s.add_argument("--root", required=True, help="TAG database directory (certs.jsonl)")
    s.add_argument("--certs", required=True, help="the cert list both runs were scored on")
    s.add_argument("--split", default="")
    s.add_argument("--base-out", default="", help="results directory of the base run (default: the report's `out`)")
    s.add_argument("--tuned-out", default="", help="results directory of the tuned run (default: the report's `out`)")
    s.add_argument("--pair", default="s1", help="arms to compare, BASE_ARM[:TUNED_ARM] (default s1)")
    s.add_argument("--report", required=True, help="comparison report JSON to write")
    s.add_argument("--boot", type=int, default=2000)
    s.add_argument("--topleft", choices=TOPLEFT_POLICIES, default="side")
    s.set_defaults(fn=cmd_compare, out="")
    a = ap.parse_args(argv)
    for p in [a.out, a.root] + ([a.report] if a.cmd in ("score", "compare") else []) + ([a.cache] if a.cmd == "cache" else []) \
            + ([a.from_cache] if a.cmd == "run" and a.from_cache else []):
        if p and Path(p).resolve().is_relative_to(REPO):
            sys.exit(f"{p} must be outside the repository (TAG data and results stay out of the repo)")
    a.fn(a)


if __name__ == "__main__":
    main()
