"""Recent sales from CardSight AI (standalone/src/cardsight.js), for Pokemon cards.

Runs offline through `node -e` with a fake `fetch`. The responses follow CardSight's published OpenAPI
spec (api.cardsight.ai/documentation/json, checked 2026-09-29); no CardSight key was used, so they are
not recordings, and the prices are made up.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src" / "cardsight.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

PRELUDE = """
const C = require(%s);
const KEY = "csa_live_TESTKEY000000000000000000";
const calls = [];
const U = (n) => "00000000-0000-4000-8000-00000000000" + n;
const search = { results: [
  { type: "set", id: U(9), name: "Base Set", segmentName: "Pokemon" },
  { type: "card", id: U(1), name: "Charizard", cardNumber: "4", setName: "Base Set", releaseName: "1999 Pokemon Base Set", year: "1999", segmentName: "Pokemon" },
  { type: "card", id: U(2), name: "Charizard", cardNumber: "4", setName: "Base Set 2", releaseName: "2000 Pokemon Base Set 2", year: "2000", segmentName: "Pokemon" },
  { type: "card", id: U(3), name: "Charizard", cardNumber: "4", setName: "Base Set", releaseName: "1999 Topps Pokemon TV Animation", year: "1999", segmentName: "Baseball" },
  { type: "card", id: U(4), name: "Blastoise", cardNumber: "2", setName: "Base Set", releaseName: "1999 Pokemon Base Set", year: "1999", segmentName: "Pokemon" },
], total_count: 5, skip: 0, take: 25 };
const rec = (price, date, extra = {}) => ({ title: "Charizard 4/102", price, date, source: "ebay", listing_type: "auction", url: "https://www.ebay.com/itm/" + price, parallel_id: null, parallel_name: null, ...extra });
const pricing = {
  card: { card_id: U(1), name: "Charizard", number: "4", set: { set_id: U(9), name: "Base Set", year: "1999", release: "1999 Pokemon Base Set" } },
  query: { period: "1y", listing_type: "auction" },
  raw: { count: 4, records: [rec(300, "2026-09-01"), rec(360, "2026-09-20"), rec(420, "2026-08-11"), rec(2900, "2026-07-01", { parallel_id: U(7), parallel_name: "1st Edition" })] },
  graded: [
    { company_name: "PSA", company_id: U(5), grades: [
      { grade_value: "9", grade_id: U(6), count: 3, records: [rec(1300, "2026-09-10"), rec(1400, "2026-08-02"), rec(1250, "2026-06-15")] },
      { grade_value: "10", grade_id: U(8), count: 1, records: [rec(11000, "2026-05-05")] } ] },
    { company_name: "BGS", company_id: U(0), grades: [ { grade_value: "9.5", grade_id: U(6), count: 1, records: [rec(4200, "2026-04-04")] } ] },
  ],
  meta: { sources: [{ source: "ebay", count: 9 }], last_sale_date: "2026-09-20", total_records: 9 },
  messages: [],
};
const store = new Map();
const storage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i], get length() { return store.size; } };
async function fakeFetch(url, init) {
  calls.push({ url, key: init.headers["X-API-Key"] });
  if (init.headers["X-API-Key"] !== KEY) return { ok: false, status: 401, json: async () => ({ error: "API key is required", code: "AUTHENTICATION_ERROR" }) };
  const u = new URL(url);
  if (u.pathname === "/v1/catalog/search") return { ok: true, status: 200, json: async () => search };
  if (u.pathname === "/v1/pricing/" + U(1)) return { ok: true, status: 200, json: async () => pricing };
  return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
}
const opts = { apiKey: KEY, fetch: fakeFetch, storage };
const card = { game: "pokemon", name: "Charizard", number: "4/102", set_name: "Base Set" };
const report = { complete: false, grades: {
  PSA: { company: "PSA", grade: 9, label: "Up to MINT 9 · incomplete", tier: null, complete: false },
  BGS: { company: "BGS", grade: 9.5, label: "Up to Gem Mint 9.5 · incomplete", tier: null, complete: false },
  CGC: { company: "CGC", grade: 10, label: "Up to Pristine 10 · incomplete", tier: null, complete: false },
  TAG: { company: "TAG", grade: 9, label: "Up to Mint 9 · incomplete", tier: null, complete: false },
} };
"""


def run(js: str):
    code = PRELUDE % json.dumps(str(SRC)) + "\n(async () => {\n" + js + "\n})().catch((e) => { console.error(e); process.exit(1); });"
    out = subprocess.run([NODE, "-e", code], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_find_card_ranks_the_right_pokemon_card():
    r = run("""
      const f = await C.findCard(card, opts);
      console.log(JSON.stringify({ url: calls[0].url, header: calls[0].key === KEY, best: f.best && f.best.id,
        ids: f.matches.map((m) => m.id), choice: f.needs_choice }));""")
    assert r["url"] == "https://api.cardsight.ai/v1/catalog/search?q=Charizard%204%20Base%20Set&type=card&take=25"
    assert r["header"] is True
    assert r["best"].endswith("1")
    assert not any(i.endswith("3") or i.endswith("9") for i in r["ids"])   # baseball segment and set results are left out
    assert r["ids"].index(r["best"]) == 0 and r["ids"][-1].endswith("4")    # different number ranks last


def test_sales_summary_for_the_report():
    r = run("""
      const d = await C.sales("00000000-0000-4000-8000-000000000001", opts);
      const base = C.forReport(d, report, "");
      const first = C.forReport(d, report, "00000000-0000-4000-8000-000000000007");
      console.log(JSON.stringify({ base, first: first.ungraded, versions: C.versions(d).map((v) => [v.name, v.count]),
        url: calls[0].url }));""")
    assert r["url"].endswith("/v1/pricing/00000000-0000-4000-8000-000000000001?period=1y&listing_type=auction&limit=500")
    b = r["base"]
    assert b["ungraded"]["count"] == 3 and b["ungraded"]["median"] == 360 and b["ungraded"]["last"]["date"] == "2026-09-20"
    rows = {x["company"]: x for x in b["rows"]}
    assert rows["PSA"]["stats"]["median"] == 1300 and rows["PSA"]["ceiling"] is True
    assert rows["BGS"]["stats"]["median"] == 4200
    assert rows["CGC"]["stats"] is None and "No sales" in rows["CGC"]["note"]
    assert rows["TAG"]["stats"] is None
    assert b["ceiling"] is True and [(a["company"], a["grade"]) for a in b["all"]] == [("BGS", "9.5"), ("PSA", "10"), ("PSA", "9")]
    assert r["first"]["count"] == 1 and r["first"]["median"] == 2900     # 1st Edition kept apart from the base card
    assert r["versions"] == [["Base card", 8], ["1st Edition", 1]]


def test_cache_and_purge():
    r = run("""
      await C.findCard(card, opts); await C.sales("00000000-0000-4000-8000-000000000001", opts);
      const n = calls.length;
      await C.findCard(card, opts); await C.sales("00000000-0000-4000-8000-000000000001", opts);
      const later = { ...opts, now: () => Date.now() + 25 * 3600 * 1000 };
      await C.sales("00000000-0000-4000-8000-000000000001", later);
      const afterExpiry = calls.length;
      C.clearCache(storage);
      console.log(JSON.stringify({ n, again: afterExpiry - n, left: storage.length }));""")
    assert r["n"] == 2 and r["again"] == 1 and r["left"] == 0   # cached for 24 h only, purged on request


def test_errors():
    r = run("""
      const msgs = [];
      const bad = async (status) => ({ ok: false, status, json: async () => ({ error: "x" }) });
      for (const o of [{ ...opts, apiKey: "" }, { ...opts, apiKey: "csa_live_WRONG0000000000000000" }, { ...opts, fetch: () => bad(429) },
                       { ...opts, fetch: () => bad(500) }, { ...opts, fetch: async () => { throw new TypeError("Failed to fetch"); } }]) {
        try { await C.findCard(card, { ...o, storage: null }); msgs.push("ok"); } catch (e) { msgs.push(e.message); }
      }
      const missing = await C.sales("00000000-0000-4000-8000-00000000000f", opts);
      console.log(JSON.stringify({ msgs, missing, keys: [C.validKey(KEY), C.validKey("short"), C.validKey("has spaces in it 0000000000")] }));""")
    m = r["msgs"]
    assert m[0] == "no-key" and "didn't accept the API key" in m[1] and "750 calls a month" in m[2] and "answered with an error: x" in m[3] and "couldn't be reached" in m[4]
    assert r["missing"] is None and r["keys"] == [True, False, False]
