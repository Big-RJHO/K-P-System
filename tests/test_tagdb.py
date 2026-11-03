"""tools/tag/tagdb.py on small synthetic data (made-up reports and generated scans; no TAG data)."""
import csv
import hashlib
import importlib.util
import json
import sqlite3
from pathlib import Path

import cv2
import numpy as np
import pytest

REPO = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("tagdb", REPO / "tools" / "tag" / "tagdb.py")
tagdb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tagdb)


def scan(seed: int, noise: float = 0.0) -> np.ndarray:
    """A card-like image whose phash depends on seed; noise > 0 gives a near duplicate of the same seed."""
    rng = np.random.default_rng(seed)
    blocks = rng.integers(0, 255, (6, 4, 3), dtype=np.uint8)
    img = cv2.resize(blocks, (120, 168), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    if noise:
        img += np.random.default_rng(seed + 999).normal(0, noise, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8)


def report(cert, name, number, grade, set_line="BASE SET", japanese=False):
    lang = " JAPANESE" if japanese else ""
    return {"cert": cert, "score": None, "card_name": name, "year_line": f"1999 POKÉMON{lang} #{number}/102",
            "set_line": set_line, "variant": "", "grade": grade, "grade_label": "MINT",
            "corners": {"front": "1 DINGS", "back": "0 DINGS"}, "edges": {"front": "0 DINGS", "back": "0 DINGS"},
            "centering": {"front": "55L/45R 50T/50B", "back": "50L/50R 52T/48B"},
            "surface": {"front": "0 DINGS", "back": "2 DINGS"},
            "dings": {"corners": {"front": 1, "back": 0}, "edges": {"front": 0, "back": 0}, "surface": {"front": 0, "back": 2}},
            "ding_list": [{"side": "front", "location": "topleft", "type": "corner wear"},
                          {"side": "back", "location": "center", "type": "surface / scratch"},
                          {"side": "back", "location": "top", "type": "surface / dent"}],
            "graded_on": "1/2/2025", "source_url": f"https://example.test/card/{cert}",
            "fetched_at": "2026-11-01T00:00:00.000Z", "agent": "synthetic"}


def put_cert(root: Path, pool_dir: str, rep: dict, front: np.ndarray, back: np.ndarray, orig: Path | None = None):
    d = root / pool_dir / rep["cert"]
    d.mkdir(parents=True)
    text = f"synthetic report {rep['cert']}\nTAG SCORE\n{rep['grade']}\n"
    (d / "report.txt").write_text(text)
    (d / "report.json").write_text(json.dumps(rep))
    images = {}
    for side, img in (("front", front), ("back", back)):
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        data = buf.tobytes()
        (d / f"{side}.jpg").write_bytes(data)
        images[side] = {"url": f"https://img.example.test/{rep['cert']}_{side.upper()}_MAIN.jpg",
                        "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    (d / "fetch.json").write_text(json.dumps({
        "cert": rep["cert"], "source_url": rep["source_url"], "fetched_at": rep["fetched_at"], "agent": "synthetic",
        "report_txt_sha256": hashlib.sha256(text.encode()).hexdigest(), "parser": "tagparse.js", "images": images}))
    if orig is not None:
        (orig / rep["cert"]).mkdir(parents=True)
        (orig / rep["cert"] / "report.json").write_text(json.dumps(rep))


CARDS = [("PIKACHU", "58"), ("CHARIZARD", "4"), ("ABRA", "43"), ("KOFFING", "51"), ("BLASTOISE", "2"),
         ("VENUSAUR", "15"), ("MEWTWO", "10"), ("GENGAR", "5"), ("EEVEE", "51"), ("ZAPDOS", "16")]
BACK = scan(424242)  # every card shares one back design


@pytest.fixture
def db(tmp_path):
    root, orig = tmp_path / "tagdb", tmp_path / "orig"
    root.mkdir()
    orig.mkdir()
    dev = []
    for g, (name, num) in enumerate(CARDS):
        for k in range(2):
            cert = f"D{g:03d}{k:04d}"
            dev.append(cert)
            put_cert(root, "images", report(cert, name, num, 1 + (g + k) % 10, japanese=(g == 0)),
                     scan(100 + g, noise=3.0 * k), BACK, orig)
    (root / "dev_certs.txt").write_text("\n".join(dev + ["D9990000"]) + "\n")   # last one: listed, not fetched yet
    test = [f"T{g:03d}0000" for g in range(3)]
    for g, cert in enumerate(test):
        put_cert(root, "images_test", report(cert, f"TESTMON {g}", str(g + 1), 5 + g, set_line="JUNGLE"),
                 scan(500 + g), BACK)
    (root / "test_A_certs.txt").write_text("\n".join(test) + "\n")
    return root, orig


def run(*args):
    return tagdb.main([str(a) for a in args])


def build(root, orig):
    assert run("--root", root, "build", "--orig-reports", orig, "--jobs", 2) == 0
    return tagdb.load_records(root)


def test_build_records(db):
    root, orig = db
    recs = build(root, orig)
    assert [r["cert"] for r in recs] == sorted(r["cert"] for r in recs)
    assert len(recs) == 23 and {r["pool"] for r in recs} == {"dev", "test"}   # D9990000 has no report yet
    r = next(r for r in recs if r["cert"] == "D0000000")
    assert r["card_key"] == "PIKACHU|BASE SET|58" == r["group_key"]
    assert r["card"]["language"] == "japanese" and r["card"]["year"] == 1999
    assert r["tag"]["grade"] == 1 and len(r["tag"]["ding_list"]) == 3
    assert r["cache"] == {"present": True, "hash_ok": True}
    for side in ("front", "back"):
        im = r["images"][side]
        assert (im["width"], im["height"]) == (120, 168)
        assert len(im["phash"]) == 16 and im["path"] == f"images/D0000000/{side}.jpg"
        assert im["sha256"] == hashlib.sha256((root / im["path"]).read_bytes()).hexdigest()
    assert r["report_changed_on_refetch"] == []
    assert r["parser_version"].startswith("tagparse-1+")
    assert next(r for r in recs if r["pool"] == "test")["report_changed_on_refetch"] is None
    assert all(not tagdb.schema_errors(r) for r in recs)


def test_report_change_on_refetch_and_canonical_source(db):
    root, orig = db
    p = root / "images" / "D0010000" / "report.json"
    rep = json.loads(p.read_text())
    rep["grade"], rep["graded_on"] = 9, "2/2/2025"
    p.write_text(json.dumps(rep))
    r = next(r for r in build(root, orig) if r["cert"] == "D0010000")
    assert r["report_changed_on_refetch"] == ["grade", "graded_on"]
    assert r["tag"]["grade"] == 2   # the original report stays canonical


def test_failed_refetch_keeps_original_source(db):
    root, orig = db
    before = {r["cert"]: r for r in build(root, orig)}
    for cert, pool in (("D0070000", "images"), ("T0000000", "images_test")):
        d = root / pool / cert
        for f in ("front.jpg", "back.jpg"):
            (d / f).unlink()
        text = "OOPS! NOTHING WAS FOUND"
        (d / "report.txt").write_text(text)
        (d / "report.json").write_text(json.dumps({"cert": cert, "dings": {}, "ding_list": [],
                                                   "source_url": "https://example.test/404"}))
        (d / "fetch.json").write_text(json.dumps({"cert": cert, "source_url": "https://example.test/404", "images": {},
                                                  "report_txt_sha256": hashlib.sha256(text.encode()).hexdigest()}))
    after = {r["cert"]: r for r in build(root, orig)}
    for cert in ("D0070000", "T0000000"):
        a, b = after[cert], before[cert]
        assert a["refetch_error"] and a["source"] == b["source"] and a["tag"] == b["tag"] and a["images"] == b["images"]
        assert a["cache"]["present"] is False
    assert "grade" in after["D0070000"]["report_changed_on_refetch"]
    assert run("--root", root, "verify") == 0


def test_build_is_deterministic(db):
    root, orig = db
    build(root, orig)
    first = (root / "certs.jsonl").read_bytes()
    build(root, orig)   # re-run reuses cached phashes
    assert (root / "certs.jsonl").read_bytes() == first
    (root / "certs.jsonl").unlink()
    build(root, orig)   # from scratch
    assert (root / "certs.jsonl").read_bytes() == first


def test_missing_scans_are_partial_not_fatal(db):
    root, orig = db
    (root / "images" / "D0020000" / "front.jpg").unlink()   # never cached: hash known from fetch.json only
    first = {r["cert"]: r for r in build(root, orig)}
    (root / "images" / "D0020001" / "front.jpg").unlink()   # evicted after a build: measurements are kept
    recs = {r["cert"]: r for r in build(root, orig)}
    for cert in ("D0020000", "D0020001"):
        assert recs[cert]["cache"] == {"present": False, "hash_ok": None}
        assert recs[cert]["images"]["front"]["sha256"] and recs[cert]["images"]["front"]["bytes"]
    assert recs["D0020000"]["images"]["front"]["phash"] is None
    assert recs["D0020001"]["images"]["front"] == first["D0020001"]["images"]["front"]
    assert run("--root", root, "verify") == 0



def test_fetch_in_progress_is_not_measured(db):
    root, orig = db
    (root / "images_test" / "T0020000" / "fetch.json").unlink()   # collector still writing this one
    (root / "images" / "D0060000" / "fetch.json").unlink()
    recs = {r["cert"]: r for r in build(root, orig)}
    assert "T0020000" not in recs   # no original report for test certs: not recorded yet
    r = recs["D0060000"]   # dev: the original report is recorded, scans wait for fetch.json
    assert r["cache"] == {"present": False, "hash_ok": None} and r["images"]["front"]["sha256"] is None
    assert r["tag"]["grade"] == 7 and r["report_changed_on_refetch"] is None


def test_evicted_cache_keeps_stored_records(db):
    import shutil
    root, orig = db
    before = {r["cert"]: r for r in build(root, orig)}
    shutil.rmtree(root / "images_test" / "T0010000")   # report, fetch.json and scans all gone
    shutil.rmtree(root / "images" / "D0040000")
    after = {r["cert"]: r for r in build(root, orig)}
    assert set(after) == set(before)
    for c in ("T0010000", "D0040000"):
        assert after[c]["cache"] == {"present": False, "hash_ok": None}
        assert {k: v for k, v in after[c].items() if k != "cache"} == {k: v for k, v in before[c].items() if k != "cache"}
    assert run("--root", root, "verify") == 0


def test_excluded_certs_leave_the_store(db):
    root, orig = db
    assert "T0010000" in {r["cert"] for r in build(root, orig)}
    (root / "excluded.txt").write_text("# cert reason\nT0010000 same artwork as a dev card\n")
    recs = build(root, orig)   # excluded although its folder, its list entry and its old record are all still there
    assert "T0010000" not in {r["cert"] for r in recs} and len(recs) == 22
    assert run("--root", root, "split") == 0
    assert "T0010000" not in json.dumps(json.loads((root / "splits.json").read_text())["membership"])


def test_grouped_split_has_no_leakage(db):
    root, orig = db
    recs = build(root, orig)
    assert run("--root", root, "split", "--dry-run") == 0
    assert not (root / "splits.json").exists()
    assert run("--root", root, "split") == 0
    sp = json.loads((root / "splits.json").read_text())
    m = sp["membership"]
    assert sp["seed"] == 20261103 and sp["version"] == 1 and set(m) == {r["cert"] for r in recs}
    assert {m[c] for c in m if c.startswith("T")} == {"test"}
    assert {m[c] for c in m if c.startswith("D")} == {"dev-tune", "dev-check"}
    by_key = {}
    for r in recs:
        by_key.setdefault(r["card_key"], set()).add(m[r["cert"]])
    assert all(len(v) == 1 for v in by_key.values())
    check = sum(1 for k, v in sp["groups"].items() if v == "dev-check")
    assert check == 3 and len(sp["groups"]) == 10   # 30% of 10 groups
    lk = tagdb.leakage(recs, m)
    assert lk == {"card_keys": {}, "phash_pairs": []}
    # splits are made once
    assert run("--root", root, "split") == 2
    assert run("--root", root, "split", "--force") == 0
    sp2 = json.loads((root / "splits.json").read_text())
    assert sp2["version"] == 2 and sp2["membership"] == m   # same seed, same data: same split
    assert run("--root", root, "verify") == 0


def test_phash_near_duplicates(db):
    root, orig = db
    recs = build(root, orig)
    a, b = (next(r for r in recs if r["cert"] == c) for c in ("D0000000", "D0000001"))
    near = tagdb.hamming(a["images"]["front"]["phash"], b["images"]["front"]["phash"])
    far = tagdb.hamming(a["images"]["front"]["phash"], next(r for r in recs if r["cert"] == "D0050000")["images"]["front"]["phash"])
    assert near <= 4 < far
    # The same certs forced into different splits are reported as a near-duplicate pair.
    m = {r["cert"]: "dev-tune" for r in recs}
    m["D0000001"] = "dev-check"
    lk = tagdb.leakage(recs, m)
    assert any({p["a"], p["b"]} == {"D0000000/front", "D0000001/front"} for p in lk["phash_pairs"])
    assert "PIKACHU|BASE SET|58" in lk["card_keys"]
    # Shared card backs are not leaks by default, but are near duplicates when backs are compared.
    assert tagdb.leakage(recs, m, sides=("back",))["phash_pairs"]
    # Two different card_keys with near-duplicate fronts (a reprint) end up in one group.
    rec = json.loads(json.dumps(b))
    rec["cert"], rec["card_key"], rec["group_key"] = "D0000009", "PIKACHU|CELEBRATIONS|58", "PIKACHU|CELEBRATIONS|58"
    comp = tagdb.dev_components(recs + [rec])
    assert comp["PIKACHU|CELEBRATIONS|58"] == comp["PIKACHU|BASE SET|58"]
    sp = tagdb.make_split(recs + [rec])
    assert sp["membership"]["D0000009"] == sp["membership"]["D0000000"]
    assert ["PIKACHU|BASE SET|58", "PIKACHU|CELEBRATIONS|58"] in sp["merged_groups"]


def test_split_refuses_cross_pool_near_duplicate(db, tmp_path):
    root, orig = db
    put_cert(root, "images_test", report("T0090000", "OTHERMON", "77", 6, set_line="FOSSIL"), scan(103, noise=2.0), BACK)
    build(root, orig)
    assert run("--root", root, "split", "--dry-run") == 1   # test scan near-duplicates a dev scan


def test_verify_catches_hash_mismatch(db):
    root, orig = db
    build(root, orig)
    assert run("--root", root, "verify") == 0
    img = scan(777)
    ok, buf = cv2.imencode(".jpg", img)
    (root / "images" / "D0030000" / "front.jpg").write_bytes(buf.tobytes())
    assert run("--root", root, "verify") == 1
    # a rebuild records the mismatch in the cache status, and verify still fails
    r = next(r for r in build(root, orig) if r["cert"] == "D0030000")
    assert r["cache"]["hash_ok"] is False and r["images"]["front"]["phash"]
    assert run("--root", root, "verify") == 1


def test_verify_catches_schema_error(db):
    root, orig = db
    build(root, orig)
    lines = (root / "certs.jsonl").read_text().splitlines()
    rec = json.loads(lines[0])
    del rec["tag"]["grade"]
    lines[0] = json.dumps(rec)
    (root / "certs.jsonl").write_text("\n".join(lines) + "\n")
    assert run("--root", root, "verify") == 1


def test_views_row_counts(db):
    root, orig = db
    recs = build(root, orig)
    assert run("--root", root, "split") == 0
    assert run("--root", root, "views") == 0
    con = sqlite3.connect(root / "views" / "tag.sqlite")
    n = lambda q: con.execute(q).fetchone()[0]
    assert n("SELECT COUNT(*) FROM certs") == len(recs) == 23
    assert n("SELECT COUNT(*) FROM images") == 2 * len(recs)
    assert n("SELECT COUNT(*) FROM dings") == 3 * len(recs)
    assert n("SELECT COUNT(*) FROM splits") == len(recs)
    assert n("SELECT COUNT(*) FROM certs WHERE split='test'") == 3
    con.close()
    rows = list(csv.DictReader(open(root / "views" / "certs.csv", encoding="utf-8")))
    assert len(rows) == len(recs)
    row = next(r for r in rows if r["cert"] == "D0000000")
    assert row["corner_dings"] == "1" and row["surface_dings"] == "2" and row["edge_dings"] == "0"
    assert row["image_cache"] == "ok" and row["split"] in ("dev-tune", "dev-check")
    assert row["centering_front"] == "55L/45R 50T/50B" and "corner wear" in row["ding_list"]


def test_status_and_requests_log(db, capsys):
    root, orig = db
    build(root, orig)
    log = root / "requests.log"
    log.write_text("2026-11-03T13:00:00.000Z\ta\tu1\n2026-11-03T13:00:05.400Z\tb\tu2\n2026-11-03T13:00:09.900Z\ta\tu3\n")
    capsys.readouterr()
    assert run("--root", root, "status", "--requests-log", log) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["by_pool"] == {"dev": 20, "test": 3} and out["listed_without_report"] == {"dev": 1}
    assert out["requests_log"]["min_gap_s"] == 4.5 and out["requests_log"]["gaps_under_5s"] == 1
    assert out["image_bytes_on_disk"] == out["image_bytes_recorded"] > 0


def test_evalconfig(db):
    root, orig = db
    build(root, orig)
    run("--root", root, "split")
    assert run("--root", root, "evalconfig", "t1", "--repo", REPO, "--split", "dev-tune", "--opts", "jobs=4", "mode=fast") == 0
    cfg = json.loads((root / "eval_configs" / "t1.json").read_text())
    assert cfg["options"] == {"jobs": 4, "mode": "fast"} and cfg["split_version"] == 1
    assert len(cfg["repo_commit"]) == 40 and "tools/tag/tagdb.py" in cfg["scripts"]
    assert run("--root", root, "evalconfig", "t2", "--repo", REPO, "--split", "test") == 2   # sealed


def test_jpeg_size_and_root_guard(tmp_path):
    ok, buf = cv2.imencode(".jpg", scan(1))
    p = tmp_path / "x.jpg"
    p.write_bytes(buf.tobytes())
    assert tagdb.jpeg_size(p) == (120, 168)
    assert run("--root", REPO / "tagdata", "status") == 2   # data never lives inside the repo
