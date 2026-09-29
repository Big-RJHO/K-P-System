"""Download today's Riftbound card prices (TCGplayer market prices, via tcgcsv.com) into site/riftbound-prices.json.

    python scripts/fetch_riftbound_prices.py [--out site/riftbound-prices.json]

tcgcsv.com republishes TCGplayer's product and price data once a day (around 20:00 UTC) and its FAQ invites
programmatic downloads with an identifiable User-Agent. Its files don't allow cross-site reads from a browser,
so the phone app can't fetch them directly: the Pages workflow runs this script once a day and serves the
result from the app's own site. About 27 requests per run, 0.3 s apart.

Only single cards are kept (products with a collector number), with each printing's market, low and mid
price. These are ungraded prices: TCGplayer doesn't list graded cards.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://tcgcsv.com/tcgplayer"
CATEGORY = 89  # "Riftbound: League of Legends Trading Card Game"
UA = "CardGradingLab/1.0 (+https://github.com/Big-RJHO/K-P-System)"


def get(url: str) -> list:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.load(r)
    time.sleep(0.3)
    return body.get("results") or []


def ext(product: dict, name: str) -> str:
    for e in product.get("extendedData") or []:
        if e.get("name") == name:
            return str(e.get("value") or "")
    return ""


def money(v):
    return round(float(v), 2) if isinstance(v, (int, float)) and v > 0 else None


def build() -> dict:
    cards = {}
    groups = get(f"{BASE}/{CATEGORY}/groups")
    for g in groups:
        gid, abbr = g["groupId"], g.get("abbreviation") or ""
        products = get(f"{BASE}/{CATEGORY}/{gid}/products")
        prices = get(f"{BASE}/{CATEGORY}/{gid}/prices")
        by_id: dict[int, dict] = {}
        for p in prices:
            row = {"market": money(p.get("marketPrice")), "low": money(p.get("lowPrice")), "mid": money(p.get("midPrice"))}
            if any(row.values()):
                by_id.setdefault(p["productId"], {})[p.get("subTypeName") or "Normal"] = row
        for p in products:
            number = ext(p, "Number")
            if not number:  # sealed product, not a card
                continue
            cards[str(p["productId"])] = {
                "name": p.get("name") or "",
                "number": number,
                "set": abbr,
                "set_name": g.get("name") or "",
                "rarity": ext(p, "Rarity"),
                "url": p.get("url") or "",
                "prices": by_id.get(p["productId"], {}),
            }
    return {
        "source": "TCGplayer market prices via tcgcsv.com",
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "groups": len(groups),
        "cards": cards,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "site" / "riftbound-prices.json"))
    a = ap.parse_args()
    data = build()
    if not data["cards"]:
        print("no cards downloaded; leaving the old file alone", file=sys.stderr)
        return 1
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out} ({len(data['cards'])} cards, {out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
