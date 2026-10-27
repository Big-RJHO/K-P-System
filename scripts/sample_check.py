"""End-to-end check on graded sample slabs: does the program find the card, identify it, and grade it
at or below what a grading company gave it?

For each card in a key file it runs the same steps as the phone app:
  1. scan     photo_grade.py scan (outline, flattening, centering, photo checks, wear flags)
  2. identify Gemini reads the card, then the card databases are searched (scripts/identify_card.js).
              Needs GEMINI_API_KEY in the environment; skipped without it.
  3. grade    photo_grade.py grade from the scan's own wear flags only (surface is never photo-assessed,
              so every result is a best-case ceiling)
and then compares each step with the key: the expected card, the slab's grade and, where the key has
the grading company's report, its centering. The key's grade and report are only used for scoring;
they are never passed to the grader.

Key file: a JSON list of
  {"id": "TAG_10_P8673909", "front": "front.jpg", "back": "back.jpg", "company": "TAG", "grade": 10,
   "cert": "P8673909",
   "expect": {"names": ["Sabrina's Gengar", "ナツメのゲンガー"], "number": "", "set": "...", "source_ids": ["PMCG6-054"]},
   "report": {"centering": {"front": "50L/50R 52T/48B", "back": "57L/43R 54T/46B"}, ...}}   # optional
Photo paths are relative to the key file.

  python scripts/sample_check.py KEY.json --out OUT_DIR [--only ID,ID] [--skip-identify]
writes OUT_DIR/<id>/ (scan images, scan.json, grade.json, identify.json, check.json) and OUT_DIR/summary.json.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", str(s or "")).lower().replace("’", "'")
    return re.sub(r"[^\w]+", "", s)


def num_left(s: str) -> str:
    s = str(s or "").upper().replace(" ", "")
    left = s.split("/")[0]
    return left.lstrip("0") or left


def name_ok(name: str, names: list[str]) -> bool:
    a = norm(name)
    return bool(a) and any(b and (a == b or a in b or b in a) for b in map(norm, names))


def number_ok(number: str, expected: str) -> bool | None:
    if not expected:
        return None   # nothing printed to check (e.g. vintage Japanese cards have no collector number)
    return num_left(number) == num_left(expected)


def centering_share(text: str) -> tuple[float, float] | None:
    """'57L/43R 54T/46B' -> (57, 54): the larger share on each axis, as the app reports it."""
    m = re.findall(r"(\d+(?:\.\d+)?)\s*[LRTB]", str(text or ""))
    if len(m) != 4:
        return None
    lr, tb = (float(m[0]), float(m[1])), (float(m[2]), float(m[3]))
    return max(lr), max(tb)


def step(name: str, status: str, detail: str, started: float, **extra) -> dict:
    return {"step": name, "status": status, "detail": detail, "seconds": round(time.time() - started, 1), **extra}


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, **kw)


def check_card(card: dict, base: Path, out: Path, skip_identify: bool, identify_from: Path | None = None) -> dict:
    d = out / card["id"]
    d.mkdir(parents=True, exist_ok=True)
    steps, res = [], {"id": card["id"], "company": card["company"], "true_grade": card["grade"], "cert": card.get("cert", "")}

    # 1. scan
    t = time.time()
    p = run([PY, "scripts/photo_grade.py", "scan", str(base / card["front"]), str(base / card["back"]), "--out", str(d)])
    (d / "scan.log").write_text(p.stdout + p.stderr)
    if p.returncode or not (d / "scan.json").exists():
        steps.append(step("scan", "fail", f"scan failed: {(p.stderr or p.stdout).strip()[-300:]}", t))
        res["steps"] = steps
        return res
    scan = json.loads((d / "scan.json").read_text())["sides"]
    verdicts = {s: scan[s]["quality"] if isinstance(scan[s]["quality"], str) else scan[s]["quality"].get("verdict") for s in ("front", "back")}
    blocked = [f"{s}: {r}" for s in ("front", "back") for r in (scan[s].get("blocked_reasons") or {})]
    # Edges and corners the photo check could assess (4 edges + 4 corners per side).
    assessable = 16 - sum(len(scan[s].get("auto_unassessed") or {}) for s in ("front", "back"))
    res["assessable"] = assessable
    status = "fail" if "fail" in verdicts.values() else "warn" if assessable < 8 else "pass"
    steps.append(step("scan", status, f"photo check front {verdicts['front']}, back {verdicts['back']}; {assessable} of 16 edges and corners assessable"
                      + (f"; blocked: {', '.join(blocked)[:200]}" if blocked else ""), t, assessable=assessable,
                      images={s: f"{s}_overlay.jpg" for s in ("front", "back")}))
    res["centering"] = {s: {**scan[s]["centering"], "evidence": scan[s].get("evidence")} for s in ("front", "back")}

    # 1b. centering against the grading company's report, where the key has it
    rep = (card.get("report") or {}).get("centering") or {}
    cmp, unread = {}, []
    for s in ("front", "back"):
        want = centering_share(rep.get(s))
        got, ev = scan[s]["centering"], scan[s].get("evidence") or {}
        if not want or got.get("lr") is None:
            continue
        # An axis the scan couldn't read is reported as 50, which is not a measurement: leave it out.
        axes = [(ax, w) for ax, w in (("lr", want[0]), ("tb", want[1])) if ev.get(ax) != "unread"]
        if not axes:
            unread.append(s)
            continue
        cmp[s] = {"report": rep[s], "report_lr": want[0], "report_tb": want[1], "app_lr": got["lr"], "app_tb": got["tb"],
                  "unread": [ax for ax in ("lr", "tb") if ev.get(ax) == "unread"],
                  "diff": round(max(abs(got[ax] - w) for ax, w in axes), 1)}
    if cmp or unread:
        worst = max([c["diff"] for c in cmp.values()] or [0])
        status = "fail" if worst > 6 else "warn" if worst > 3 or unread or any(c["unread"] for c in cmp.values()) else "pass"
        parts = [f"{s} app {c['app_lr']}/{c['app_tb']} vs report {c['report_lr']:g}/{c['report_tb']:g}" + (f" ({', '.join(c['unread'])} not read)" if c["unread"] else "")
                 for s, c in cmp.items()] + [f"{s} not measured (report {rep[s]})" for s in unread]
        steps.append(step("centering", status, "; ".join(parts), time.time(), worst_diff=worst))
        res["centering_vs_report"] = cmp

    # 2. identify
    t = time.time()
    exp = card.get("expect") or {}
    cached = identify_from / card["id"] / "identify.json" if identify_from else None
    if skip_identify:
        steps.append(step("identify", "skipped", "skipped (--skip-identify)", t))
    else:
        job = {"id": card["id"], "image": str(d / "front_card.jpg"), "game": card.get("game", "pokemon")}
        if cached and cached.exists() and (json.loads(cached.read_text()).get("reading")):
            job["reading"] = json.loads(cached.read_text())["reading"]   # an earlier Gemini reading; the lookup runs again
        p = run(["node", "scripts/identify_card.js"], input=json.dumps([job]), timeout=180)
        ident = json.loads(p.stdout)[0] if p.returncode == 0 and p.stdout.strip() else {"error": (p.stderr or "identify failed").strip()[-300:]}
        (d / "identify.json").write_text(json.dumps(ident, ensure_ascii=False, indent=1))
        if ident.get("error") == "no-key":
            steps.append(step("identify", "skipped", "no GEMINI_API_KEY in the environment", t))
        else:
            r = ident.get("reading") or {}
            top = (ident.get("candidates") or [None])[0] or {}
            ids = exp.get("source_ids") or []

            def same_card(c: dict) -> bool:
                if ids:   # the exact database entry: same card, set and language
                    return c.get("source_id") in ids
                return name_ok(c.get("name", ""), exp.get("names", [])) and number_ok(c.get("number", ""), exp.get("number", "")) is not False

            read_ok = (name_ok(r.get("name", ""), exp.get("names", [])) or name_ok(r.get("printed_name", ""), exp.get("names", []))) \
                and number_ok(r.get("number", ""), exp.get("number", "")) is not False
            top_ok = bool(top) and same_card(top)
            listed = any(same_card(c) for c in ident.get("candidates") or [])
            other_printing = bool(top) and not top_ok and name_ok(top.get("name", ""), exp.get("names", []))
            detail = f"read \"{r.get('name', '')}\" {r.get('number', '')} ({r.get('set_name', '') or 'no set'})"
            detail += f"; first match \"{top.get('name', '')}\" {top.get('number', '')} {top.get('set_name', '')}" if top else f"; no match ({ident.get('error', '')})"
            if other_printing:
                detail += f" (another printing: {top.get('source_id', '')}, expected {', '.join(ids)})"
            status = "pass" if top_ok else "warn" if listed or other_printing else "fail"
            steps.append(step("identify", status, detail, t, read_ok=read_ok, first_match_ok=top_ok, listed=listed))
            res["identify"] = {"reading": r, "first_match": top, "read_ok": read_ok, "first_match_ok": top_ok, "listed": listed}

    # 3. grade from the scan's own flags (the key's grade is not given to the grader)
    t = time.time()
    obs = {"inspected": {"front": ["corners", "edges"], "back": ["corners", "edges"]},
           "defects": [{k: x[k] for k in ("side", "location", "type", "severity")} for s in ("front", "back") for x in scan[s]["auto_defects"]]}
    (d / "obs.json").write_text(json.dumps(obs))
    p = run([PY, "scripts/photo_grade.py", "grade", str(d / "scan.json"), str(d / "obs.json"), "--json", str(d / "grade.json")])
    if p.returncode:
        steps.append(step("grade", "fail", f"grade failed: {(p.stderr or p.stdout).strip()[-300:]}", t))
    else:
        g = json.loads((d / "grade.json").read_text())["grades"]
        mine = g[card["company"]]["grade"]
        mine = min(10, mine) if card["company"] == "TAG" else mine   # 10.5 is TAG's Pristine label
        res["grades"] = {k: v["grade"] for k, v in g.items()}
        res["app_grade"] = mine
        res["flags"] = {s: [f"{x['location']} {x['type']} {x['severity']}" for x in scan[s]["auto_defects"]] for s in ("front", "back")}
        # The app's grade is a best case: below the slab is wrong (fail). At or above it, it is only useful when
        # something was assessed and it lands within a grade of the slab.
        ok, over = mine >= card["grade"], mine - card["grade"]
        if not ok:
            status, why = "fail", "below the slab grade"
        elif assessable == 0:
            status, why = "warn", "nothing on the edges or corners could be assessed, so this is a ceiling only"
        elif over > 1:
            status, why = "warn", f"{over:g} above the slab"
        else:
            status, why = "pass", "within a grade of the slab"
        steps.append(step("grade", status,
                          f"app best case {card['company']} {mine:g} vs slab {card['grade']:g}: {why} ({len(obs['defects'])} wear flags)", t,
                          ceiling_ok=ok, error=round(over, 1)))
    res["steps"] = steps
    res["status"] = "fail" if any(s["status"] == "fail" for s in steps) else "warn" if any(s["status"] == "warn" for s in steps) else "pass"
    (d / "check.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("key")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="", help="comma-separated card ids")
    ap.add_argument("--skip-identify", action="store_true")
    ap.add_argument("--identify-from", default="", help="reuse identify.json from an earlier run's OUT_DIR instead of calling Gemini")
    a = ap.parse_args()
    key_path = Path(a.key).resolve()
    cards = json.loads(key_path.read_text())
    if a.only:
        want = set(a.only.split(","))
        cards = [c for c in cards if c["id"] in want]
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for c in cards:
        r = check_card(c, key_path.parent, out, a.skip_identify, Path(a.identify_from).resolve() if a.identify_from else None)
        results.append(r)
        print(f"{r['id']:28s} {r.get('status', 'fail'):5s} " + " | ".join(f"{s['step']} {s['status']}" for s in r["steps"]), flush=True)
    (out / "summary.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
