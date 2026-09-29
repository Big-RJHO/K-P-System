"""Card identification (standalone/src/identify.js) against recorded API responses.

Everything runs offline: the JS is driven through `node -e` with a fake `fetch` that serves the JSON
saved under tests/fixtures/ (real responses from TCGdex and Riftcodex, fetched 2026-09-29).
The one live-network test is skipped when the services cannot be reached.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures"
SRC = ROOT / "standalone" / "src" / "identify.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

PRELUDE = """
const I = require(%s);
const fs = require("fs");
const FIX = %s;
const fx = (n) => JSON.parse(fs.readFileSync(FIX + "/" + n + ".json", "utf8"));
const calls = [];
// Fake fetch: serves recorded responses; anything not recorded is a 404 (like the real services).
const T = "https://api.tcgdex.net/v2/en/", R = "https://api.riftcodex.com/";
const routes = new Map([
  [T + "sets/sv03", [200, fx("tcgdex_set_sv03")]],
  [T + "sets/sv03/125", [200, fx("tcgdex_card_sv03-125")]],
  [T + "sets?abbreviation.official=OBF", [200, fx("tcgdex_sets_abbrev_OBF")]],
  [T + "cards/sv03-125", [200, fx("tcgdex_card_sv03-125")]],
  [T + "cards?localId=125", [200, fx("tcgdex_cards_localId_125")]],
  [T + "cards?name=charizard&localId=125", [200, fx("tcgdex_cards_name_charizard_localId_125")]],
  [T + "sets?abbreviation.official=ZZZ9", [200, []]],
  [T + "sets", [200, fx("tcgdex_sets_all")]],
  [R + "cards/riftbound/ven-sp3-006", [200, fx("riftcodex_card_ven-sp3-006")]],
  [R + "sets/set-id/VEN", [200, fx("riftcodex_set_ven")]],
  [R + "cards/name?fuzzy=ahri&size=50", [200, fx("riftcodex_name_fuzzy_ahri")]],
  [R + "cards/riftbound/zzz-001-002", [200, fx("riftcodex_card_unknown")]],
  [R + "cards/riftbound/ogn-066", [200, []]],
  [R + "cards?set_id=OGN&size=100&page=1", [200, fx("riftcodex_cards_ogn_subset")]],
  [R + "sets/set-id/OGN", [200, {id: "x", name: "Origins", set_id: "OGN", card_count: 352, published_on: "2025-10-31T00:00:00"}]],
  [R + "cards?set_id=ZZZ&size=100&page=1", [200, {items: [], total: 0, page: 1, size: 100, pages: 0}]],
]);
const notFound = fx("tcgdex_card_notfound");
async function fakeFetch(url) {
  calls.push(url);
  const hit = routes.get(url);
  const [status, body] = hit || (url.startsWith(T) ? [404, notFound] : [500, null]);
  return { ok: status >= 200 && status < 300, status, json: async () => { if (body === null) throw new Error("not json"); return body; } };
}
const opts = { fetch: fakeFetch };
"""


def run_js(body: str) -> dict:
    script = PRELUDE % (json.dumps(str(SRC)), json.dumps(str(FIX))) + "\n(async () => {\n" + body + "\n})().catch((e) => { console.error(e); process.exit(1); });"
    res = subprocess.run([NODE, "-e", script], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def out(expr: str) -> str:
    return f"process.stdout.write(JSON.stringify({expr}));"


# ------------------------------------------------------------------ Pokemon (TCGdex)

def test_pokemon_printed_abbreviation_and_number_is_one_high_confidence_match():
    r = run_js("const r = await I.candidates({game:'pokemon', set_code:'OBF', number:'125/197', language:'EN'}, opts);" + out("r"))
    assert len(r["candidates"]) == 1 and not r["needs_confirmation"] and "error" not in r
    c = r["candidates"][0]
    assert (c["name"], c["set_name"], c["set_code"], c["number"], c["rarity"], c["year"], c["language"]) == (
        "Charizard ex", "Obsidian Flames", "OBF", "125", "Double rare", 2023, "EN")
    assert c["confidence"] >= 0.9 and c["source"] == "tcgdex"
    assert c["image_url"] == "https://assets.tcgdex.net/en/sv/sv03/125/high.png" and c["image_readable"] is True
    assert any("/197" in e for e in c["evidence"])


def test_pokemon_tcgdex_set_id_style_code_also_resolves():
    r = run_js("const r = await I.candidates({game:'pokemon', set_code:'SV3', number:'125/197'}, opts);" + out("r"))
    assert [c["name"] for c in r["candidates"]] == ["Charizard ex"]
    assert not r["needs_confirmation"]


def test_pokemon_name_and_total_shift_confidence():
    r = run_js(
        "const good = await I.candidates({game:'pokemon', set_code:'OBF', number:'125/197', name:'charizard'}, opts);"
        "const wrongName = await I.candidates({game:'pokemon', set_code:'OBF', number:'125/197', name:'Pikachu'}, opts);"
        "const wrongTotal = await I.candidates({game:'pokemon', set_code:'OBF', number:'125/198'}, opts);"
        + out("{good, wrongName, wrongTotal}"))
    g, wn, wt = (r[k]["candidates"][0] for k in ("good", "wrongName", "wrongTotal"))
    assert g["confidence"] > 0.95
    assert wn["confidence"] < 0.6 and any("name differs" in e for e in wn["evidence"])
    assert r["wrongName"]["needs_confirmation"]
    assert wt["confidence"] < g["confidence"] and any("total differs" in e for e in wt["evidence"])


def test_pokemon_number_only_lists_several_and_needs_confirmation():
    r = run_js("const r = await I.candidates({game:'pokemon', number:'125/197'}, opts);" + out("r"))
    assert len(r["candidates"]) > 3 and r["needs_confirmation"]
    assert all(c["confidence"] < 0.6 for c in r["candidates"])
    assert r["total_matches"] >= len(r["candidates"])
    assert all(int(c["number"]) == 125 for c in r["candidates"])
    # the printed total /197 singles out Obsidian Flames among the 69 sets that have a card 125
    top = r["candidates"][0]
    assert top["source_id"] == "sv03-125" and top["set_name"] == "Obsidian Flames" and any("/197" in e for e in top["evidence"])
    assert top["confidence"] > r["candidates"][1]["confidence"] + 0.1


def test_pokemon_name_plus_number_without_set_narrows_but_still_asks():
    r = run_js("const r = await I.candidates({game:'pokemon', number:'125', name:'charizard'}, opts);" + out("r"))
    names = {c["source_id"]: c["name"] for c in r["candidates"]}
    assert names == {"me02-125": "Mega Charizard X ex", "sv03-125": "Charizard ex"}
    assert r["needs_confirmation"]


def test_pokemon_unknown_card_is_empty_with_error():
    r = run_js("const r = await I.candidates({game:'pokemon', set_code:'ZZZ9', number:'9999'}, opts);" + out("r"))
    assert r["candidates"] == [] and r["error"] and not r["needs_confirmation"]


def test_pokemon_nothing_to_search_on():
    r = run_js("const r = await I.candidates({game:'pokemon'}, opts);" + out("r"))
    assert r["candidates"] == [] and "set code and number" in r["error"]


def test_offline_or_failing_fetch_gives_a_clear_error_not_a_throw():
    r = run_js(
        "const boom = async () => { throw new Error('getaddrinfo ENOTFOUND'); };"
        "const a = await I.candidates({game:'pokemon', set_code:'OBF', number:'125'}, {fetch: boom});"
        "const b = await I.candidates({game:'riftbound', set_code:'VEN', number:'SP3/006'}, {fetch: boom});"
        + out("{a, b}"))
    for k in ("a", "b"):
        assert r[k]["candidates"] == [] and "Could not reach" in r[k]["error"]


# ------------------------------------------------------------------ Riftbound (Riftcodex)

def test_riftbound_real_photo_line_ven_sp3_006_is_exact():
    r = run_js("const r = await I.candidates({game:'riftbound', set_code:'VEN', number:'SP3/006', language:'EN'}, opts);" + out("{r, calls}"))
    cands = r["r"]["candidates"]
    assert len(cands) == 1 and not r["r"]["needs_confirmation"]
    c = cands[0]
    assert (c["name"], c["set_name"], c["set_code"], c["number"], c["rarity"], c["variant"], c["year"]) == (
        "Ahri, Inquisitive", "Vendetta", "VEN", "SP3/006", "Epic", "Standard", 2026)
    assert c["confidence"] >= 0.9 and c["source"] == "riftcodex"
    assert c["image_url"].startswith("https://cmsassets.rgpub.io/") and c["image_readable"] is False
    assert "https://api.riftcodex.com/cards/riftbound/ven-sp3-006" in r["calls"]


def test_riftbound_number_in_set_lists_variants_to_confirm():
    r = run_js("const r = await I.candidates({game:'riftbound', set_code:'OGN', number:'066'}, opts);" + out("r"))
    variants = {c["source_id"]: c["variant"] for c in r["candidates"]}
    assert variants == {"ogn-066-298": "Standard", "ogn-066a-298": "Alternate Art"}
    assert r["needs_confirmation"]


def test_riftbound_name_only_needs_confirmation_and_number_narrows():
    r = run_js(
        "const a = await I.candidates({game:'riftbound', name:'ahri'}, opts);"
        "const b = await I.candidates({game:'riftbound', name:'ahri', number:'SP3/006'}, opts);"
        + out("{a, b}"))
    assert len(r["a"]["candidates"]) >= 5 and r["a"]["needs_confirmation"]
    assert all(c["confidence"] <= 0.5 for c in r["a"]["candidates"])
    assert [c["source_id"] for c in r["b"]["candidates"]] == ["ven-sp3-006"]
    assert r["b"]["needs_confirmation"]   # name + number without a set is still only a probable match


def test_riftbound_unknown_or_unusable_input_returns_error_and_empty_list():
    r = run_js(
        "const unknown = await I.candidates({game:'riftbound', set_code:'ZZZ', number:'001/002'}, opts);"
        "const noInfo = await I.candidates({game:'riftbound', number:'12'}, opts);"
        + out("{unknown, noInfo}"))
    for k in ("unknown", "noInfo"):
        assert r[k]["candidates"] == [] and r[k]["error"] and not r[k]["needs_confirmation"]
    assert "manual reference" in r["noInfo"]["error"]


def test_riftbound_non_english_is_flagged_in_evidence():
    r = run_js("const r = await I.candidates({game:'riftbound', set_code:'VEN', number:'SP3/006', language:'FR'}, opts);" + out("r"))
    assert any("English" in e for e in r["candidates"][0]["evidence"])


def test_game_is_inferred_from_riftbound_set_codes():
    r = run_js("const r = await I.candidates({set_code:'VEN', number:'SP3/006'}, opts);" + out("r"))
    assert r["candidates"][0]["source"] == "riftcodex"


# ------------------------------------------------------------------ manual reference

def test_manual_reference_url_and_file_validation():
    r = run_js(
        "const ok = I.manualReference({url:'https://example.com/a/card.png?x=1'});"
        "const page = I.manualReference({url:'https://example.com/card/123'});"
        "const http = I.manualReference({url:'http://example.com/a.png'});"
        "const js = I.manualReference({url:'javascript:alert(1)'});"
        "const junk = I.manualReference({url:'not a url'});"
        "const cred = I.manualReference({url:'https://u:p@example.com/a.png'});"
        "const data = I.manualReference({url:'data:image/png;base64,AAAA'});"
        "const file = I.manualReference({file: new Blob([new Uint8Array(10)], {type:'image/webp'})});"
        "const pdf = I.manualReference({file: new Blob([new Uint8Array(10)], {type:'application/pdf'})});"
        "const empty = I.manualReference({file: new Blob([], {type:'image/png'})});"
        "const none = I.manualReference({});"
        + out("{ok, page, http, js, junk, cred, data, file: {...file, image: !!file.image}, pdf, empty, none}"))
    assert r["ok"] == {"ok": True, "image_url": "https://example.com/a/card.png?x=1", "source": "user", "warnings": r["ok"]["warnings"]}
    assert any("block" in w for w in r["ok"]["warnings"])
    assert r["page"]["ok"] and any("straight at the image" in w for w in r["page"]["warnings"])
    for k in ("http", "js", "junk", "cred", "pdf", "empty", "none"):
        assert r[k]["ok"] is False and r[k]["error"], k
    assert r["data"]["ok"] and r["file"]["ok"] and r["file"]["image"] and r["file"]["source"] == "user"


# ------------------------------------------------------------------ reference check

IMG = """
// deterministic textured "card art": enough detail to pass the not-a-card test
function tex(w, h, bg, box) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = !box || (x >= box[0] && x < box[0] + box[2] && y >= box[1] && y < box[1] + box[3]);
    if (inside) { d[i] = (x * 5 + y * 3) & 255; d[i + 1] = (x * 2 + y * 7 + 60) & 255; d[i + 2] = (x ^ y) & 255; }
    else { d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; }
    d[i + 3] = 255;
  }
  return { width: w, height: h, data: d };
}
"""


def test_check_reference_flags_small_odd_and_blank_images():
    r = run_js(IMG + """
    const solid = tex(700, 980, [200, 200, 200], [0, 0, 0, 0]);   // card-shaped but a single colour
    const emptyCanvas = tex(900, 900, [200, 200, 200], [0, 0, 0, 0]);   // nothing but plain background
    const res = {
      good: I.checkReference(tex(660, 922, [0, 0, 0])),
      tiny: I.checkReference(tex(200, 280, [0, 0, 0])),
      wide: I.checkReference(tex(1200, 400, [0, 0, 0])),
      tall: I.checkReference(tex(300, 1200, [0, 0, 0])),
      square: I.checkReference(tex(900, 900, [0, 0, 0])),
      landscape: I.checkReference(tex(922, 660, [0, 0, 0])),
      flat: I.checkReference(solid),
      blank: I.checkReference(emptyCanvas),
      onWhite: I.checkReference(tex(1000, 1000, [255, 255, 255], [170, 39, 660, 922])),
      smallOnWhite: I.checkReference(tex(1000, 1000, [255, 255, 255], [300, 300, 300, 419])),
      broken: I.checkReference({ width: 10, height: 10, data: new Uint8ClampedArray(4) }),
    };
    """ + out("res"))
    assert r["good"]["usable"] and r["good"]["reasons"] == []
    assert not r["tiny"]["usable"] and "Too small" in r["tiny"]["reasons"][0]
    assert not r["wide"]["usable"] and "Extreme shape" in r["wide"]["reasons"][0]
    assert not r["tall"]["usable"] and "Extreme shape" in r["tall"]["reasons"][0]
    assert not r["square"]["usable"] and "Not card-shaped" in r["square"]["reasons"][0]
    assert not r["landscape"]["usable"] and "Landscape" in r["landscape"]["reasons"][0]
    assert not r["flat"]["usable"] and "Almost no detail" in r["flat"]["reasons"][0]
    assert not r["blank"]["usable"] and "blank" in r["blank"]["reasons"][0]
    assert not r["broken"]["usable"]
    # a good card photographed on plain white is judged on the card, not on the square canvas
    assert r["onWhite"]["usable"] and r["onWhite"]["box"] == {"x": 170, "y": 39, "w": 660, "h": 922}
    assert not r["smallOnWhite"]["usable"] and "Too small" in r["smallOnWhite"]["reasons"][0]


# ------------------------------------------------------------------ printed mask

MASK = IMG + """
const M = 48, W = 750 + 2 * M, H = 1048 + 2 * M;
const warped = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) };
// dark blue reference face with a white patch in the top-left corner and a white block in the centre
function reference(w, h, pad) {
  const bg = [30, 40, 120];
  const img = { width: w + 2 * pad, height: h + 2 * pad, data: new Uint8ClampedArray((w + 2 * pad) * (h + 2 * pad) * 4) };
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    const cx = x - pad, cy = y - pad;
    const inCard = cx >= 0 && cy >= 0 && cx < w && cy < h;
    let c = inCard ? [(30 + (cx * 3 + cy) % 40), 40, 120] : [255, 255, 255];
    if (inCard && cx < w * 0.1 && cy < h * 0.08) c = [255, 255, 255];                                   // printed white corner
    if (inCard && Math.abs(cx - w / 2) < w * 0.08 && Math.abs(cy - h / 2) < h * 0.06) c = [252, 252, 250]; // white in the middle of the card
    if (inCard && cx > w * 0.9 && cy > h * 0.5 && cy < h * 0.6) c = [255, 215, 0];                        // yellow edge ink: not white
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
  }
  return img;
}
const at = (m, x, y) => m[y * W + x];
"""


def test_printed_mask_marks_white_near_edges_only():
    r = run_js(MASK + """
    const mask = I.printedMask(reference(600, 840, 0), warped, M);
    const res = {
      len: mask.length, type: mask.constructor.name,
      corner: at(mask, M + 20, M + 20),                       // inside the printed white corner patch
      cornerEdge: at(mask, M + 74, M + 20),                   // right at the patch edge (75 px wide)
      dilated: at(mask, M + 77, M + 20),                      // 2 px beyond: dilation covers it
      farOutside: at(mask, M + 100, M + 20),                  // well beyond the dilation
      centreWhite: at(mask, M + 375, M + 524),                // white block in the middle: not near an edge
      yellow: at(mask, W - M - 20, M + 524 + 100),            // right edge, coloured ink
      margin: at(mask, 10, 10),                               // photo margin outside the card box
      total: mask.reduce((a, b) => a + b, 0),
    };
    """ + out("res"))
    assert r["len"] == (750 + 96) * (1048 + 96) and r["type"] == "Uint8Array"
    assert r["corner"] == 1 and r["cornerEdge"] == 1 and r["dilated"] == 1
    assert r["farOutside"] == 0 and r["centreWhite"] == 0 and r["yellow"] == 0 and r["margin"] == 0
    assert 0 < r["total"] < 0.02 * 846 * 1144


def test_printed_mask_ignores_plain_background_around_the_reference_and_scales():
    r = run_js(MASK + """
    const plain = I.printedMask(reference(600, 840, 0), warped, M);
    const padded = I.printedMask(reference(600, 840, 80), warped, M);   // same card on a white canvas
    const big = I.printedMask(reference(1500, 2100, 0), warped, M);      // 2.5x larger reference
    const small = I.printedMask(reference(300, 420, 0), warped, M);      // upscaled reference
    const diff = (a, b) => { let d = 0, n = 0; for (let i = 0; i < a.length; i++) { d += a[i] !== b[i]; n += a[i] | b[i]; } return d / n; };
    const noDilate = I.printedMask(reference(600, 840, 0), warped, M, { dilate: 0 });
    const res = { padded: diff(plain, padded), big: diff(plain, big), small: diff(plain, small), grows: plain.reduce((a, b) => a + b, 0) > noDilate.reduce((a, b) => a + b, 0),
                  cover: I.maskCoverage(plain, W, H, M) };
    """ + out("res"))
    assert r["padded"] < 0.1 and r["big"] < 0.1 and r["small"] < 0.1
    assert r["grows"]
    assert 0 < r["cover"] < 0.1


def test_printed_mask_white_border_card_reports_high_coverage():
    r = run_js(MASK + """
    const w = 600, h = 840, img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, border = Math.min(x, y, w - 1 - x, h - 1 - y) < 60;
      img.data.set(border ? [250, 250, 250, 255] : [20, 60, 140, 255], i);
    }
    const mask = I.printedMask(img, warped, M);
    const res = { cover: I.maskCoverage(mask, W, H, M) };
    """ + out("res"))
    assert r["cover"] > 0.4   # the detector should call whitening "not assessable" here


def test_printed_mask_rejects_bad_input():
    r = run_js(MASK + """
    const errs = [];
    for (const f of [() => I.printedMask(null, warped, M), () => I.printedMask(reference(600, 840, 0), null, M), () => I.printedMask(reference(600, 840, 0), { width: 50, height: 50, data: new Uint8ClampedArray(10000) }, M)]) {
      try { f(); errs.push(null); } catch (e) { errs.push(String(e.message)); }
    }
    """ + out("errs"))
    assert all(e and "printedMask" in e for e in r)


# ------------------------------------------------------------------ live (skipped offline)

def _live_reachable() -> bool:
    env = dict(os.environ, NODE_USE_ENV_PROXY="1")
    probe = "fetch('https://api.tcgdex.net/v2/en/sets/sv03',{signal:AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
    try:
        return subprocess.run([NODE, "-e", probe], env=env, capture_output=True, timeout=15).returncode == 0
    except Exception:
        return False


@pytest.mark.skipif(not os.environ.get("KP_LIVE") or NODE is None, reason="live network test: set KP_LIVE=1 to run")
def test_live_services_agree_with_recorded_fixtures():
    if not _live_reachable():
        pytest.skip("TCGdex is not reachable from here")
    env = dict(os.environ, NODE_USE_ENV_PROXY="1")
    script = f"""
    const I = require({json.dumps(str(SRC))});
    (async () => {{
      const a = await I.candidates({{game:'pokemon', set_code:'OBF', number:'125/197'}});
      const b = await I.candidates({{game:'riftbound', set_code:'VEN', number:'SP3/006'}});
      process.stdout.write(JSON.stringify({{a, b}}));
    }})();
    """
    res = subprocess.run([NODE, "-e", script], env=env, capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    r = json.loads(res.stdout)
    assert r["a"]["candidates"][0]["name"] == "Charizard ex"
    assert r["b"]["candidates"][0]["name"] == "Ahri, Inquisitive"
