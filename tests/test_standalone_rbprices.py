"""Riftbound prices (standalone/src/rbprices.js) and the daily download (scripts/fetch_riftbound_prices.py).

Offline. The product and price rows copy the shape of tcgcsv.com's TCGplayer data (checked 2026-09-29,
e.g. Vendetta product 705996 "Ahri, Inquisitive", SP3/006, Foil market $76.22).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src" / "rbprices.js"
NODE = shutil.which("node")

DATA = {"source": "TCGplayer market prices via tcgcsv.com", "updated_at": "2026-09-29T21:45:11Z", "cards": {
    "705996": {"name": "Ahri, Inquisitive", "number": "SP3/006", "set": "VEN", "set_name": "Vendetta", "rarity": "Showcase",
               "url": "https://www.tcgplayer.com/product/705996/x", "prices": {"Foil": {"market": 76.22, "low": 69.99, "mid": 90.87}}},
    "652771": {"name": "Blazing Scorcher", "number": "001/298", "set": "OGN", "set_name": "Origins", "rarity": "Common",
               "url": "https://www.tcgplayer.com/product/652771/y", "prices": {"Normal": {"market": 0.08, "low": 0.02, "mid": 0.1},
                                                                             "Foil": {"market": 1.0, "low": 0.5, "mid": 1.2}}},
    "705997": {"name": "Akali, Deadly Weapon (Alternate Art)", "number": "021a/166", "set": "VEN", "set_name": "Vendetta", "rarity": "Showcase",
               "url": "https://www.tcgplayer.com/product/705997/z", "prices": {}},
}}


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_load_find_and_rows():
    js = f"""
      const R = require({json.dumps(str(SRC))});
      const DATA = {json.dumps(DATA)};
      (async () => {{
        let urls = [];
        const f = async (url) => {{ urls.push(url); return {{ ok: true, status: 200, json: async () => DATA }}; }};
        const d = await R.load({{ fetch: f }});
        await R.load({{ fetch: f }});                       // loaded once per page session
        const byId = R.find(d, {{ tcgplayer_id: "705996", name: "Ahri, Inquisitive" }});
        const bySet = R.find(d, {{ set_code: "OGN", number: "1/298", name: "Blazing Scorcher" }});
        const alt = R.find(d, {{ set_code: "VEN", number: "21a/166", name: "Akali" }});
        const wrongName = R.find(d, {{ set_code: "VEN", number: "SP3/006", name: "Jinx" }});
        const none = R.find(d, {{ set_code: "VEN", number: "999/166" }});
        R._reset();
        let err = "";
        try {{ await R.load({{ fetch: async () => ({{ ok: false, status: 404, json: async () => ({{}}) }}) }}); }} catch (e) {{ err = e.message; }}
        console.log(JSON.stringify({{ urls, byId: [byId.id, byId.how, byId.name_matches], bySet: [bySet.id, bySet.how], alt: alt.id,
          wrongName: wrongName.name_matches, none, rows: R.rows(bySet.card), keys: ["001/298", "sp3/006", "021a/166"].map(R.numKey), err }}));
      }})().catch((e) => {{ console.error(e); process.exit(1); }});"""
    out = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    r = json.loads(out.stdout)
    assert r["urls"] == ["https://big-rjho.github.io/K-P-System/riftbound-prices.json"]
    assert r["byId"] == ["705996", "tcgplayer id", True]
    assert r["bySet"] == ["652771", "set and number"] and r["alt"] == "705997"
    assert r["wrongName"] is False and r["none"] is None
    assert [x["printing"] for x in r["rows"]] == ["Foil", "Normal"] and r["rows"][0]["market"] == 1.0
    assert r["keys"] == ["1/298", "SP3/6", "21A/166"]
    assert "HTTP 404" in r["err"]


def test_download_script_keeps_cards_only(monkeypatch, tmp_path):
    sys.path.insert(0, str(ROOT / "scripts"))
    import fetch_riftbound_prices as f

    pages = {
        "https://tcgcsv.com/tcgplayer/89/groups": [{"groupId": 1, "name": "Vendetta", "abbreviation": "VEN"}],
        "https://tcgcsv.com/tcgplayer/89/1/products": [
            {"productId": 705996, "name": "Ahri, Inquisitive", "url": "https://www.tcgplayer.com/product/705996/x",
             "extendedData": [{"name": "Number", "value": "SP3/006"}, {"name": "Rarity", "value": "Showcase"}]},
            {"productId": 1, "name": "Vendetta - Booster Display", "url": "u", "extendedData": []}],
        "https://tcgcsv.com/tcgplayer/89/1/prices": [
            {"productId": 705996, "subTypeName": "Foil", "marketPrice": 76.22, "lowPrice": 69.99, "midPrice": 90.87},
            {"productId": 1, "subTypeName": "Normal", "marketPrice": 120.0, "lowPrice": 100.0, "midPrice": 110.0}],
    }
    monkeypatch.setattr(f, "get", lambda url: pages[url])
    data = f.build()
    assert list(data["cards"]) == ["705996"]
    assert data["cards"]["705996"]["prices"] == {"Foil": {"market": 76.22, "low": 69.99, "mid": 90.87}}
    assert data["cards"]["705996"]["set"] == "VEN" and data["source"].endswith("tcgcsv.com")
