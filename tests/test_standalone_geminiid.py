"""Reading the card from the photo with Gemini (standalone/src/geminiid.js).

Offline, through `node -e` with a fake `fetch`. The answer shape is Gemini's generateContent response with a
JSON body, as returned in a live check on 2026-09-29 (31/31 collector numbers right on the blind-test photos;
see docs/pricing.md). No key is used here.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src" / "geminiid.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

PRELUDE = """
const G = require(%s);
const KEY = "AQ.TESTkeyTESTkeyTESTkeyTESTkeyTESTkey01";
const calls = [];
const answer = (o) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] }) });
"""


def run(js: str):
    code = PRELUDE % json.dumps(str(SRC)) + "\n(async () => {\n" + js + "\n})().catch((e) => { console.error(e); process.exit(1); });"
    out = subprocess.run([NODE, "-e", code], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_request_and_reading():
    r = run("""
      const f = async (url, init) => { calls.push({ url, init }); return answer({ game: "riftbound", name: "Ahri", number: "sp3/006",
        set_code: "ven", set_name: "Vendetta", language: "English", variant: "Foil", graded_slab: false, confidence: 0.99 }); };
      const reading = await G.identify("AAAA", { apiKey: KEY, fetch: f });
      const body = JSON.parse(calls[0].init.body);
      console.log(JSON.stringify({ url: calls[0].url, key: calls[0].init.headers["x-goog-api-key"] === KEY, keyInUrl: calls[0].url.includes(KEY),
        mime: body.contents[0].parts[0].inline_data.mime_type, schema: body.generationConfig.responseMimeType, tools: body.tools || null, reading }));""")
    assert r["url"] == "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
    assert r["key"] and not r["keyInUrl"] and r["mime"] == "image/jpeg" and r["schema"] == "application/json"
    assert r["tools"] is None   # no Google Search: plain image requests work on a free key
    rd = r["reading"]
    assert (rd["source"], rd["game"], rd["number"], rd["set_code"], rd["language"], rd["found"]) == ("gemini", "riftbound", "SP3/006", "VEN", "EN", True)


def test_bad_fields_are_dropped():
    r = run("""console.log(JSON.stringify([
      G.toReading({ game: "pokemon", name: "Shining Tyranitar", number: "113 / 105", set_code: "Neo Destiny!", language: "xx", confidence: 7 }),
      G.toReading({ game: "other", name: "", number: "", confidence: 0.2 }),
    ]));""")
    a, b = r
    assert a["number"] == "113/105" and a["set_code"] == "" and a["language"] == "" and a["confidence"] == 1 and a["name_key"] == "Tyranitar"
    assert b["found"] is False and b["game"] == ""


def test_errors():
    r = run("""
      const msgs = [];
      const bad = (status, message) => async () => ({ ok: false, status, json: async () => ({ error: { message } }) });
      for (const [key, f] of [["", bad(200, "")], [KEY, bad(400, "API key not valid.")], [KEY, bad(429, "quota")],
                              [KEY, async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }) })],
                              [KEY, async () => { throw new TypeError("Failed to fetch"); }]]) {
        try { await G.identify("AAAA", { apiKey: key, fetch: f, retryDelayMs: 1 }); msgs.push("ok"); } catch (e) { msgs.push(e.message); }
      }
      let n = 0;
      const busyThenOk = async () => (++n === 1 ? { ok: false, status: 503, json: async () => ({}) } : answer({ game: "pokemon", name: "Lugia", number: "9/111", confidence: 0.9 }));
      const retried = await G.identify("AAAA", { apiKey: KEY, fetch: busyThenOk, retryDelayMs: 1 });
      console.log(JSON.stringify({ msgs, n, num: retried.number }));""")
    m = r["msgs"]
    assert m[0] == "no-key" and "didn't accept" in m[1] and "limit" in m[2] and "couldn't be read" in m[3] and "couldn't be reached" in m[4]
    assert r["n"] == 2 and r["num"] == "9/111"
