"""Score a blind grading test: compare the system's grade for each card with the grade on its real slab.

    python scripts/score_blind_test.py KEY.json RESULTS_DIR [--rounds A B] [--set psa tag]

KEY.json: {"<round>": {"<card>": {"set": "psa"|"tag", "company": "PSA"|"TAG", "grade": 8.5}}}.
RESULTS_DIR holds `<round>_<card>.json` files written by `photo_grade.py grade --json`; a missing file is skipped.
For TAG, the system's Pristine 10 (10.5 internally) counts as a 10, like the slab label.

Reported separately:
- firm grades: complete reports, where the system committed to a grade;
- best-case answers: incomplete reports ("Up to …"), where the number is only a ceiling. A ceiling is
  "consistent" when the true grade is at or below it.
"""
import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path


def spearman(a, b):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2 + 1
            i = j + 1
        return r
    ra, rb = ranks(a), ranks(b)
    ma, mb = statistics.mean(ra), statistics.mean(rb)
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = (sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb)) ** 0.5
    return num / den if den else float("nan")


def summary(rows, title):
    if not rows:
        return
    n = len(rows)
    err = [r["pred"] - r["true"] for r in rows]
    exact = sum(abs(e) < 0.01 for e in err)
    w05 = sum(abs(e) <= 0.5 for e in err)
    w1 = sum(abs(e) <= 1.0 for e in err)
    print(f"{title}: n={n} | exact {exact} ({exact/n:.0%}) | within 0.5 {w05} ({w05/n:.0%}) | within 1 {w1} ({w1/n:.0%}) "
          f"| mean abs err {statistics.mean(abs(e) for e in err):.2f} | bias {statistics.mean(err):+.2f}"
          + (f" | rank corr {spearman([r['true'] for r in rows], [r['pred'] for r in rows]):.2f}" if n > 2 else ""))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("key")
    p.add_argument("results")
    p.add_argument("--rounds", nargs="*")
    p.add_argument("--set", nargs="*", dest="sets")
    p.add_argument("--list", action="store_true", help="print every card")
    a = p.parse_args()
    key = json.loads(Path(a.key).read_text())
    rows = []
    for rnd, cards in key.items():
        if a.rounds and rnd not in a.rounds:
            continue
        for card, k in cards.items():
            if a.sets and k["set"] not in a.sets:
                continue
            f = Path(a.results) / f"{rnd}_{card}.json"
            if not f.exists():
                continue
            d = json.loads(f.read_text())
            g = d["grades"][k["company"]]
            pred = min(10.0, g["grade"]) if k["company"] == "TAG" else g["grade"]
            rows.append({"round": rnd, "card": card, "id": k.get("id", card), "set": k["set"], "company": k["company"], "true": k["grade"],
                         "pred": pred, "complete": g["complete"], "label": g["label"]})
    print(f"{len(rows)} graded runs")
    if a.list:
        for r in sorted(rows, key=lambda r: (r["set"], r["true"], r["card"], r["round"])):
            print(f"  {r['set']} {r['round']:>3} {r['card']:<8} true {r['true']:>4}  system {r['pred']:>4}  "
                  f"{'firm      ' if r['complete'] else 'best-case '} {r['label']}")
    for s in sorted({r["set"] for r in rows}):
        rs = [r for r in rows if r["set"] == s]
        comp = rs[0]["company"]
        print(f"\n== {s.upper()} set ({comp} grades) ==")
        summary(rs, "all answers (ceilings counted as answers)")
        firm = [r for r in rs if r["complete"]]
        ceil = [r for r in rs if not r["complete"]]
        summary(firm, "firm grades only")
        print(f"best-case only (incomplete): {len(ceil)}/{len(rs)}"
              + (f"; ceiling at or above the true grade in {sum(r['pred'] >= r['true'] for r in ceil)}/{len(ceil)}" if ceil else ""))
        by = defaultdict(list)
        for r in rs:
            by[r["true"]].append(r["pred"])
        print("true grade -> system answers: " + "; ".join(f"{t:g}: {sorted(v)}" for t, v in sorted(by.items())))
        # Agreement between rounds on the same card (different agents, same photos).
        per_card = defaultdict(list)
        for r in rs:
            per_card[r["id"]].append(r["pred"])
        multi = [v for v in per_card.values() if len(v) > 1]
        if multi:
            same = sum(max(v) - min(v) < 0.01 for v in multi)
            spread = statistics.mean(max(v) - min(v) for v in multi)
            print(f"repeat runs: {len(multi)} cards graded more than once; identical answer on {same}, mean spread {spread:.2f} grades")


if __name__ == "__main__":
    main()
