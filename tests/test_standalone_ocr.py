"""Reading the card's name and number from the photo (standalone/src/ocr.js).

The recogniser (tesseract.js) is injected, so these tests run offline with a fake one. They cover the
parsing of real recogniser output (strings below were returned by tesseract.js on real slab photos),
the crop geometry, the text-row finder, and how readings turn into card lookups. The accuracy on real
photos is measured separately (docs/pricing.md, "Reading the card from the photo").
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src" / "ocr.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

PRELUDE = """
const O = require(%s);
// A white card (750 x 1048 inside a 48 px margin) with optional black rectangles, in card coordinates.
function card(rects = []) {
  const M = 48, W = 750 + 2 * M, H = 1048 + 2 * M, d = new Uint8ClampedArray(W * H * 4).fill(255);
  for (const [x0, y0, x1, y1, v = 0] of rects)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = ((y + M) * W + x + M) * 4; d[i] = d[i + 1] = d[i + 2] = v; }
  return { width: W, height: H, data: d };
}
"""


def run(body: str):
    code = PRELUDE % json.dumps(str(SRC)) + "\n(async () => {\n" + body + "\n})().catch((e) => { console.error(e); process.exit(1); });"
    out = subprocess.run([NODE, "-e", code], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_collector_numbers_from_real_recogniser_output():
    cases = {
        "2/102 ★": ("pokemon", "2/102", "", ""),
        "C 062/054 sR": ("pokemon", "062/054", "", ""),
        "i Q) £\\ SV55/5V94 eis": ("pokemon", "SV55/SV94", "", ""),   # the right side's "SV" misread as "5V"
        "G OBF EN 125/197": ("pokemon", "125/197", "OBF", "EN"),
        "RC5/RC25": ("pokemon", "RC5/RC25", "", ""),
        "113/1O5": ("pokemon", "113/105", "", ""),                     # O read for 0
        "VEN + SP3/006 + EN": ("riftbound", "SP3/006", "VEN", "EN"),  # bullets read as + or *
        "OGN • 001/298": ("riftbound", "001/298", "OGN", ""),
        "SWSH050": ("pokemon", "SWSH050", "", ""),
    }
    r = run("console.log(JSON.stringify(%s.map(([t, g]) => O.parseNumber(t, g))));" % json.dumps([[t, g] for t, (g, *_rest) in cases.items()]))
    for (text, (_, number, code, lang)), got in zip(cases.items(), r):
        assert got is not None, text
        assert (got["number"], got["set_code"], got["language"]) == (number, code, lang), text


def test_no_number_in_noise():
    r = run("console.log(JSON.stringify(['998.99', 'MEFREAK. 9 *x', '©1995-2000 Nintendo', '', 'LV. 45 #249'].map((t) => O.parseNumber(t))));")
    assert r == [None] * 5


def test_names_from_real_recogniser_output():
    r = run("""console.log(JSON.stringify(["Suicune ex A", "Shining Raichu", "Charizard DELTA SPECIES", "STAGE 1 Ninetales", "Dark Blastoise", "l ucia C", ""].map(O.parseName)));""")
    assert r[0] == {"name": "Suicune ex A", "key": "Suicune"}
    assert r[1]["key"] == "Shining" and r[1]["name"] == "Shining Raichu"
    assert r[2]["key"].lower() == "charizard" or r[2]["key"] == "SPECIES"   # longest word wins; lookups also try the full name
    assert r[3]["key"] == "Ninetales"
    assert r[4]["key"] == "Blastoise"
    assert r[5] is None and r[6] is None


def test_crop_follows_the_card_outline():
    r = run("""
      const w = card([[600, 1000, 700, 1030]]);            // a dark mark in the bottom-right corner
      const src = O.fromWarped(w, 48);
      const br = O.crop(src, [0.75, 0.94, 0.99, 1.0], 750);
      const bl = O.crop(src, [0.0, 0.94, 0.25, 1.0], 750);
      const dark = (img) => { let n = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 128) n++; return n; };
      // Rendering at 1500 px card width doubles the crop size.
      const big = O.crop(src, [0.75, 0.94, 0.99, 1.0], 1500);
      console.log(JSON.stringify({ br: dark(br), bl: dark(bl), size: [br.width, br.height, big.width, big.height] }));""")
    assert r["br"] > 1500 and r["bl"] == 0
    assert r["size"][2] == 2 * r["size"][0] and abs(r["size"][3] - 2 * r["size"][1]) <= 1


def test_text_rows_are_isolated_from_clutter():
    r = run("""
      // Five character-sized marks in a row, plus a big dark block (art) and a thin line (a border).
      const rects = [];
      for (let i = 0; i < 5; i++) rects.push([100 + i * 16, 60, 110 + i * 16, 78]);
      rects.push([300, 20, 500, 110]);
      rects.push([0, 118, 750, 120]);
      const img = O.crop(O.fromWarped(card(rects), 48), [0, 0, 1, 0.12], 750);
      const rows = O.textLines(img, 18, { polarities: [false] });
      const r0 = rows[0];
      let ink = 0; for (let i = 0; i < r0.image.data.length; i += 4) if (r0.image.data[i] === 0) ink++;
      console.log(JSON.stringify({ n: rows.length, count: r0.count, box: r0.box, ink }));""")
    assert r["n"] == 1 and r["count"] == 5
    assert 95 <= r["box"]["x0"] <= 101 and r["box"]["x1"] <= 180
    assert 5 * 10 * 18 <= r["ink"] <= 5 * 11 * 19   # only the five marks (edges sampled at half pixels), nothing of the block or line


def test_read_votes_across_crops_and_survives_a_failing_recogniser():
    r = run("""
      const w = card();
      let n = 0;
      const ok = async () => { n++; return { text: "4/102 ★", confidence: 80 }; };
      const good = await O.read(O.fromWarped(w, 48), "pokemon", ok);
      const bad = await O.read(O.fromWarped(w, 48), "pokemon", async () => { throw new Error("worker failed"); });
      console.log(JSON.stringify({ good: { number: good.number, conf: good.confidence, found: good.found }, calls: n,
        bad: { found: bad.found, errors: bad.readings.filter((x) => x.error).length } }));""")
    assert r["good"]["number"] == "4/102" and r["good"]["found"] and r["good"]["conf"] >= 0.75
    assert r["calls"] >= 4
    assert r["bad"]["found"] is False and r["bad"]["errors"] >= 4


def test_lookup_queries_go_from_most_to_least_specific():
    r = run("""
      console.log(JSON.stringify({
        full: O.queries({ number: "125/197", set_code: "OBF", language: "EN", name: "Charizard ex", name_key: "Charizard" }, "pokemon"),
        numberOnly: O.queries({ number: "4/102", set_code: "", language: "", name: "", name_key: "" }, "pokemon"),
        nameOnly: O.queries({ number: "", set_code: "", language: "", name: "Shining Raichu", name_key: "Shining" }, "pokemon"),
        nothing: O.queries({ number: "", set_code: "", name: "", name_key: "" }, "pokemon"),
      }));""")
    assert [(q["set_code"], q["number"], q["name"]) for q in r["full"]] == [("OBF", "125/197", "Charizard"), ("", "125/197", "Charizard"), ("", "", "Charizard ex"), ("", "", "Charizard")]
    assert [(q["set_code"], q["number"]) for q in r["numberOnly"]] == [("", "4/102")]
    assert [q["name"] for q in r["nameOnly"]] == ["Shining Raichu", "Shining"]
    assert r["nothing"] == []
