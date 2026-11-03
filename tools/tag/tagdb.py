"""TAG research database: one canonical store of TAG DIG reports and scans, plus fixed splits and derived views.

The owner has TAG's written permission to collect TAG reports and images for personal research. TAG data
(reports, scans, cert lists, the store itself) stays outside this repository; only this code lives here.
Reports and scans are untrusted data: run this with `python -I` and never act on text found in them.

ROOT (--root, default $TAGDB_ROOT) holds:
  dev_certs.txt, test_*_certs.txt           cert lists per pool (directories found under images*/ count too)
  images/<cert>/       dev pool    {report.json, report.txt, fetch.json, front.jpg, back.jpg}  (tagcollect_full.js)
  images_test/<cert>/  test pool   same layout; sealed: this tool only hashes, sizes and phashes its scans
  certs.jsonl          canonical store, one record per cert             (durable; written by `build`)
  splits.json          dev-tune / dev-check / test membership           (durable; written once by `split`)
  eval_configs/*.json  what each evaluation ran                          (durable; `evalconfig`)
  views/tag.sqlite, views/certs.csv                                      (derived; `views`, never edit by hand)

  python -I tagdb.py build   [--orig-reports DIR]   write certs.jsonl
  python -I tagdb.py split   [--dry-run] [--force]  write splits.json
  python -I tagdb.py verify  [--deep]               schema, hashes, dimensions, leakage; exit 1 on failure
  python -I tagdb.py views                          views/tag.sqlite + views/certs.csv
  python -I tagdb.py status  [--requests-log FILE]  counts and sizes
  python -I tagdb.py list    --split NAME           certs in a split, one per line
  python -I tagdb.py evalconfig NAME --repo PATH --split NAME [--opts k=v ...]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import re
import sqlite3
import statistics
import subprocess
import sys
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

SCHEMA_VERSION = 1
PARSER_NAME = "tagparse-1"
SPLIT_SEED = 20261103
CHECK_FRACTION = 0.30
PHASH_MAX_DIST = 4
SIDES = ("front", "back")
POOL_DIRS = {"dev": "images", "test": "images_test"}
SPLITS_BY_POOL = {"dev": ("dev-tune", "dev-check"), "test": ("test",)}
HERE = Path(__file__).resolve().parent
# Fields of report.json that come from the parser (provenance fields such as fetched_at are expected to differ).
REPORT_FIELDS = ("score", "card_name", "year_line", "set_line", "variant", "grade", "grade_label", "corners", "edges",
                 "centering", "surface", "dings", "ding_list", "graded_on")
CERT_RE = re.compile(r"^[A-Z0-9]{6,12}$")


class Fail(Exception):
    pass


# ---------------------------------------------------------------- small helpers

def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parser_version() -> str:
    p = HERE / "tagparse.js"
    return f"{PARSER_NAME}+{sha256_file(p)[:12]}" if p.exists() else f"{PARSER_NAME}+missing"


def norm(s) -> str:
    """NFKC, upper case, whitespace collapsed."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(s or ""))).strip().upper()


def card_number(year_line: str) -> str:
    m = re.search(r"#([^/]*)", year_line or "")
    return m.group(1).strip() if m else ""


def card_key(rep: dict) -> str:
    return f"{norm(rep.get('card_name'))}|{norm(rep.get('set_line'))}|{norm(card_number(rep.get('year_line', '')))}"


def card_year(year_line: str):
    m = re.search(r"\b(\d{4})\b", year_line or "")
    return int(m.group(1)) if m else None


def read_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def dumps(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def write_atomic(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + f".tmp{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, p)


def phash_grey(grey: np.ndarray) -> str:
    """64-bit DCT perceptual hash: 32x32 grey image, DCT, top-left 8x8 compared with its median; hex, row-major."""
    small = cv2.resize(grey, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    low = cv2.dct(small)[:8, :8].flatten()
    bits = low > np.median(low)
    return f"{int(''.join('1' if b else '0' for b in bits), 2):016x}"


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def jpeg_size(p: Path):
    """(width, height) from a JPEG's SOF header without decoding it; None if not found."""
    with open(p, "rb") as f:
        if f.read(2) != b"\xff\xd8":
            return None
        while True:
            b = f.read(1)
            while b and b != b"\xff":
                b = f.read(1)
            while b == b"\xff":
                b = f.read(1)
            if not b:
                return None
            m = b[0]
            if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                continue
            ln = f.read(2)
            if len(ln) < 2:
                return None
            n = int.from_bytes(ln, "big")
            if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                d = f.read(5)
                return (int.from_bytes(d[3:5], "big"), int.from_bytes(d[1:3], "big")) if len(d) == 5 else None
            f.seek(n - 2, 1)


def resolve_root(arg) -> Path:
    root = arg or os.environ.get("TAGDB_ROOT")
    if not root:
        raise Fail("set --root or TAGDB_ROOT")
    root = Path(root).resolve()
    repo = HERE.parent.parent
    if root == repo or repo in root.parents:
        raise Fail(f"refusing ROOT inside the code repository ({repo}): TAG data stays out of the repo")
    return root


# ---------------------------------------------------------------- pools

def read_list(p: Path) -> list[str]:
    return [c for c in p.read_text().split() if c] if p.exists() else []


def excluded_certs(root: Path) -> dict[str, str]:
    """ROOT/excluded.txt: "CERT reason..." per line. Excluded certs are left out of the store, every pool and split
    (for example a test cert whose artwork matches a dev card); the reason stays on record in that file."""
    p = root / "excluded.txt"
    out = {}
    for line in (p.read_text().splitlines() if p.exists() else []):
        if line.strip() and not line.lstrip().startswith("#"):
            cert, _, why = line.strip().partition(" ")
            out[cert] = why.strip()
    return out


def pool_certs(root: Path) -> dict[str, str]:
    """cert -> pool, from the cert lists and the per-pool image directories. A cert in both pools is an error.
    Certs in excluded.txt are left out."""
    found = {"dev": set(read_list(root / "dev_certs.txt")), "test": set()}
    for f in sorted(root.glob("test_*certs.txt")):
        found["test"].update(read_list(f))
    for pool, d in POOL_DIRS.items():
        if (root / d).is_dir():
            found[pool].update(x.name for x in (root / d).iterdir() if x.is_dir() and CERT_RE.match(x.name))
    both = found["dev"] & found["test"]
    if both:
        raise Fail(f"certs in both dev and test pools: {sorted(both)[:20]} ({len(both)})")
    bad = [c for s in found.values() for c in s if not CERT_RE.match(c)]
    if bad:
        raise Fail(f"malformed certs in lists: {bad[:10]}")
    excluded = excluded_certs(root)
    return {c: pool for pool, s in found.items() for c in s if c not in excluded}


# ---------------------------------------------------------------- build

def _image_info(path: Path, expected: dict | None, prev: dict):
    """-> (image record, present, hash_ok). Dimensions/phash describe the image whose sha256 is recorded."""
    exp_sha = (expected or {}).get("sha256")
    rec = {"sha256": exp_sha, "width": None, "height": None, "bytes": (expected or {}).get("bytes"), "phash": None,
           "path": None}
    if not path.exists():
        if exp_sha and exp_sha in prev:
            rec.update(prev[exp_sha])
        return rec, False, None
    data = path.read_bytes()
    sha = sha256_bytes(data)
    ok = None if exp_sha is None else sha == exp_sha
    if exp_sha is None:
        rec["sha256"], rec["bytes"] = sha, len(data)
    if rec["sha256"] == sha:
        if sha in prev:
            rec.update(prev[sha])
        else:
            grey = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
            if grey is not None:
                rec["height"], rec["width"] = int(grey.shape[0]), int(grey.shape[1])
                rec["phash"] = phash_grey(grey)
        if rec["bytes"] is None:
            rec["bytes"] = len(data)
    elif rec["sha256"] in prev:
        rec.update(prev[rec["sha256"]])
    return rec, True, ok


def _report_diff(a: dict, b: dict) -> list[str]:
    return sorted(k for k in REPORT_FIELDS if a.get(k) != b.get(k))


def _fetch_from_record(r: dict) -> dict:
    """What fetch.json said, as recorded in a previous build (used once the cached fetch directory is gone)."""
    return {"source_url": r["source"]["report_url"], "fetched_at": r["source"]["fetched_at"], "agent": r["source"]["agent"],
            "report_txt_sha256": r["report_txt_sha256"],
            "images": {s: {"url": (r["source"].get("image_urls") or {}).get(s), "sha256": r["images"][s]["sha256"],
                           "bytes": r["images"][s]["bytes"]} for s in SIDES if r["images"][s].get("sha256")}}


def _images(root: Path, cert: str, pool: str, fetch: dict | None, prev: dict):
    d = root / POOL_DIRS[pool] / cert
    images, present, oks = {}, [], []
    for side in SIDES:
        exp = ((fetch or {}).get("images") or {}).get(side)
        if fetch is None:   # fetch in progress (fetch.json is written last) or never fetched: don't measure yet
            rec, pres, ok = {"sha256": None, "width": None, "height": None, "bytes": None, "phash": None}, False, None
        else:
            rec, pres, ok = _image_info(d / f"{side}.jpg", exp, prev)
        rec["path"] = f"{POOL_DIRS[pool]}/{cert}/{side}.jpg"
        images[side] = rec
        present.append(pres)
        oks.append(ok)
    # hash_ok: False if any cached scan differs from fetch.json; True if both are cached and match; else None.
    cache = {"present": all(present), "hash_ok": False if False in oks else (True if all(present) and all(oks) else None)}
    return images, cache


def _has_report(rep: dict) -> bool:
    g = rep.get("grade")
    return isinstance(g, (int, float)) and not isinstance(g, bool) and g == g and bool(rep.get("card_name"))


def build_record(root: Path, cert: str, pool: str, orig_dir: Path | None, prev: dict, pv: str,
                 prev_rec: dict | None = None):
    d = root / POOL_DIRS[pool] / cert
    if prev_rec is not None and prev_rec.get("pool") != pool:
        prev_rec = None
    # A fetch directory counts once its fetch.json exists: the collector writes it last.
    fetch = read_json(d / "fetch.json") if (d / "fetch.json").exists() else None
    refetched = read_json(d / "report.json") if fetch is not None and (d / "report.json").exists() else None
    refetch_error = None
    if refetched is not None and not _has_report(refetched):
        # e.g. the cert page answered "nothing was found": keep the earlier report, source and scans
        refetch_error = f"refetched page had no report (landed on {refetched.get('source_url')})"
        fetch = None
    if fetch is None and prev_rec is not None:
        fetch = _fetch_from_record(prev_rec)   # the cache was evicted: keep what was recorded at fetch time
    orig = None
    if pool == "dev" and orig_dir is not None and (orig_dir / cert / "report.json").exists():
        orig = read_json(orig_dir / cert / "report.json")
    rep = orig if orig is not None else (refetched if refetch_error is None else None)
    if rep is None:
        if prev_rec is None:
            return None
        rec = json.loads(json.dumps(prev_rec))   # report no longer cached: keep the stored record
        rec["images"], rec["cache"] = _images(root, cert, pool, fetch, prev)
        rec["refetch_error"] = refetch_error
        return rec
    if str(rep.get("cert", cert)) != cert:
        raise Fail(f"{cert}: report.json is for cert {rep.get('cert')}")
    changed = None
    if pool == "dev" and orig is not None and refetched is not None:
        changed = _report_diff(orig, refetched)
    elif prev_rec is not None and refetched is None and not prev_rec.get("refetch_error"):
        changed = prev_rec.get("report_changed_on_refetch")   # refetch evicted from the cache: keep its result
    txt_sha = (fetch or {}).get("report_txt_sha256")
    if txt_sha is None:
        for t in ([orig_dir / cert / "report.txt"] if orig is not None else []) + [d / "report.txt"]:
            if t.exists():
                txt_sha = sha256_file(t)
                break
    src = fetch or (refetched if refetch_error is None else None) or rep
    images, cache = _images(root, cert, pool, fetch, prev)
    yl = rep.get("year_line") or ""
    ck = card_key(rep)
    return {
        "schema_version": SCHEMA_VERSION,
        "cert": cert,
        "pool": pool,
        "card_key": ck,
        "group_key": ck,
        "card": {"name": rep.get("card_name") or "", "set": rep.get("set_line") or "", "year": card_year(yl),
                 "language": "japanese" if "JAPANESE" in norm(yl) else "english", "variant": rep.get("variant") or "",
                 "year_line": yl, "number": card_number(yl)},
        "tag": {"grade": rep.get("grade"), "grade_label": rep.get("grade_label") or "", "score": rep.get("score"),
                "centering": rep.get("centering"), "dings": rep.get("dings") or {}, "ding_list": rep.get("ding_list") or [],
                "graded_on": rep.get("graded_on") or ""},
        "source": {"report_url": src.get("source_url"), "fetched_at": src.get("fetched_at"), "agent": src.get("agent"),
                   "image_urls": {s: (((fetch or {}).get("images") or {}).get(s) or {}).get("url") for s in SIDES}},
        "report_txt_sha256": txt_sha,
        "parser_version": pv,
        "images": images,
        "report_changed_on_refetch": changed,
        "refetch_error": refetch_error,
        "cache": cache,
    }


def load_records(root: Path) -> list[dict]:
    p = root / "certs.jsonl"
    if not p.exists():
        raise Fail(f"{p} missing: run build")
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]


def cmd_build(a) -> int:
    root = resolve_root(a.root)
    orig = Path(a.orig_reports).resolve() if a.orig_reports else None
    pools = pool_certs(root)
    prev, prev_recs = {}, {}
    if (root / "certs.jsonl").exists():
        for r in load_records(root):
            prev_recs[r["cert"]] = r
            for im in (r.get("images") or {}).values():
                if im.get("sha256") and im.get("phash"):
                    prev[im["sha256"]] = {k: im[k] for k in ("width", "height", "phash")}
    pv = parser_version()
    excluded = excluded_certs(root)
    for c, r in prev_recs.items():
        if c in excluded:
            continue
        if c not in pools:   # a cert stays in the store once recorded, even if its list entry and cache are gone
            pools[c] = r["pool"]
    certs = sorted(pools)
    with ThreadPoolExecutor(a.jobs) as ex:
        recs = list(ex.map(lambda c: build_record(root, c, pools[c], orig, prev, pv, prev_recs.get(c)), certs))
    pending = [c for c, r in zip(certs, recs) if r is None]
    recs = [r for r in recs if r is not None]
    write_atomic(root / "certs.jsonl", "".join(dumps(r) + "\n" for r in recs))
    by = Counter(r["pool"] for r in recs)
    print(f"wrote {root / 'certs.jsonl'}: {len(recs)} records ({dict(sorted(by.items()))}); "
          f"{len(pending)} listed certs without a report yet; {len(excluded)} excluded; parser {pv}")
    changed = [r["cert"] for r in recs if r["report_changed_on_refetch"]]
    if changed:
        print(f"reports changed on refetch: {len(changed)} e.g. {changed[:5]}")
    return 0


# ---------------------------------------------------------------- split

def _median_grade(rs):
    g = [r["tag"]["grade"] for r in rs if isinstance(r["tag"].get("grade"), (int, float))]
    return statistics.median(g) if g else -1


def near_pairs(items, max_dist):
    """items: [(tag, phash hex)] -> index pairs (i, j, distance) with Hamming distance <= max_dist."""
    if len(items) < 2:
        return []
    hv = np.array([int(h, 16) for _, h in items], dtype=np.uint64)
    out = []
    for i in range(len(items) - 1):
        x = np.bitwise_xor(hv[i + 1:], hv[i])
        dist = np.unpackbits(x.view(np.uint8).reshape(-1, 8), axis=1).sum(axis=1)
        out += [(i, i + 1 + int(j), int(dist[j])) for j in np.nonzero(dist <= max_dist)[0]]
    return out


def dev_components(records, max_dist=PHASH_MAX_DIST, sides=("front",)) -> dict[str, str]:
    """card_key -> component id: card_keys whose scans are near duplicates (e.g. a reprint with the same art)
    are kept together, so near-duplicate images can never land on both sides of the dev split."""
    parent = {}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    dev = [r for r in records if r["pool"] == "dev"]
    for r in dev:
        parent.setdefault(r["group_key"], r["group_key"])
    items = [(r["group_key"], r["images"][s]["phash"]) for r in dev for s in sides
             if (r.get("images") or {}).get(s, {}).get("phash")]
    for i, j, _ in near_pairs(items, max_dist):
        a, b = find(items[i][0]), find(items[j][0])
        if a != b:
            parent[max(a, b)] = min(a, b)
    return {k: find(k) for k in sorted(parent)}


def make_split(records: list[dict], seed=SPLIT_SEED, check_fraction=CHECK_FRACTION, max_dist=PHASH_MAX_DIST,
               sides=("front",)) -> dict:
    comp = dev_components(records, max_dist, sides)
    groups = defaultdict(list)
    for r in records:
        if r["pool"] == "dev":
            groups[comp[r["group_key"]]].append(r)
    strata = defaultdict(list)
    for k, rs in groups.items():
        strata[_median_grade(rs)].append(k)
    rng = random.Random(seed)
    order = []
    for med in sorted(strata):
        keys = sorted(strata[med])
        rng.shuffle(keys)
        order.extend(keys)
    # Systematic sampling over the stratum-ordered list: every stratum gets ~check_fraction of its groups.
    comp_split = {}
    for i, k in enumerate(order):
        comp_split[k] = "dev-check" if int((i + 1) * check_fraction) > int(i * check_fraction) else "dev-tune"
    group_split = {k: comp_split[c] for k, c in comp.items()}
    membership = {}
    for r in records:
        membership[r["cert"]] = group_split[r["group_key"]] if r["pool"] == "dev" else "test"
    merged = defaultdict(list)
    for k, c in comp.items():
        merged[c].append(k)
    membership = dict(sorted(membership.items()))
    return {
        "version": 1,
        "method": f"dev pool: groups = card_key (card_keys with near-duplicate {'/'.join(sides)} scans, phash <= "
                  f"{max_dist}, merged into one group), stratified by each group's median TAG grade, systematic "
                  f"{check_fraction:.0%} of groups per stratum to dev-check after a seeded shuffle; test pool: test",
        "seed": seed,
        "check_fraction": check_fraction,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "membership": membership,
        "membership_sha256": sha256_bytes(dumps(membership).encode()),
        "groups": dict(sorted(group_split.items())),
        "merged_groups": sorted(sorted(v) for v in merged.values() if len(v) > 1),
    }


def leakage(records: list[dict], membership: dict, max_dist=PHASH_MAX_DIST, sides=("front",)) -> dict:
    """card_keys in more than one split, and image pairs across splits with phash Hamming distance <= max_dist."""
    key_splits = defaultdict(set)
    for r in records:
        if r["cert"] in membership:
            key_splits[r["card_key"]].add(membership[r["cert"]])
    keys = {k: sorted(v) for k, v in sorted(key_splits.items()) if len(v) > 1}
    items = [((membership[r["cert"]], r["cert"], s), r["images"][s]["phash"]) for r in records
             if r["cert"] in membership for s in sides if (r.get("images") or {}).get(s, {}).get("phash")]
    pairs = []
    for i, j, d in near_pairs(items, max_dist):
        (sa, ca, xa), (sb, cb, xb) = items[i][0], items[j][0]
        if sa != sb:
            pairs.append({"a": f"{ca}/{xa}", "a_split": sa, "b": f"{cb}/{xb}", "b_split": sb, "distance": d})
    return {"card_keys": keys, "phash_pairs": pairs}


def _sides(a):
    s = tuple(x for x in a.phash_sides.split(",") if x)
    if not s or any(x not in SIDES for x in s):
        raise Fail("--phash-sides takes front, back or front,back")
    return s


def _split_summary(records, sp):
    m = sp["membership"]
    out = {}
    for name in ("dev-tune", "dev-check", "test"):
        rs = [r for r in records if m.get(r["cert"]) == name]
        out[name] = {"certs": len(rs), "groups": len({r["card_key"] for r in rs}),
                     "grades": dict(sorted(Counter(str(r["tag"]["grade"]) for r in rs).items(),
                                           key=lambda kv: float(kv[0]) if kv[0] not in ("None",) else -1))}
    return out


def _report_leaks(lk) -> bool:
    bad = False
    if lk["card_keys"]:
        bad = True
        print(f"LEAK: {len(lk['card_keys'])} card_keys in more than one split:", file=sys.stderr)
        for k, v in list(lk["card_keys"].items())[:50]:
            print(f"  {k}: {v}", file=sys.stderr)
    if lk["phash_pairs"]:
        bad = True
        print(f"LEAK: {len(lk['phash_pairs'])} near-duplicate image pairs across splits (phash <= {PHASH_MAX_DIST}):",
              file=sys.stderr)
        for p in lk["phash_pairs"][:50]:
            print(f"  {p['a']} ({p['a_split']}) ~ {p['b']} ({p['b_split']}): {p['distance']}", file=sys.stderr)
    return bad


def cmd_split(a) -> int:
    root = resolve_root(a.root)
    out = root / "splits.json"
    if out.exists() and not a.force and not a.dry_run:
        raise Fail(f"{out} exists; splits are made once (use --force to replace it, which bumps its version)")
    records = load_records(root)
    sp = make_split(records, a.seed, a.check_fraction, a.max_dist, _sides(a))
    if out.exists():
        sp["version"] = int(read_json(out).get("version", 0)) + 1
    lk = leakage(records, sp["membership"], a.max_dist, _sides(a))
    summary = _split_summary(records, sp)
    print(json.dumps({"dry_run": bool(a.dry_run), "version": sp["version"], "seed": sp["seed"], "splits": summary,
                      "merged_groups": sp["merged_groups"],
                      "membership_sha256": sp["membership_sha256"],
                      "leaks": {"card_keys": len(lk["card_keys"]), "phash_pairs": len(lk["phash_pairs"])}},
                     indent=1, ensure_ascii=False))
    if _report_leaks(lk):
        print("split NOT written: leakage", file=sys.stderr)
        return 1
    if a.dry_run:
        return 0
    write_atomic(out, json.dumps(sp, indent=1, sort_keys=True, ensure_ascii=False) + "\n")
    print(f"wrote {out}")
    return 0


# ---------------------------------------------------------------- verify

RECORD_KEYS = {"refetch_error": (str, type(None)), "schema_version": int, "cert": str, "pool": str, "card_key": str, "group_key": str, "card": dict,
               "tag": dict, "source": dict, "report_txt_sha256": (str, type(None)), "parser_version": str,
               "images": dict, "report_changed_on_refetch": (list, type(None)), "cache": dict}
SUB_KEYS = {"card": ("name", "set", "year", "language", "variant"),
            "tag": ("grade", "grade_label", "score", "centering", "dings", "ding_list", "graded_on"),
            "source": ("report_url", "fetched_at", "agent", "image_urls"),
            "cache": ("present", "hash_ok")}
IMAGE_KEYS = ("sha256", "width", "height", "bytes", "phash", "path")


def schema_errors(r: dict) -> list[str]:
    e = []
    c = r.get("cert", "?")
    for k, t in RECORD_KEYS.items():
        if k not in r:
            e.append(f"{c}: missing {k}")
        elif not isinstance(r[k], t):
            e.append(f"{c}: {k} has type {type(r[k]).__name__}")
    if e:
        return e
    if r["schema_version"] != SCHEMA_VERSION:
        e.append(f"{c}: schema_version {r['schema_version']}")
    if r["pool"] not in POOL_DIRS:
        e.append(f"{c}: pool {r['pool']}")
    if not CERT_RE.match(c):
        e.append(f"{c}: malformed cert")
    if r["group_key"] != r["card_key"] or r["card_key"].count("|") != 2:
        e.append(f"{c}: bad card_key/group_key")
    for k, sub in SUB_KEYS.items():
        e += [f"{c}: {k}.{s} missing" for s in sub if s not in r[k]]
    if r["card"].get("language") not in ("english", "japanese"):
        e.append(f"{c}: card.language")
    for s in SIDES:
        im = r["images"].get(s)
        if not isinstance(im, dict):
            e.append(f"{c}: images.{s} missing")
            continue
        e += [f"{c}: images.{s}.{k} missing" for k in IMAGE_KEYS if k not in im]
        if im.get("phash") is not None and not re.fullmatch(r"[0-9a-f]{16}", im["phash"]):
            e.append(f"{c}: images.{s}.phash malformed")
        if im.get("sha256") is not None and not re.fullmatch(r"[0-9a-f]{64}", im["sha256"]):
            e.append(f"{c}: images.{s}.sha256 malformed")
    return e


def cache_status(r: dict) -> str:
    c = r.get("cache") or {}
    if c.get("hash_ok") is False:
        return "hash_mismatch"
    if c.get("present"):
        return "ok" if c.get("hash_ok") else "unverified"
    return "missing"


def cmd_verify(a) -> int:
    root = resolve_root(a.root)
    records = load_records(root)
    errors, warnings = [], []
    seen = Counter(r.get("cert") for r in records)
    errors += [f"{c}: duplicate record" for c, n in seen.items() if n > 1]
    if [r.get("cert") for r in records] != sorted(r.get("cert") for r in records):
        errors.append("certs.jsonl is not sorted by cert")
    try:
        pools = pool_certs(root)
    except Fail as e:
        errors.append(str(e))
        pools = {}
    status = Counter()
    for r in records:
        se = schema_errors(r)
        errors += se
        if se:
            continue
        c = r["cert"]
        if pools.get(c, r["pool"]) != r["pool"]:
            errors.append(f"{c}: record pool {r['pool']} but lists/dirs say {pools.get(c)}")
        d = root / POOL_DIRS[r["pool"]] / c
        fetch = read_json(d / "fetch.json") if (d / "fetch.json").exists() else None
        if fetch and (d / "report.txt").exists() and sha256_file(d / "report.txt") != fetch.get("report_txt_sha256"):
            errors.append(f"{c}: report.txt does not match its sha256 in fetch.json")
        if r.get("refetch_error"):
            fetch = None
        if fetch and fetch.get("report_txt_sha256") != r["report_txt_sha256"]:
            errors.append(f"{c}: report_txt_sha256 differs from fetch.json (stale certs.jsonl? rerun build)")
        for s in SIDES:
            im = r["images"][s]
            exp = ((fetch or {}).get("images") or {}).get(s) or {}
            if exp.get("sha256") and exp["sha256"] != im["sha256"]:
                errors.append(f"{c}/{s}: sha256 differs from fetch.json (stale certs.jsonl? rerun build)")
            p = root / im["path"]
            if not p.exists() or im["sha256"] is None:
                continue
            sha = sha256_file(p)
            if sha != im["sha256"]:
                errors.append(f"{c}/{s}: file sha256 {sha[:12]} != recorded {str(im['sha256'])[:12]}")
                continue
            if p.stat().st_size != im["bytes"]:
                errors.append(f"{c}/{s}: {p.stat().st_size} bytes != recorded {im['bytes']}")
            wh = jpeg_size(p)
            if wh is None or wh != (im["width"], im["height"]):
                errors.append(f"{c}/{s}: dimensions {wh} != recorded {(im['width'], im['height'])}")
            if a.deep:
                grey = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
                if grey is None or phash_grey(grey) != im["phash"]:
                    errors.append(f"{c}/{s}: phash differs from recorded")
        if r["cache"]["hash_ok"] is False:
            errors.append(f"{c}: cached image does not match its fetch.json hash")
        status[cache_status(r)] += 1
    if (root / "splits.json").exists():
        sp = read_json(root / "splits.json")
        m = sp.get("membership") or {}
        for k in ("version", "method", "seed", "created_at", "membership"):
            if k not in sp:
                errors.append(f"splits.json: missing {k}")
        if m and sp.get("membership_sha256") and sha256_bytes(dumps(dict(sorted(m.items()))).encode()) != sp["membership_sha256"]:
            errors.append("splits.json: membership_sha256 does not match membership")
        recs = {r.get("cert"): r for r in records}
        for c, s in m.items():
            if c not in recs:
                warnings.append(f"{c}: in splits.json but not in certs.jsonl")
            elif s not in SPLITS_BY_POOL.get(recs[c].get("pool"), ()):
                errors.append(f"{c}: split {s} not allowed for pool {recs[c].get('pool')}")
        unassigned = sorted(set(recs) - set(m))
        if unassigned:
            errors.append(f"{len(unassigned)} certs not in splits.json, e.g. {unassigned[:5]} (re-split with --force)")
        good = [r for r in records if not schema_errors(r)]
        lk = leakage(good, m, a.max_dist, _sides(a))
        if lk["card_keys"]:
            errors.append(f"leak: {len(lk['card_keys'])} card_keys in more than one split: {list(lk['card_keys'])[:5]}")
        for p in lk["phash_pairs"]:
            errors.append(f"leak: {p['a']} ({p['a_split']}) ~ {p['b']} ({p['b_split']}) phash distance {p['distance']}")
    else:
        warnings.append("no splits.json yet")
    for w in warnings[:20]:
        print("warning:", w)
    for e in errors[:200]:
        print("ERROR:", e)
    print(f"verify: {len(records)} records, cache {dict(sorted(status.items()))}, "
          f"{len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors else 0


# ---------------------------------------------------------------- views

def _ding_counts(r):
    out = {}
    for k in ("corners", "edges", "surface"):
        v = (r["tag"].get("dings") or {}).get(k)
        vals = [x for x in (v or {}).values() if isinstance(x, (int, float))]
        out[k] = sum(vals) if vals else None
    return out


def _ding_text(r):
    return "; ".join(f"{d.get('side', '')} {d.get('location', '')}: {d.get('type', '')}" for d in r["tag"].get("ding_list") or [])


def load_membership(root: Path) -> dict:
    p = root / "splits.json"
    return (read_json(p).get("membership") or {}) if p.exists() else {}


CSV_COLS = ("cert", "card", "set", "year", "language", "grade", "score", "split", "centering_front", "centering_back",
            "corner_dings", "edge_dings", "surface_dings", "ding_list", "image_cache")


def cmd_views(a) -> int:
    root = resolve_root(a.root)
    records = load_records(root)
    m = load_membership(root)
    vd = root / "views"
    vd.mkdir(parents=True, exist_ok=True)
    db = vd / "tag.sqlite"
    tmp = vd / f"tag.sqlite.tmp{os.getpid()}"
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.executescript("""
    CREATE TABLE certs (cert TEXT PRIMARY KEY, pool TEXT, split TEXT, card_key TEXT, card_name TEXT, card_set TEXT,
      year INTEGER, language TEXT, variant TEXT, grade REAL, grade_label TEXT, score INTEGER,
      centering_front TEXT, centering_back TEXT, corner_dings INTEGER, edge_dings INTEGER, surface_dings INTEGER,
      graded_on TEXT, report_url TEXT, fetched_at TEXT, agent TEXT, report_txt_sha256 TEXT, parser_version TEXT,
      report_changed_on_refetch TEXT, cache_present INTEGER, cache_hash_ok INTEGER, image_cache TEXT);
    CREATE TABLE dings (cert TEXT, idx INTEGER, side TEXT, location TEXT, type TEXT, PRIMARY KEY (cert, idx));
    CREATE TABLE images (cert TEXT, side TEXT, sha256 TEXT, width INTEGER, height INTEGER, bytes INTEGER, phash TEXT,
      path TEXT, url TEXT, PRIMARY KEY (cert, side));
    CREATE TABLE splits (cert TEXT PRIMARY KEY, split TEXT, card_key TEXT);
    """)
    rows = []
    for r in records:
        cen = r["tag"].get("centering") or {}
        dc = _ding_counts(r)
        b = lambda v: None if v is None else int(bool(v))
        con.execute("INSERT INTO certs VALUES (" + ",".join("?" * 27) + ")", (
            r["cert"], r["pool"], m.get(r["cert"]), r["card_key"], r["card"]["name"], r["card"]["set"], r["card"]["year"],
            r["card"]["language"], r["card"]["variant"], r["tag"]["grade"], r["tag"]["grade_label"], r["tag"]["score"],
            cen.get("front"), cen.get("back"), dc["corners"], dc["edges"], dc["surface"], r["tag"]["graded_on"],
            r["source"]["report_url"], r["source"]["fetched_at"], r["source"]["agent"], r["report_txt_sha256"],
            r["parser_version"], None if r["report_changed_on_refetch"] is None else ",".join(r["report_changed_on_refetch"]),
            b(r["cache"]["present"]), b(r["cache"]["hash_ok"]), cache_status(r)))
        for i, d in enumerate(r["tag"].get("ding_list") or []):
            con.execute("INSERT INTO dings VALUES (?,?,?,?,?)", (r["cert"], i, d.get("side"), d.get("location"), d.get("type")))
        for s in SIDES:
            im = r["images"][s]
            con.execute("INSERT INTO images VALUES (?,?,?,?,?,?,?,?,?)", (r["cert"], s, im["sha256"], im["width"], im["height"],
                        im["bytes"], im["phash"], im["path"], (r["source"].get("image_urls") or {}).get(s)))
        if r["cert"] in m:
            con.execute("INSERT INTO splits VALUES (?,?,?)", (r["cert"], m[r["cert"]], r["card_key"]))
        rows.append({"cert": r["cert"], "card": r["card"]["name"], "set": r["card"]["set"], "year": r["card"]["year"],
                     "language": r["card"]["language"], "grade": r["tag"]["grade"], "score": r["tag"]["score"],
                     "split": m.get(r["cert"], ""), "centering_front": cen.get("front"), "centering_back": cen.get("back"),
                     "corner_dings": dc["corners"], "edge_dings": dc["edges"], "surface_dings": dc["surface"],
                     "ding_list": _ding_text(r), "image_cache": cache_status(r)})
    con.commit()
    con.close()
    os.replace(tmp, db)
    ctmp = vd / f"certs.csv.tmp{os.getpid()}"
    with open(ctmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLS)
        w.writeheader()
        for row in rows:
            w.writerow({k: "" if v is None else v for k, v in row.items()})
    os.replace(ctmp, vd / "certs.csv")
    print(f"wrote {db} and {vd / 'certs.csv'}: {len(rows)} certs, {len(m)} split assignments")
    return 0


# ---------------------------------------------------------------- status / list

def requests_log_gaps(p: Path) -> dict:
    ts = []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            ts.append(datetime.fromisoformat(line.split("\t", 1)[0].replace("Z", "+00:00")))
        except ValueError:
            continue
    ts.sort()
    gaps = [(b - a).total_seconds() for a, b in zip(ts, ts[1:])]
    out = {"entries": len(ts), "min_gap_s": round(min(gaps), 3) if gaps else None,
           "gaps_under_5s": sum(g < 5 for g in gaps)}
    if gaps:
        i = gaps.index(min(gaps))
        out["min_gap_at"] = ts[i + 1].isoformat()
    return out


def cmd_status(a) -> int:
    root = resolve_root(a.root)
    records = load_records(root)
    m = load_membership(root)
    disk = 0
    for r in records:
        for s in SIDES:
            p = root / r["images"][s]["path"]
            if p.exists():
                disk += p.stat().st_size
    try:
        listed = pool_certs(root)
    except Fail:
        listed = {}
    have = {r["cert"] for r in records}
    out = {
        "records": len(records),
        "by_pool": dict(sorted(Counter(r["pool"] for r in records).items())),
        "listed_without_report": dict(sorted(Counter(p for c, p in listed.items() if c not in have).items())),
        "by_split": dict(sorted(Counter(m.get(r["cert"], "(unsplit)") for r in records).items())),
        "by_grade": dict(sorted(Counter(str(r["tag"]["grade"]) for r in records).items(),
                                key=lambda kv: float(kv[0]) if kv[0] != "None" else -1)),
        "by_cache": dict(sorted(Counter(f"{r['pool']}:{cache_status(r)}" for r in records).items())),
        "groups": dict(sorted(Counter(r["pool"] for r in {r["card_key"] + r["pool"]: r for r in records}.values()).items())),
        "reports_changed_on_refetch": sum(bool(r["report_changed_on_refetch"]) for r in records),
        "refetch_errors": sorted(r["cert"] for r in records if r.get("refetch_error")),
        "image_bytes_on_disk": disk,
        "image_bytes_recorded": sum((r["images"][s]["bytes"] or 0) for r in records for s in SIDES),
        "parser_versions": dict(Counter(r["parser_version"] for r in records)),
    }
    if a.requests_log:
        out["requests_log"] = requests_log_gaps(Path(a.requests_log))
    print(json.dumps(out, indent=1, ensure_ascii=False))
    return 0


def cmd_list(a) -> int:
    root = resolve_root(a.root)
    m = load_membership(root)
    if not m:
        raise Fail("no splits.json")
    for c, s in m.items():
        if s == a.split:
            print(c)
    return 0


# ---------------------------------------------------------------- eval configs

def _git(repo: Path, *args) -> str:
    p = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if p.returncode:
        raise Fail(f"git {' '.join(args)} failed in {repo}: {p.stderr.strip()}")
    return p.stdout.strip()


def _opt(v: str):
    try:
        return json.loads(v)
    except ValueError:
        return v


def cmd_evalconfig(a) -> int:
    root = resolve_root(a.root)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", a.name):
        raise Fail("NAME may use letters, digits, '_', '.', '-'")
    out = root / "eval_configs" / f"{a.name}.json"
    if out.exists() and not a.force:
        raise Fail(f"{out} exists (use --force)")
    if a.split == "test" and not a.allow_test:
        raise Fail("the test split is sealed: pass --allow-test only for the final, pre-registered evaluation")
    sp_path = root / "splits.json"
    if not sp_path.exists():
        raise Fail("no splits.json")
    sp = read_json(sp_path)
    certs = sorted(c for c, s in (sp.get("membership") or {}).items() if s == a.split)
    if not certs:
        raise Fail(f"split {a.split!r} is empty or unknown")
    repo = Path(a.repo).resolve()
    scripts = {}
    for pat in ["tools/tag/*.py", "tools/tag/*.js", "scripts/photo_grade.py", *a.script]:
        for p in sorted(repo.glob(pat)):
            if p.is_file():
                scripts[str(p.relative_to(repo))] = sha256_file(p)
    opts = {}
    for kv in a.opts:
        if "=" not in kv:
            raise Fail(f"--opts takes key=value, got {kv!r}")
        k, v = kv.split("=", 1)
        opts[k] = _opt(v)
    cfg = {
        "name": a.name,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": str(repo),
        "repo_commit": _git(repo, "rev-parse", "HEAD"),
        "repo_dirty": bool(_git(repo, "status", "--porcelain")),
        "scripts": scripts,
        "options": opts,
        "split": a.split,
        "split_version": sp.get("version"),
        "split_membership_sha256": sp.get("membership_sha256"),
        "certs": len(certs),
        "certs_sha256": sha256_bytes("\n".join(certs).encode()),
        "parser_version": parser_version(),
    }
    write_atomic(out, json.dumps(cfg, indent=1, sort_keys=True) + "\n")
    print(f"wrote {out}" + ("  (warning: repo has uncommitted changes)" if cfg["repo_dirty"] else ""))
    return 0


# ---------------------------------------------------------------- CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=None, help="database root (default $TAGDB_ROOT)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="write ROOT/certs.jsonl")
    b.add_argument("--orig-reports", default=os.environ.get("TAGDB_ORIG_REPORTS"),
                   help="dir of <cert>/report.json: canonical reports for the dev pool (default $TAGDB_ORIG_REPORTS)")
    b.add_argument("--jobs", type=int, default=min(8, os.cpu_count() or 2))
    s = sub.add_parser("split", help="write ROOT/splits.json once")
    s.add_argument("--dry-run", action="store_true", help="print what the split would be; write nothing")
    s.add_argument("--force", action="store_true", help="replace an existing splits.json (bumps its version)")
    s.add_argument("--seed", type=int, default=SPLIT_SEED)
    s.add_argument("--check-fraction", type=float, default=CHECK_FRACTION)
    for p in (s, v := sub.add_parser("verify", help="check schema, hashes, dimensions, leakage")):
        p.add_argument("--max-dist", type=int, default=PHASH_MAX_DIST, help="phash Hamming distance counted as a near duplicate")
        # Fronts only by default: every card of a language shares one back design, so backs of different cards
        # are routinely within a few bits of each other and would all count as "near duplicates".
        p.add_argument("--phash-sides", default="front", help="sides whose phashes are compared: front, back or front,back")
    v.add_argument("--deep", action="store_true", help="also recompute each cached image's phash")
    sub.add_parser("views", help="build ROOT/views/tag.sqlite and certs.csv")
    st = sub.add_parser("status", help="counts by pool, split, grade, cache")
    st.add_argument("--requests-log", default=None, help="collector requests.log: report the minimum gap between requests")
    li = sub.add_parser("list", help="print the certs of one split")
    li.add_argument("--split", required=True)
    e = sub.add_parser("evalconfig", help="record an evaluation's code, options and split")
    e.add_argument("name")
    e.add_argument("--repo", required=True)
    e.add_argument("--split", required=True)
    e.add_argument("--opts", nargs="*", default=[], metavar="KEY=VALUE")
    e.add_argument("--script", action="append", default=[], help="extra repo-relative glob to hash")
    e.add_argument("--allow-test", action="store_true")
    e.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    try:
        return {"build": cmd_build, "split": cmd_split, "verify": cmd_verify, "views": cmd_views, "status": cmd_status,
                "list": cmd_list, "evalconfig": cmd_evalconfig}[a.cmd](a)
    except Fail as ex:
        print(f"tagdb {a.cmd}: {ex}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
