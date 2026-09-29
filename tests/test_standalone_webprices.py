"""Web price search through Gemini with Google Search grounding (standalone/src/webprices.js).

Runs offline through `node -e` with a fake `fetch`. The response below follows the documented
generateContent shape (candidates[].content.parts, groundingMetadata.groundingChunks / webSearchQueries /
searchEntryPoint.renderedContent); no Gemini key was used, so it is not a recording. The prices are made up.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src" / "webprices.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

PRELUDE = """
const W = require(%s);
const KEY = "AIzaSyTESTKEY0000000000000000000000000";
const calls = [];
const answer = {
  card_found: "Charizard, Base Set (Unlimited) 4/102",
  prices: [
    { grade: "Ungraded", price_usd: 360, kind: "sold", date: "2026-09-12", source: "ebay.com" },
    { grade: "PSA 9", price_usd: "$1,337.50", kind: "sold", date: "2026-08", source: "www.ebay.com" },
    { grade: "PSA 10", price_usd: 12000, kind: "market", date: "2026-09-01", source: "pricecharting.com" },
    { grade: "BGS 9.5", price_usd: 4200, kind: "sold", date: "2026-07-30", source: "goldin.co" },
    { grade: "TAG 9", price_usd: -5, source: "ebay.com" },
    { grade: "Mystery grade", price_usd: 10, source: "ebay.com" },
  ],
  notes: "Few recent sales at BGS 9.5.",
};
const body = { candidates: [{ finishReason: "STOP",
  content: { parts: [{ text: "Here you go:\\n```json\\n" + JSON.stringify(answer) + "\\n```" }] },
  groundingMetadata: {
    webSearchQueries: ["Charizard Base Set 4/102 PSA 9 sold"],
    searchEntryPoint: { renderedContent: "<style>.chip{}</style><a class=chip href=https://www.google.com/search?q=charizard>charizard base set</a>" },
    groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "ebay.com" } },
                      { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def", title: "pricecharting.com" } }],
  } }] };
async function fakeFetch(url, init) {
  calls.push({ url, init });
  if (init.headers["x-goog-api-key"] !== KEY) return { ok: false, status: 400, json: async () => ({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }) };
  return { ok: true, status: 200, json: async () => body };
}
const card = { game: "pokemon", name: "Charizard", set_name: "Base Set", number: "4/102", finish: "Holo" };
const report = { complete: false, grades: {
  PSA: { company: "PSA", grade: 9, label: "Up to MINT 9 · incomplete", tier: null },
  BGS: { company: "BGS", grade: 9.5, label: "Up to Gem Mint 9.5 · incomplete", tier: null },
  CGC: { company: "CGC", grade: 10, label: "Up to Pristine 10 · incomplete", tier: null },
  TAG: { company: "TAG", grade: 9, label: "Up to Mint 9 · incomplete", tier: null },
} };
"""


def run(js: str):
    code = PRELUDE % json.dumps(str(SRC)) + "\n(async () => {\n" + js + "\n})().catch((e) => { console.error(e); process.exit(1); });"
    out = subprocess.run([NODE, "-e", code], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_grades_asked_for_follow_the_report():
    r = run("console.log(JSON.stringify({ g: W.wantedGrades(report), none: W.wantedGrades(null), p: W.buildPrompt(card, W.wantedGrades(report)) }));")
    assert r["g"] == ["Ungraded", "PSA 9", "BGS 9.5", "CGC Pristine 10", "TAG 9", "PSA 10"]
    assert r["none"] == ["Ungraded", "PSA 10", "PSA 9"]
    assert "Do not use pricecharting.com" in r["p"] and "Collector number: 4/102" in r["p"] and "Do not estimate or invent prices" in r["p"]


def test_search_request_and_checked_prices():
    r = run("""
      const res = await W.search(card, { apiKey: KEY, fetch: fakeFetch, report });
      const c = calls[0];
      const sent = JSON.parse(c.init.body);
      console.log(JSON.stringify({ url: c.url, keyInUrl: c.url.includes(KEY), tools: sent.tools, res }));""")
    assert r["url"] == "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
    assert r["keyInUrl"] is False and r["tools"] == [{"google_search": {}}]
    res = r["res"]
    assert res["grounded"] and res["parsed"] and res["card_found"].startswith("Charizard")
    got = [(p["grade"], p["price_usd"], p["source"], p["in_results"]) for p in res["prices"]]
    assert got == [("Ungraded", 360, "ebay.com", True), ("PSA 9", 1337.5, "ebay.com", True), ("BGS 9.5", 4200, "goldin.co", False)]
    why = sorted(d["why"] for d in res["dropped"])
    assert why == ["blocked source", "incomplete", "incomplete"]   # PriceCharting, a negative price, a grade not asked for
    assert res["queries"] and res["suggestionsHtml"].startswith("<style>") and len(res["sources"]) == 2


def test_ungrounded_or_unreadable_answers_show_no_prices():
    r = run("""
      const plain = { candidates: [{ content: { parts: [{ text: '{"prices":[{"grade":"Ungraded","price_usd":99,"source":"ebay.com"}]}' }] } }] };
      const junk = { candidates: [{ content: { parts: [{ text: "I could not find it." }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://x.example/a", title: "ebay.com" } }] } }] };
      const f = (b) => async () => ({ ok: true, status: 200, json: async () => b });
      const a = await W.search(card, { apiKey: KEY, fetch: f(plain) });
      const b = await W.search(card, { apiKey: KEY, fetch: f(junk) });
      console.log(JSON.stringify({ a: [a.grounded, a.prices[0].in_results], b: [b.grounded, b.parsed, b.prices.length] }));""")
    assert r["a"] == [False, False]      # the app shows nothing when the answer isn't grounded in a search
    assert r["b"] == [True, False, 0]


def test_errors_are_explained_and_nothing_is_sent_without_a_key():
    r = run("""
      const msgs = [];
      for (const [key, f] of [["", fakeFetch], ["AIzaWRONG", fakeFetch],
          [KEY, async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "You exceeded your current quota, please check your plan and billing details." } }) })],
          [KEY, async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "Grounding with Google Search requires billing (paid tier)" } }) })],
          [KEY, async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "This model models/gemini-2.5-flash is no longer available to new users." } }) })],
          [KEY, async () => { throw new TypeError("Failed to fetch"); }]]) {
        try { await W.search(card, { apiKey: key, fetch: f }); msgs.push("ok"); } catch (e) { msgs.push(e.message); }
      }
      console.log(JSON.stringify({ msgs, calls: calls.length }));""")
    m = r["msgs"]
    assert "Add your Gemini API key" in m[0] and r["calls"] == 1
    assert "didn't accept the Gemini API key" in m[1]
    assert "free tier" in m[2] and "needs billing" in m[3] and "no longer offers this model" in m[4] and "couldn't be reached" in m[5]


def test_helpers():
    r = run("""console.log(JSON.stringify({
      j: [W.extractJSON('x {"a": "}{", "b": [1]} y'), W.extractJSON("none"), W.extractJSON("```json\\n{\\"a\\":1}\\n```")],
      d: ["https://www.ebay.com/itm/1", "eBay.com", "shop.tcgplayer.com"].map(W.domainOf),
      doc: W.suggestionsDoc("<a href=https://www.google.com/search?q=x>x</a>").includes('<base target="_blank">'),
      k: [W.validKey("AIzaSyTESTKEY0000000000000000000000000"), W.validKey("short"), W.validKey("bad key with spaces 000000000000000"), W.validKey("AQ.Ab8TESTkeyTESTkeyTESTkeyTESTkeyTESTkey01")],
    }));""")
    assert r["j"] == [{"a": "}{", "b": [1]}, None, {"a": 1}]
    assert r["d"] == ["ebay.com", "ebay.com", "shop.tcgplayer.com"]
    assert r["doc"] is True and r["k"] == [True, False, False, True]


def test_busy_model_is_retried_once():
    r = run("""
      let n = 0;
      const f = async () => (++n === 1 ? { ok: false, status: 503, json: async () => ({ error: { message: "high demand" } }) } : { ok: true, status: 200, json: async () => body });
      const res = await W.search(card, { apiKey: KEY, fetch: f, retryDelayMs: 1 });
      let msg = "";
      try { await W.search(card, { apiKey: KEY, retryDelayMs: 1, fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: { message: "high demand" } }) }) }); } catch (e) { msg = e.message; }
      console.log(JSON.stringify({ n, ok: res.prices.length > 0, msg }));""")
    assert r["n"] == 2 and r["ok"] and "busy" in r["msg"]
