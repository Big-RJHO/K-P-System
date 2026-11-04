"""The owner has TAG's written permission to collect TAG reports and images for personal research. TAG data
(reports, scans, cert lists) stays outside this repository; only code lives here.

Collect the agents' result files and the harness re-run into CSVs for the tracker.

  python -I aggregate.py --work WORK_DIR [--rerun RERUN_DIR] [--out OUT_DIR]
reads WORK_DIR/agent_runs/agent-*/*.agent.json (and WORK_DIR/agent_runs/<agent>/tag/<cert>.json), writes
OUT_DIR (default WORK_DIR/tracker)/{agent_cards,agent_steps,tag_reports}.csv. WORK_DIR defaults to $TAGDB_WORK.
"""
import argparse, csv, glob, json, os, sys
from datetime import datetime

_ap = argparse.ArgumentParser(description="Collect agent result files into tracker CSVs")
_ap.add_argument("--work", default=os.environ.get("TAGDB_WORK"), help="work dir holding agent_runs/ (default $TAGDB_WORK)")
_ap.add_argument("--rerun", default="", help="harness re-run dir (latest harness), optional")
_ap.add_argument("--out", default=None, help="output dir (default WORK/tracker)")
_args = _ap.parse_args()
if not _args.work:
    sys.exit("set --work or TAGDB_WORK")
SP = _args.work.rstrip("/")
RERUN = _args.rerun
OUT = (_args.out or SP + "/tracker").rstrip("/") + "/"
os.makedirs(OUT, exist_ok=True)
ORDER = ["cert_lookup", "key_entry", "scan", "outline_check", "identify", "centering", "grade", "defects_compare"]
LABEL = {"cert_lookup": "Cert lookup", "key_entry": "Key entry", "scan": "Scan", "outline_check": "Outline", "identify": "Identify",
         "centering": "Centering", "grade": "Grade", "defects_compare": "Defects vs report"}
RANK = {"fail": 3, "warn": 2, "pass": 1, "skipped": 0}


def w(name, rows, cols):
    with open(OUT + name, "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=cols); wr.writeheader()
        for r in rows: wr.writerow({c: ("" if r.get(c) is None else r.get(c)) for c in cols})


def iso(s):
    try: return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception: return None


cards, steps, reports = [], [], []
for f in sorted(glob.glob(SP + "/agent_runs/agent-*/*.agent.json")):
    a = json.load(open(f))
    agent = a.get("agent") or f.split("/")[-2]
    by = {s["step"]: s for s in a.get("steps", [])}
    # Harness steps from the re-run with the latest harness, where there is one; the agents' own checks stay.
    if RERUN and os.path.exists(f"{RERUN}/{agent}/{a['id']}/check.json"):
        chk = json.load(open(f"{RERUN}/{agent}/{a['id']}/check.json"))
        for s in chk["steps"]:
            if s["step"] in ("scan", "centering", "grade"):
                by[s["step"]] = {"step": s["step"], "status": s["status"], "detail": s["detail"], "seconds": s.get("seconds")}
            if s["step"] == "identify":
                agent_says = by.get("identify", {})
                if RANK.get(s["status"], 0) > RANK.get(agent_says.get("status"), 0):
                    # the harness is stricter than the agent: take its status
                    by["identify"] = {**agent_says, "status": s["status"], "detail": s["detail"] + "; agent: " + agent_says.get("detail", "")}
                elif s["status"] == "pass" and agent_says.get("status") in ("warn", "fail") and s.get("first_match_ok"):
                    # fixed since the agent looked: the re-run's first match is the exact database entry
                    by["identify"] = {**agent_says, "status": "pass", "detail": "Re-run after the lookup fix: " + s["detail"] + ". The agent's original finding: " + agent_says.get("detail", "")}
                    a["summary"] = (a.get("summary") or "") + " Since fixed: the re-run identifies the exact Japanese card."
                    a["identified_as"] = "ナツメのゲンガー #054 · 闇からの挑戦 (JP)"
        if "app_grade" in chk: a["app_grade"] = chk["app_grade"]
    st = [by.get(k, {"step": k, "status": "skipped", "detail": "not run", "seconds": None}) for k in ORDER]
    verdict = max((s["status"] for s in st), key=lambda x: RANK.get(x, 0))
    t0, t1 = iso(a.get("started_at")), iso(a.get("finished_at"))
    d = a.get("defects") or {}
    cards.append({"id": a["id"], "agent": agent, "company": a.get("company"), "cert": a.get("cert") or "", "true_grade": a.get("true_grade"),
                  "report_grade": a.get("report_grade"), "report_score": a.get("report_score"), "app_grade": a.get("app_grade"),
                  "identified_as": a.get("identified_as"), "report_card": a.get("report_card"), "verdict": verdict,
                  "summary": a.get("summary"), "tag_dings": d.get("tag_dings"), "matched": d.get("matched"), "missed": d.get("missed"),
                  "missed_surface": d.get("missed_surface"), "extra": d.get("extra"),
                  "minutes": round((t1 - t0).total_seconds() / 60, 1) if t0 and t1 else None})
    for i, s in enumerate(st):
        steps.append({"key": f"{a['id']}|{s['step']}", "id": a["id"], "agent": agent, "step": s["step"], "step_label": LABEL[s["step"]], "step_order": i + 1,
                      "status": s.get("status", "skipped"), "detail": s.get("detail", ""), "seconds": s.get("seconds")})
    if a.get("company") == "TAG":
        tj = glob.glob(f"{SP}/agent_runs/{agent}/tag/{a.get('cert')}.json")
        if tj:
            t = json.load(open(tj[0]))
            dg = t.get("dings") or {}
            g = lambda c, s: (dg.get(c) or {}).get(s)
            cen = (t.get("centering") or {})
            app = json.load(open(f"{RERUN or SP + '/agent_runs'}/{agent}/{a['id']}/check.json")).get("centering_vs_report", {}) if RERUN else {}
            reports.append({"cert": t.get("cert"), "id": a["id"], "tag_grade": t.get("grade"), "tag_score": t.get("score"), "grade_label": t.get("grade_label"),
                            "centering_front": cen.get("front"), "centering_back": cen.get("back"),
                            "app_front": f"{app['front']['app_lr']}/{app['front']['app_tb']}" if "front" in app else "",
                            "app_back": f"{app['back']['app_lr']}/{app['back']['app_tb']}" if "back" in app else "",
                            "corner_dings": (g("corners", "front") or 0) + (g("corners", "back") or 0),
                            "edge_dings": (g("edges", "front") or 0) + (g("edges", "back") or 0),
                            "surface_dings": (g("surface", "front") or 0) + (g("surface", "back") or 0),
                            "ding_types": "; ".join(f"{x['side']} {x['location']}: {x['type']}" for x in t.get("ding_list", [])),
                            "graded_on": t.get("graded_on"), "url": t.get("source_url")})
cards.sort(key=lambda c: (c["agent"], c["company"], float(c["true_grade"] or 0)))
w("agent_cards.csv", cards, list(cards[0].keys()))
w("agent_steps.csv", steps, list(steps[0].keys()))
if reports:
    reports.sort(key=lambda r: float(r["tag_grade"] or 0))
    w("tag_reports.csv", reports, list(reports[0].keys()))
print(len(cards), "cards", len(steps), "steps", len(reports), "TAG reports")
from collections import Counter
print(Counter(c["verdict"] for c in cards)); print(Counter((s["step"], s["status"]) for s in steps))
