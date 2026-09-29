"""Card prices (standalone/src/prices.js): PriceCharting search, version matching, grade -> price.

Runs offline through `node -e` with a fake `fetch`. The PriceCharting API needs a paid token, so these
responses are not recordings: the product names, ids and sets are copied from PriceCharting's public
search page (2026-09-29), the JSON shape and the error body from its API documentation and a real
"Unknown access token" reply, and the prices are made up.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src" / "prices.js"
FIX = ROOT / "tests" / "fixtures"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

TOKEN = "0123456789abcdef0123456789abcdef01234567"

PRELUDE = """
const P = require(%s);
const TOKEN = %s;
const calls = [];
const products = {status: "success", products: [
  {id: "715593", "product-name": "Charizard [1st Edition] #4", "console-name": "Pokemon Base Set"},
  {id: "630417", "product-name": "Charizard #4", "console-name": "Pokemon Base Set"},
  {id: "715695", "product-name": "Charizard [Shadowless] #4", "console-name": "Pokemon Base Set"},
  {id: "641807", "product-name": "Charizard #4", "console-name": "Pokemon Base Set 2"},
  {id: "7307451", "product-name": "Charizard [Black Dot Error] #4", "console-name": "Pokemon Base Set"},
]};
const product = {status: "success", id: "630417", "product-name": "Charizard #4", "console-name": "Pokemon Base Set",
  "loose-price": 35975, "condition-9-price": 9000, "condition-16-price": 52000, "cib-price": 76500, "new-price": 99000,
  "graded-price": 133750, "box-only-price": 250000, "manual-only-price": 1200000, "bgs-10-price": 2000000,
  "condition-17-price": 900000, "condition-21-price": 1500000};
const store = new Map();
const storage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i], get length() { return store.size; } };
async function fakeFetch(url) {
  calls.push(url);
  const u = new URL(url);
  if (u.searchParams.get("t") !== TOKEN) return { ok: false, status: 403, json: async () => ({error: "Unknown access token", "error-message": "Unknown access token", status: "error"}) };
  if (u.pathname === "/api/products") return { ok: true, status: 200, json: async () => products };
  if (u.pathname === "/api/product") return { ok: true, status: 200, json: async () => ({...product, id: u.searchParams.get("id")}) };
  return { ok: false, status: 404, json: async () => ({status: "error", "error-message": "not found"}) };
}
const opts = { token: TOKEN, fetch: fakeFetch, storage };
const charizard = { game: "pokemon", name: "Charizard", number: "4/102", set_name: "Base Set", finish: "Holo" };
"""


def run(body: str):
    code = PRELUDE % (json.dumps(str(SRC)), json.dumps(TOKEN)) + "\n(async () => {\n" + body + "\n})().catch((e) => { console.error(e); process.exit(1); });"
    out = subprocess.run([NODE, "-e", code], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_query_and_links_use_pricecharting_naming():
    r = run("""
      console.log(JSON.stringify({
        q: P.query(charizard),
        rb: P.query({ game: "riftbound", name: "Ahri, Inquisitive", number: "SP3/006", set_name: "Vendetta" }),
        nums: ["125/197", "025", "SP3/006", "TG05/TG30", "4"].map(P.pcNumber),
        url: P.searchUrl(charizard),
        product: P.productUrl({ id: "630417" }),
      }));""")
    assert r["q"] == "Charizard #4 Pokemon Base Set"
    assert r["rb"] == "Ahri, Inquisitive #SP3 Riftbound Vendetta"
    assert r["nums"] == ["125", "25", "SP3", "TG05", "4"]
    assert r["url"] == "https://www.pricecharting.com/search-products?type=prices&q=Charizard%20%234%20Pokemon%20Base%20Set"
    assert r["product"] == "https://www.pricecharting.com/game/630417"


def test_ranking_prefers_the_plain_card_and_flags_special_versions():
    r = run("""
      const ranked = P.rankProducts(products.products, charizard);
      console.log(JSON.stringify(ranked.map((m) => [m.id, Math.round(m.score * 100), m.variant])));""")
    ids = [x[0] for x in r]
    assert ids[0] == "630417"                       # Charizard #4, Pokemon Base Set, no bracketed version
    assert ids.index("641807") > ids.index("715695")  # a different set ranks below a same-set special version
    assert all(x[2] for x in r if x[0] in ("715593", "715695", "7307451"))


def test_search_then_product_prices_and_cache():
    r = run("""
      const s = await P.search(charizard, opts);
      const p1 = await P.product(s.best.id, opts);
      const n = calls.length;
      const p2 = await P.product(s.best.id, opts);          // from the 24 h cache
      const again = await P.search(charizard, opts);         // also cached
      const cachedCalls = calls.length - n;
      P.clearCache(storage);
      console.log(JSON.stringify({ best: s.best.id, choice: s.needs_choice, loose: p1.prices["loose-price"], psa10: p1.prices["manual-only-price"],
        missing: p1.prices["condition-18-price"], same: JSON.stringify(p1) === JSON.stringify(p2), cachedCalls, left: storage.length,
        tokenInUrl: calls.every((c) => c.includes("t=" + TOKEN)) }));""")
    assert r["best"] == "630417"
    assert r["choice"] is True       # 1st Edition / Shadowless copies exist: the user is asked to check the version
    assert r["loose"] == 35975 and r["psa10"] == 1200000 and r["missing"] is None
    assert r["same"] and r["cachedCalls"] == 0 and r["left"] == 0 and r["tokenInUrl"]


def test_calls_are_spaced_to_the_rate_limit():
    r = run("""
      P._reset();
      const times = [];
      const timed = async (url) => { times.push(Date.now()); return fakeFetch(url); };
      await P.search(charizard, { ...opts, fetch: timed, storage: null });
      await P.product("630417", { ...opts, fetch: timed, storage: null });
      console.log(JSON.stringify({ gap: times[1] - times[0] }));""")
    assert r["gap"] >= 1000   # PriceCharting allows one call per second


def test_no_token_means_no_request_and_bad_token_is_explained():
    r = run("""
      const none = await P.search(charizard, { fetch: fakeFetch });
      let msg = "";
      try { await P.search(charizard, { token: "f".repeat(40), fetch: fakeFetch }); } catch (e) { msg = e.message; }
      console.log(JSON.stringify({ none: none.error, calls: calls.length, msg,
        valid: [P.validToken(TOKEN), P.validToken("abc"), P.validToken(TOKEN + "0")] }));""")
    assert r["none"] == "no-token"
    assert r["calls"] == 1   # only the bad-token attempt reached the network
    assert "didn't accept the API token" in r["msg"]
    assert r["valid"] == [True, False, False]


def test_grade_to_price_key():
    r = run("""
      const g = (company, grade, label, extra = {}) => P.gradeKey({ company, grade, label, tier: 0, ...extra });
      console.log(JSON.stringify({
        psa10: g("PSA", 10, "Gem Mint 10").key,
        bgs10: g("BGS", 10, "Pristine 10").key,
        black: g("BGS", 10, "Pristine 10 (Black Label)").key,
        bgs95: g("BGS", 9.5, "Gem Mint 9.5").key,
        cgcP: g("CGC", 10, "Pristine 10").key,
        cgc10: g("CGC", 10, "Gem Mint 10").key,
        tagP: g("TAG", 10, "Pristine 10"),
        tag10: g("TAG", 10, "Gem Mint 10"),
        psa9: g("PSA", 9, "Mint 9"),
        n85: g("BGS", 8.5, "NM-MT+ 8.5").key,
        n75: g("CGC", 7.5, "Near Mint+ 7.5").key,
        n65: g("BGS", 6.5, "EX-MT+ 6.5"),
        n1: g("PSA", 1, "Poor 1").key,
        ceiling: g("PSA", 9, "Up to Mint 9 · incomplete").key,
        altered: g("PSA", 0, "Authentic Altered", { tier: 99 }).key,
      }));""")
    assert r["psa10"] == "manual-only-price" and r["bgs10"] == "bgs-10-price" and r["black"] == "condition-20-price"
    assert r["bgs95"] == "box-only-price"
    assert r["cgcP"] == "condition-19-price" and r["cgc10"] == "condition-17-price"
    assert r["tagP"]["key"] == "condition-21-price" and r["tagP"]["note"] == ""
    assert r["tag10"]["key"] == "condition-21-price" and "one TAG 10 price" in r["tag10"]["note"]
    assert r["psa9"]["key"] == "graded-price" and "any grading company" in r["psa9"]["note"]
    assert r["n85"] == "new-price" and r["n75"] == "cib-price" and r["n1"] == "condition-9-price"
    assert r["n65"]["key"] == "condition-16-price" and "no separate 6.5 price" in r["n65"]["note"]
    assert r["ceiling"] == "graded-price"
    assert r["altered"] is None


def test_report_prices_mark_ceilings():
    r = run("""
      const p = await P.product("630417", opts);
      const report = { complete: false, grades: {
        PSA: { company: "PSA", grade: 9, label: "Up to Mint 9 · incomplete", tier: null, complete: false },
        BGS: { company: "BGS", grade: 9.5, label: "Up to Gem Mint 9.5 · incomplete", tier: null, complete: false },
        CGC: { company: "CGC", grade: 10, label: "Up to Pristine 10 · incomplete", tier: null, complete: false },
        TAG: { company: "TAG", grade: 10, label: "Up to Gem Mint 10 · incomplete", tier: null, complete: false },
      } };
      const out = P.forReport(p, report);
      console.log(JSON.stringify({ ungraded: out.ungraded, ceiling: out.ceiling, rows: out.rows.map((x) => [x.company, x.key, x.cents, x.ceiling, x.note]) }));""")
    assert r["ungraded"] == 35975 and r["ceiling"] is True
    rows = {x[0]: x for x in r["rows"]}
    assert rows["PSA"][1:4] == ["graded-price", 133750, True]
    assert rows["BGS"][1:3] == ["box-only-price", 250000]
    assert rows["CGC"][1:3] == ["condition-19-price", None] and "no sales at this grade" in rows["CGC"][4]
    assert rows["TAG"][1:3] == ["condition-21-price", 1500000]


def test_tcgdex_market_prices_are_read_from_the_card_record():
    pricing = json.loads((FIX / "tcgdex_card_sv03-125.json").read_text())["pricing"]
    r = run(f"console.log(JSON.stringify({{ m: P.fromTcgdex({json.dumps(pricing)}), none: P.fromTcgdex(null), money: [P.money(35975), P.money(null), P.money(123456789)] }}));")
    m = r["m"]
    assert m is not None and (m.get("tcgplayer") or m.get("cardmarket"))
    if m.get("tcgplayer"):
        assert m["tcgplayer"]["unit"] == "USD" and m["tcgplayer"]["versions"][0]["market"] > 0
    assert r["none"] is None
    assert r["money"] == ["$359.75", "—", "$1,234,567.89"]
