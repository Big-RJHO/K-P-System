"""tools/tag/surfeval.py: TAG surface-DING labels, the 3 x 3 grid, the scoring math, refusal of sealed test certs,
and the node runner end to end. Synthetic data only (no TAG data is used or needed)."""

from __future__ import annotations

import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

from synthetic import make_card, place_on_background

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "tag"))
import resexp  # noqa: E402
import surfeval as se  # noqa: E402

NODE = shutil.which("node")


def rec(cert, dings, pool="dev", key=None, path_root="images"):
    return {"cert": cert, "pool": pool, "group_key": key or f"G-{cert}",
            "images": {s: {"path": f"{path_root}/{cert}/{s}.jpg"} for s in ("front", "back")},
            "tag": {"ding_list": dings}}


# ---------------------------------------------------------------- labels and grid

def test_surface_type_and_groups():
    assert se.surface_type("surface / ink defect") == "ink defect"
    assert se.surface_type("SURFACE / Wrinkle/Crease") == "wrinkle/crease"
    assert se.surface_type("surface /  scratch(es)") == "scratch(es)"
    assert se.surface_type("corner wear") is None
    assert se.surface_type("edge/corner / bend") is None
    assert se.surface_type("centering 44L/56R 49T/51B") is None
    assert se.type_group("ink defect") == "visible"
    assert se.type_group("surface defect") == "visible"
    for t in ("wrinkle/crease", "wrinkles/creases", "dent", "dents", "play wear"):
        assert se.type_group(t) == "not_visible_flat"
    assert se.type_group("tear") == "other"
    assert not set(se.TYPE_GROUPS["visible"]) & set(se.TYPE_GROUPS["not_visible_flat"])


def test_surface_dings_locations_and_topleft_policy():
    r = rec("C1", [
        {"side": "front", "location": "middlecenter", "type": "surface / scratch(es)"},
        {"side": "back", "location": "topleft", "type": "surface / dent"},
        {"side": "back", "location": "", "type": "surface / play wear"},
        {"side": "front", "location": "Bottom Right", "type": "surface / pit"},
        {"side": "front", "location": "weird", "type": "surface / tear"},
        {"side": "front", "location": "top", "type": "edge wear"},
        {"side": "front", "location": "card", "type": "centering 50L/50R 50T/50B"},
    ])
    side = se.surface_dings(r, "side")
    assert [(d["side"], d["cell"], d["group"]) for d in side] == [
        ("front", "middlecenter", "visible"), ("back", None, "not_visible_flat"), ("back", None, "not_visible_flat"),
        ("front", "bottomright", "visible"), ("front", None, "other")]
    cell = se.surface_dings(r, "cell")
    assert cell[1]["cell"] == "topleft" and cell[1]["location"] == "topleft"
    with pytest.raises(ValueError):
        se.surface_dings(r, "nope")


def test_grid_cells_and_boxes():
    assert se.CELLS == ("topleft", "topcenter", "topright", "middleleft", "middlecenter", "middleright",
                        "bottomleft", "bottomcenter", "bottomright")
    assert se.cell_of(0.0, 0.0) == "topleft"
    assert se.cell_of(0.5, 0.5) == "middlecenter"
    assert se.cell_of(0.99, 0.01) == "topright"   # x is across, y is down
    assert se.cell_of(0.01, 0.99) == "bottomleft"
    assert se.cell_of(1.0, 1.0) == "bottomright"
    assert se.cell_of(1 / 3, 0.2) == "topcenter"   # on a border: the right/lower cell
    assert se.cell_box("middleright") == pytest.approx((2 / 3, 1 / 3, 1, 2 / 3))
    for c in se.CELLS:
        x0, y0, x1, y1 = se.cell_box(c)
        assert se.cell_of((x0 + x1) / 2, (y0 + y1) / 2) == c


def test_cannot_assess_coverage():
    cov = se.ca_coverage([{"x": 0, "y": 0, "w": 1 / 3, "h": 1 / 6}])  # top half of the top-left cell
    assert cov["topleft"] == pytest.approx(0.5, abs=0.02)
    assert all(cov[c] == 0 for c in se.CELLS if c != "topleft")
    cov = se.ca_coverage([{"x": 0, "y": 0, "w": 1, "h": 1}])
    assert all(v == 1 for v in cov.values())
    # overlapping boxes count once (union)
    cov = se.ca_coverage([{"x": 0, "y": 0, "w": 0.2, "h": 1 / 3}, {"x": 0.1, "y": 0, "w": 0.2, "h": 1 / 3}])
    assert cov["topleft"] == pytest.approx(0.9, abs=0.02)
    v = se.side_view({"status": "ok", "candidates": [], "cannotAssess": [{"x": 0, "y": 0, "w": 1 / 3, "h": 0.2}]})
    assert v["ca_excluded"]["topleft"] and not v["ca_excluded"]["topcenter"]


# ---------------------------------------------------------------- scoring math

def cand(cx, cy, score):
    return {"x": cx - 0.01, "y": cy - 0.01, "w": 0.02, "h": 0.02, "score": score}


def side(key, dings, cands, status="ok", ca=()):
    return {"key": key, "side": "front", "dings": dings,
            "view": se.side_view({"status": status, "candidates": cands, "cannotAssess": list(ca)})}


def d(cell, group="visible", t="ink defect"):
    return {"side": "front", "cell": cell, "group": group, "type": t, "location": cell or ""}


def test_side_view_cell_score_is_max_in_cell():
    v = se.side_view({"status": "ok", "candidates": [cand(0.5, 0.5, 0.2), cand(0.55, 0.45, 0.7), cand(0.1, 0.9, 0.3)],
                      "cannotAssess": []})
    assert v["cell_score"]["middlecenter"] == 0.7
    assert v["cell_score"]["bottomleft"] == 0.3
    assert v["cell_score"]["topleft"] == 0.0
    assert v["side_score"] == 0.7 and v["n_cands"] == 3
    # a long candidate counts in the cell of its centre only
    v = se.side_view({"status": "ok", "candidates": [{"x": 0.0, "y": 0.5, "w": 0.9, "h": 0.01, "score": 0.4}],
                      "cannotAssess": []})
    assert v["cell_score"]["middlecenter"] == 0.4 and v["cell_score"]["middleleft"] == 0


def test_units_labels_and_exclusions():
    sides = [
        # side with a visible DING in middlecenter (found) and a not-visible DING at side level only
        side("A", [d("middlecenter"), d(None, "not_visible_flat", "play wear")], [cand(0.5, 0.5, 0.8), cand(0.1, 0.1, 0.3)]),
        # clean side with one candidate, one cell under cannotAssess
        side("B", [], [cand(0.9, 0.9, 0.4)], ca=[{"x": 0, "y": 0, "w": 1 / 3, "h": 1 / 3}]),
        # side with only a not_visible_flat DING located in topright
        side("C", [d("topright", "not_visible_flat", "dent")], []),
        # cannot_assess side
        side("D", [d("middlecenter")], [], status="cannot_assess"),
    ]
    u = se.units(sides, "visible")
    pos = [r for r in u["cell"] if r[1]]
    neg = [r for r in u["cell"] if not r[1]]
    assert pos == [("A", 1, 0.8)]
    assert len(neg) == 8 and all(k == "B" for k, _, _ in neg)
    assert sorted(s for _, _, s in neg) == [0.0] * 7 + [0.4]
    c = u["counts"]
    assert c["cells_total"] == 36 and c["cells_cannot_assess"] == 1 and c["cells_side_not_ok"] == 9
    assert c["cells_excluded_other_ding"] == 8 + 9          # rest of A, all of C (a DING of another group)
    assert c["cell_dings_unscorable"] == 1                   # D's DING
    assert u["side"] == [("A", 1, 0.8), ("B", 0, 0.4)]
    assert c["sides_not_ok"] == 1 and c["sides_excluded_other_ding"] == 1

    u = se.units(sides, "not_visible_flat")
    assert [r for r in u["cell"] if r[1]] == [("C", 1, 0.0)]
    assert sorted(r for r in u["side"] if r[1]) == [("A", 1, 0.8), ("C", 1, 0.0)]
    u = se.units(sides, "all")
    assert sorted(r for r in u["cell"] if r[1]) == [("A", 1, 0.8), ("C", 1, 0.0)]
    # cannot-assess cells kept (comparison tables)
    u = se.units(sides, "visible", ca_exclude=False)
    assert len([r for r in u["cell"] if not r[1]]) == 9 and u["counts"]["cells_cannot_assess"] == 0


def test_point_stats_auc_and_recall():
    rows = [("a", 1, 0.8), ("b", 1, 0.0), ("c", 0, 0.0), ("c", 0, 0.0), ("d", 0, 0.4), ("d", 0, 0.9)]
    s = se.point_stats(rows)
    # pairs (pos, neg): 0.8 beats 0,0,0.4 and loses to 0.9 -> 3; 0.0 ties two zeros -> 1; total 4 of 8
    assert s["auc"] == pytest.approx(4 / 8)
    assert s["positive"] == 2 and s["clean"] == 4
    assert s["flag_rate_clean"] == 0.5 and s["recall_any"] == 0.5
    # 10% FP of 4 clean units: no clean unit may be flagged -> threshold 0.9 -> nothing recalled
    assert s["recall_at_10fp"] == 0.0
    perfect = se.point_stats([("a", 1, 0.5), ("b", 0, 0.0), ("b", 0, 0.1)])
    assert perfect["auc"] == 1.0 and perfect["recall_at_10fp"] == 1.0


def test_weighted_bootstrap_metrics_match_resexp():
    rng = random.Random(5)
    for trial in range(30):
        rows = [(f"k{rng.randint(0, 9)}", int(rng.random() < 0.3), rng.choice([0.0, 0.0, 0.1, 0.25, 0.5, round(rng.random(), 2)]))
                for _ in range(rng.randint(5, 80))]
        keys = sorted({r[0] for r in rows})
        ki = {k: i for i, k in enumerate(keys)}
        p = se.Prepared(rows, ki)
        counts = np.array([rng.randint(0, 3) for _ in keys])
        w = counts[p.k].astype(float)
        dup = [r for r in rows for _ in range(counts[ki[r[0]]])]
        pos = [s for _, l, s in dup if l]
        neg = [s for _, l, s in dup if not l]
        a, rec10, flag = p.metrics(w)
        if pos and neg:
            assert a == pytest.approx(resexp.auc(pos, neg))
            assert rec10 == pytest.approx(resexp.recall_at_fpr(pos, neg, 0.10))
        else:
            assert a is None and rec10 is None
        if neg:
            assert flag == pytest.approx(sum(v > 0 for v in neg) / len(neg))


def test_bootstrap_is_grouped_and_seeded():
    D1, D2 = se.draws(7, 50), se.draws(7, 50)
    assert (D1 == D2).all() and D1.shape == (50, 7) and (D1.sum(axis=1) == 7).all()
    rows = [("a", 1, 0.9), ("a", 0, 0.1), ("b", 1, 0.2), ("b", 0, 0.3), ("c", 0, 0.0)]
    ki = {"a": 0, "b": 1, "c": 2}
    m = se.metric_block(rows, ki, se.draws(3, 300))
    assert m["auc"] == pytest.approx(resexp.auc([0.9, 0.2], [0.1, 0.3, 0.0]))
    lo, hi = m["auc_ci95"]
    assert 0 <= lo <= m["auc"] <= hi <= 1


# ---------------------------------------------------------------- sealed test pool

def write_db(root: Path, recs: list) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "certs.jsonl").write_text("".join(json.dumps(r) + "\n" for r in recs))


def test_refuses_test_pool_certs(tmp_path):
    root = tmp_path / "db"
    write_db(root, [rec("C1", []), rec("T1", [{"side": "front", "location": "topleft", "type": "surface / dent"}], pool="test",
                                      path_root="images_test")])
    recs, sealed = se.records(root)
    assert set(recs) == {"C1"} and sealed == {"T1"}       # test records are not kept at all
    lst = tmp_path / "certs.txt"
    lst.write_text("C1\nT1\n")
    with pytest.raises(se.SealedCert):
        se.load_certs(str(lst), recs, sealed)
    with pytest.raises(se.SealedCert):
        se.check_record(rec("X", [], pool="test"))
    with pytest.raises(se.SealedCert):
        se.check_record(rec("X", [], path_root="images_test"))
    for cmd in ("run", "score"):
        extra = ["--report", str(tmp_path / "r.json")] if cmd == "score" else []
        p = subprocess.run([sys.executable, "-I", str(ROOT / "tools/tag/surfeval.py"), cmd, "--root", str(root),
                            "--certs", str(lst), "--out", str(tmp_path / "out"), *extra], capture_output=True, text=True)
        assert p.returncode != 0 and "sealed test pool" in p.stderr
        assert not (tmp_path / "out").exists()


def test_refuses_output_inside_repo(tmp_path):
    root = tmp_path / "db"
    write_db(root, [rec("C1", [])])
    (tmp_path / "c.txt").write_text("C1\n")
    p = subprocess.run([sys.executable, "-I", str(ROOT / "tools/tag/surfeval.py"), "score", "--root", str(root),
                        "--certs", str(tmp_path / "c.txt"), "--out", str(ROOT / "nope"), "--report", str(tmp_path / "r.json")],
                       capture_output=True, text=True)
    assert p.returncode != 0 and "outside the repository" in p.stderr


# ---------------------------------------------------------------- runner end to end on a synthetic card

@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_runner_end_to_end(tmp_path):
    root = tmp_path / "db"
    card = make_card(40, 31, 44, 47, border_bgr=(40, 205, 245))
    cv2.rectangle(card, (230, 380), (450, 500), (70, 60, 150), -1)       # plain patch in the middle
    cv2.line(card, (250, 400), (420, 470), (225, 225, 225), 2)          # a scratch, centre in middlecenter
    for s, img in (("front", card), ("back", make_card(40, 40, 40, 40, border_bgr=(160, 90, 40), seed=4))):
        p = root / "images" / "C0000001" / f"{s}.jpg"
        p.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(p), place_on_background(img, angle=1.5), [cv2.IMWRITE_JPEG_QUALITY, 95])
    write_db(root, [rec("C0000001", [{"side": "front", "location": "middlecenter", "type": "surface / scratch(es)"},
                                    {"side": "front", "location": "", "type": "surface / play wear"}])])
    (tmp_path / "c.txt").write_text("C0000001\n")
    out, tmp = tmp_path / "out", tmp_path / "tmp"
    surface_copy = tmp_path / "alt" / "surface.js"                       # --surface: an alternative copy
    surface_copy.parent.mkdir()
    shutil.copy(ROOT / "standalone/src/surface.js", surface_copy)
    base = [sys.executable, "-I", str(ROOT / "tools/tag/surfeval.py")]
    args = ["--root", str(root), "--certs", str(tmp_path / "c.txt"), "--out", str(out)]
    p = subprocess.run(base + ["run", *args, "--arms", "s1", "--jobs", "1", "--tmp", str(tmp), "--surface", str(surface_copy)],
                       capture_output=True, text=True, timeout=300)
    assert p.returncode == 0, p.stderr
    assert "C0000001 ok" in p.stdout
    assert not any(tmp.iterdir())                                        # temp images deleted
    cfg = json.loads((out / "config.json").read_text())
    assert cfg["surface_js"] == str(surface_copy.resolve())
    assert cfg["surface_js_sha256"] == se.sha256(ROOT / "standalone/src/surface.js")
    assert len(cfg["repo_commit"]) == 40 and cfg["arms"]["s1"] == {"max_side": 2400, "scale": 1.0}
    doc = json.loads((out / "s1" / "C0000001" / "marks.json").read_text())
    for s in ("front", "back"):
        r = doc["sides"][s]
        assert r["status"] == "ok", r
        assert set(r["timing_ms"]) == {"scan", "quality", "check", "findMarks", "total"}
        assert r["scan"]["width"] == 750 + 2 * r["scan"]["margin"]
        for c in r["candidates"]:
            assert {"x", "y", "w", "h", "kind", "score", "detection", "method"} <= set(c)
            assert 0 <= c["x"] <= 1 and 0 <= c["y"] <= 1
    front = doc["sides"]["front"]["candidates"]
    assert any(se.cell_of(c["x"] + c["w"] / 2, c["y"] + c["h"] / 2) == "middlecenter" and c["kind"] == "line" for c in front)

    # restartable: a finished cert is skipped
    p = subprocess.run(base + ["run", *args, "--arms", "s1", "--jobs", "1", "--tmp", str(tmp), "--surface", str(surface_copy)],
                       capture_output=True, text=True, timeout=120)
    assert p.returncode == 0 and "C0000001 skipped" in p.stdout
    # a different surface.js into the same --out is refused
    surface_copy.write_text(surface_copy.read_text() + "\n// changed\n")
    p = subprocess.run(base + ["run", *args, "--arms", "s1", "--jobs", "1", "--tmp", str(tmp), "--surface", str(surface_copy)],
                       capture_output=True, text=True, timeout=120)
    assert p.returncode != 0 and "different surface_js_sha256" in p.stderr

    report = tmp_path / "report.json"
    p = subprocess.run(base + ["score", *args, "--report", str(report), "--boot", "50"], capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stderr
    rep = json.loads(report.read_text())
    arm = rep["arms"]["s1"]
    assert arm["status"] == {"ok": 2}
    vis = arm["groups_cannot_assess_kept"]["visible"]["cell"]
    assert vis["positive"] == 1 and vis["clean"] == 9                    # the back is clean, the front has DINGs
    assert arm["groups"]["all"]["side"]["positive"] == 1 and arm["groups"]["all"]["side"]["clean"] == 1
    assert arm["groups"]["not_visible_flat"]["side"]["positive"] == 1   # play wear '' counts at side level
    assert arm["groups"]["not_visible_flat"]["cell"]["positive"] == 0
    assert rep["labels"]["surface_dings"] == 2 and rep["run_config"]["surface_js_sha256"] == cfg["surface_js_sha256"]
