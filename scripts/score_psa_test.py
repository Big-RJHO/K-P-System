"""Score the PSA blind test: compare the system's PSA grade with the true grade for each card, per round.

    python scripts/score_psa_test.py KEY.json RESULTS_DIR [--rounds 1 2 3]

KEY.json: {"<round>": {"<cardNN>": true_grade, ...}}; RESULTS_DIR has <round>_<cardNN>.json files written by
`photo_grade.py grade --json` (named r<round>_<cardNN>.json). A missing file counts as no answer.
"""
import argparse, json, statistics
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("key"); p.add_argument("results"); p.add_argument("--rounds", nargs="*")
a = p.parse_args()
key = json.loads(Path(a.key).read_text())
rows = []
for r, cards in key.items():
    if a.rounds and r not in a.rounds:
        continue
    for card, true in cards.items():
        f = Path(a.results) / f"r{r}_{card}.json"
        if not f.exists():
            continue
        d = json.loads(f.read_text())
        rows.append({"round": r, "card": card, "true": true, "pred": d["psa_grade"], "complete": d["complete"], "label": d["psa_label"]})
print(f"{len(rows)} graded cards")
for x in sorted(rows, key=lambda x: (x["round"], x["true"])):
    print(f"r{x['round']} true {x['true']:>2}  system {x['pred']:>4}  {'complete  ' if x['complete'] else 'incomplete'}  {x['label']}")
n = len(rows)
if n:
    exact = sum(abs(x["pred"] - x["true"]) < 0.01 for x in rows)
    within1 = sum(abs(x["pred"] - x["true"]) <= 1.0 for x in rows)
    within05 = sum(abs(x["pred"] - x["true"]) <= 0.5 for x in rows)
    err = [x["pred"] - x["true"] for x in rows]
    print(f"\nexact {exact}/{n} ({exact/n:.0%}) | within 0.5: {within05}/{n} | within 1: {within1}/{n} ({within1/n:.0%})")
    print(f"mean abs error {statistics.mean(abs(e) for e in err):.2f} grades | mean signed error {statistics.mean(err):+.2f} (positive = system too generous)")
    print(f"complete reports: {sum(x['complete'] for x in rows)}/{n}")
    print("\nper true grade (all rounds): system answers")
    for g in range(1, 11):
        xs = [x["pred"] for x in rows if x["true"] == g]
        if xs:
            print(f"  {g:>2}: {xs}")
    lo = [x for x in rows if x["true"] <= 5]; hi = [x for x in rows if x["true"] >= 8]
    if lo and hi:
        print(f"\nranking check: mean system grade for true 1-5 = {statistics.mean(x['pred'] for x in lo):.2f}, for true 8-10 = {statistics.mean(x['pred'] for x in hi):.2f}")
    # rank correlation (Spearman) without scipy
    def ranks(v):
        s = sorted(range(len(v)), key=lambda i: v[i]); r = [0.0]*len(v); i = 0
        while i < len(s):
            j = i
            while j+1 < len(s) and v[s[j+1]] == v[s[i]]: j += 1
            for k in range(i, j+1): r[s[k]] = (i+j)/2+1
            i = j+1
        return r
    rt, rp = ranks([x["true"] for x in rows]), ranks([x["pred"] for x in rows])
    mt, mp = statistics.mean(rt), statistics.mean(rp)
    num = sum((a-mt)*(b-mp) for a, b in zip(rt, rp)); den = (sum((a-mt)**2 for a in rt)*sum((b-mp)**2 for b in rp))**0.5
    print(f"rank correlation (Spearman): {num/den if den else float('nan'):.2f}")
