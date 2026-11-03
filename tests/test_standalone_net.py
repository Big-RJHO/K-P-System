"""Request deadlines (standalone/src/net.js) and how the five API integrations use them.

All offline through `node -e` with fake `fetch` functions: a server that never sends headers, one that sends
headers and never finishes the body, and one that answers. Timers are tracked to check none is left behind.
Also: PriceCharting's request spacing when several lookups start at once (standalone/src/prices.js).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

PRELUDE = """
const SRC = %s;
const Net = require(SRC + "/net.js");
const P = require(SRC + "/prices.js"), C = require(SRC + "/cardsight.js"), R = require(SRC + "/rbprices.js");
const G = require(SRC + "/geminiid.js"), W = require(SRC + "/webprices.js");
// Every timer still pending (set and neither fired nor cleared).
const live = new Set();
const _set = setTimeout, _clear = clearTimeout;
globalThis.setTimeout = (f, ms, ...a) => { const h = _set(() => { live.delete(h); f(...a); }, ms); live.add(h); return h; };
globalThis.clearTimeout = (h) => { live.delete(h); _clear(h); };
const signals = [];
const stallHeaders = (url, init) => { signals.push(init && init.signal); return new Promise(() => {}); };
const stallBody = async (url, init) => { signals.push(init && init.signal); return { ok: true, status: 200, json: () => new Promise(() => {}) }; };
const ok = (body) => async (url, init) => { signals.push(init && init.signal); return { ok: true, status: 200, json: async () => body }; };
const gemini = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const KEY = "AIzaSyTESTKEY0000000000000000000000000";
const card = { game: "pokemon", name: "Charizard", number: "4/102", set_name: "Base Set" };
// name -> [call(fetch, timeoutMs), a good answer]
const INTEGRATIONS = {
  pricecharting: [(f, t) => { P._reset(); return P.search(card, { token: "0".repeat(40), fetch: f, storage: null, timeoutMs: t }); },
    { status: "success", products: [{ id: "1", "product-name": "Charizard #4", "console-name": "Pokemon Base Set" }] }],
  cardsight: [(f, t) => C.findCard(card, { apiKey: "csa_live_TEST0000000000000000", fetch: f, storage: null, timeoutMs: t }), { results: [] }],
  riftbound: [(f, t) => { R._reset(); return R.load({ fetch: f, timeoutMs: t }); }, { cards: {} }],
  gemini_id: [(f, t) => G.identify("AAAA", { apiKey: KEY, fetch: f, timeoutMs: t }),
    gemini(JSON.stringify({ game: "pokemon", name: "Charizard", printed_name: "Charizard", number: "4/102", confidence: 0.9 }))],
  web_prices: [(f, t) => W.search(card, { apiKey: KEY, fetch: f, timeoutMs: t }),
    gemini(JSON.stringify({ card_found: "Charizard", prices: [], notes: "" }))],
};
async function outcome(p) {
  const t0 = Date.now();
  try { await p; return { ok: true, ms: Date.now() - t0 }; } catch (e) { return { ok: false, msg: e.message, name: e.name, ms: Date.now() - t0 }; }
}
"""


def run(body: str, timeout: int = 120):
    code = PRELUDE % json.dumps(str(SRC)) + "\n(async () => {\n" + body + "\n})().catch((e) => { console.error(e); process.exit(1); });"
    out = subprocess.run([NODE, "-e", code], capture_output=True, text=True, timeout=timeout)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_fetch_json_deadline_covers_headers_and_body_and_aborts():
    r = run("""
      const res = {};
      res.headers = await outcome(Net.fetchJSON("https://x.test/a", { fetch: stallHeaders, timeoutMs: 80 }));
      res.headersAborted = signals[0].aborted;
      res.body = await outcome(Net.fetchJSON("https://x.test/b", { fetch: stallBody, timeoutMs: 80 }));
      res.bodyAborted = signals[1].aborted;
      res.liveAfterTimeouts = live.size;
      const good = await Net.fetchJSON("https://x.test/c", { fetch: ok({ a: 1 }), timeoutMs: 600000 });
      const notJson = await Net.fetchJSON("https://x.test/d", { timeoutMs: 600000, fetch: async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("bad"); } }) });
      const offline = await outcome(Net.fetchJSON("https://x.test/e", { timeoutMs: 600000, fetch: async () => { throw new TypeError("Failed to fetch"); } }));
      let isT = false;
      try { await Net.fetchJSON("https://x.test/f", { fetch: stallHeaders, timeoutMs: 10 }); } catch (e) { isT = Net.isTimeout(e); }
      res.good = good.body; res.goodOk = good.ok; res.notJson = [notJson.body, notJson.status, notJson.ok];
      res.offline = offline; res.isTimeout = isT; res.live = live.size; res.default = Net.DEFAULT_TIMEOUT_MS;
      console.log(JSON.stringify(res));""")
    for k in ("headers", "body"):
        assert r[k]["ok"] is False and r[k]["name"] == "TimeoutError", r[k]
        assert 70 <= r[k]["ms"] < 5000
    assert r["headersAborted"] and r["bodyAborted"]
    assert r["good"] == {"a": 1} and r["goodOk"] is True
    assert r["notJson"] == [None, 502, False]
    assert r["offline"]["ok"] is False and r["offline"]["name"] == "TypeError"   # network errors pass through
    assert r["isTimeout"] is True
    assert r["liveAfterTimeouts"] == 0 and r["live"] == 0   # every deadline timer cleared
    assert r["default"] == 15000


def test_every_integration_times_out_on_stalled_headers_and_bodies():
    r = run("""
      const out = {};
      for (const [name, [call]] of Object.entries(INTEGRATIONS)) {
        const before = signals.length;
        const headers = await outcome(call(stallHeaders, 100));
        const body = await outcome(call(stallBody, 100));
        out[name] = { headers, body, aborted: signals.slice(before).map((s) => !!(s && s.aborted)), live: live.size };
      }
      console.log(JSON.stringify(out));""")
    assert set(r) == {"pricecharting", "cardsight", "riftbound", "gemini_id", "web_prices"}
    for name, res in r.items():
        for kind in ("headers", "body"):
            o = res[kind]
            assert o["ok"] is False, (name, kind)
            assert "within" in o["msg"] and "seconds" in o["msg"], (name, kind, o["msg"])
            assert 90 <= o["ms"] < 5000, (name, kind, o["ms"])
        assert res["aborted"] == [True, True], name   # the request itself was aborted, not just abandoned
        assert res["live"] == 0, name


def test_every_integration_clears_its_timers_on_success_and_uses_its_deadline():
    r = run("""
      const out = {};
      for (const [name, [call, good]] of Object.entries(INTEGRATIONS)) {
        const seen = [];
        const f = async (url, init) => { seen.push(!!(init && init.signal)); return { ok: true, status: 200, json: async () => good }; };
        const o = await outcome(call(f, 600000));
        out[name] = { ok: o.ok, msg: o.msg, signal: seen, live: live.size };
      }
      out.defaults = [P.TIMEOUT_MS, C.TIMEOUT_MS, R.TIMEOUT_MS, G.TIMEOUT_MS, W.TIMEOUT_MS];
      console.log(JSON.stringify(out));""")
    assert r.pop("defaults") == [15000, 15000, 15000, 45000, 45000]   # price services 15 s, Gemini 45 s per attempt
    for name, res in r.items():
        assert res["ok"], (name, res)
        assert res["signal"] == [True], name
        assert res["live"] == 0, name   # a 10-minute deadline would keep Node alive: it must be cleared


def test_gemini_timeout_is_a_thrown_error_and_busy_retry_stays_single():
    r = run("""
      let n = 0;
      const busyThenStall = (url, init) => (++n === 1 ? Promise.resolve({ ok: false, status: 503, json: async () => ({}) }) : stallHeaders(url, init));
      const id = await outcome(G.identify("AAAA", { apiKey: KEY, fetch: busyThenStall, timeoutMs: 100, retryDelayMs: 1 }));
      let m = 0;
      const alwaysBusy = async () => { m++; return { ok: false, status: 503, json: async () => ({ error: { message: "high demand" } }) }; };
      const busy = await outcome(W.search(card, { apiKey: KEY, fetch: alwaysBusy, timeoutMs: 100, retryDelayMs: 1 }));
      console.log(JSON.stringify({ id, n, busy, m, live: live.size }));""")
    # The app catches any error from GeminiID.identify and falls back to the on-device reader.
    assert r["id"]["ok"] is False and "Gemini didn't answer within" in r["id"]["msg"]
    assert r["n"] == 2 and r["m"] == 2 and "busy" in r["busy"]["msg"]
    assert r["live"] == 0


def test_modules_work_without_net_js_and_as_browser_globals(tmp_path):
    # Loaded alone (no net.js beside it): requests still work, without a deadline.
    alone = tmp_path / "prices.js"
    shutil.copy(SRC / "prices.js", alone)
    r = run("""
      const Alone = require(%s);
      const res = await Alone.search(card, { token: "0".repeat(40), storage: null, fetch: async () => ({ ok: true, status: 200,
        json: async () => ({ status: "success", products: [{ id: "1", "product-name": "Charizard #4", "console-name": "Pokemon Base Set" }] }) }) });
      // As browser globals: plain scripts sharing one global object, no module/require.
      const vm = require("vm");
      const ctx = vm.createContext({ setTimeout, clearTimeout, AbortController, URL, console });
      for (const f of ["net.js", "prices.js", "geminiid.js"]) vm.runInContext(require("fs").readFileSync(SRC + "/" + f, "utf8"), ctx);
      const g = await outcome(ctx.GeminiID.identify("AAAA", { apiKey: KEY, fetch: stallHeaders, timeoutMs: 100 }));
      console.log(JSON.stringify({ best: res.best && res.best.id, globals: [typeof ctx.Net, typeof ctx.Prices, typeof ctx.GeminiID], g }));""" % json.dumps(str(alone)))
    assert r["best"] == "1"
    assert r["globals"] == ["object", "object", "object"]
    assert r["g"]["ok"] is False and "within" in r["g"]["msg"]


def test_simultaneous_price_lookups_are_spaced_even_after_a_failure():
    """Fake clock: callers that arrive together get successive 1.1 s slots, and a failed call keeps its slot."""
    r = run("""
      P._reset();
      let t = 1000000;
      const sleepers = [];
      const clock = { now: () => t, sleep: (ms) => new Promise((resolve) => sleepers.push({ at: t + ms, resolve })) };
      const starts = [];
      let k = 0;
      const f = async (url) => {
        starts.push(t);
        if (++k === 2) throw new TypeError("Failed to fetch");   // the second request fails
        return { ok: true, status: 200, json: async () => ({ status: "success", products: [] }) };
      };
      const opts = { token: "0".repeat(40), fetch: f, storage: null, clock, timeoutMs: 600000 };
      const all = Promise.all([0, 1, 2, 3].map(() => outcome(P.search(card, opts))));
      // Drive the fake clock: wake the earliest sleeper, let the microtasks run, repeat.
      let done = false;
      all.then(() => { done = true; });
      while (!done) {
        await new Promise((r) => setImmediate(r));
        if (!sleepers.length) continue;
        sleepers.sort((a, b) => a.at - b.at);
        const s = sleepers.shift();
        t = Math.max(t, s.at);
        s.resolve();
      }
      const results = await all;
      // A call made after the burst still waits its turn.
      const later = outcome(P.search(card, opts));
      while (starts.length < 5) { await new Promise((r) => setImmediate(r)); const s = sleepers.shift(); if (s) { t = Math.max(t, s.at); s.resolve(); } }
      await later;
      console.log(JSON.stringify({ starts: starts.map((x) => x - 1000000), ok: results.map((x) => x.ok), live: live.size }));""")
    starts = r["starts"]
    assert len(starts) == 5
    assert r["ok"] == [True, False, True, True]
    gaps = [b - a for a, b in zip(starts, starts[1:])]
    assert all(g >= 1100 for g in gaps), starts
    assert starts[0] == 0 and starts[3] == 3300


def test_simultaneous_price_lookups_are_spaced_with_real_timers():
    r = run("""
      P._reset();
      const starts = [];
      let k = 0;
      const f = async () => { starts.push(Date.now()); if (++k === 1) throw new TypeError("Failed to fetch");
        return { ok: true, status: 200, json: async () => ({ status: "success", products: [] }) }; };
      const opts = { token: "0".repeat(40), fetch: f, storage: null };
      const res = await Promise.all([0, 1, 2].map(() => outcome(P.search(card, opts))));
      console.log(JSON.stringify({ gaps: starts.slice(1).map((x, i) => x - starts[i]), ok: res.map((x) => x.ok), live: live.size }));""")
    assert r["ok"] == [False, True, True]
    assert all(g >= 1100 for g in r["gaps"]), r["gaps"]
    assert r["live"] == 0
