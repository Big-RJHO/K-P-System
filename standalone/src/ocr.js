/*
 * Read the card's name and collector line from the scanned photo (text recognition, tesseract.js).
 *
 * What this does: crops fixed areas of the flattened card from Vision.scan (the collector-number corners
 * at the bottom, the name at the top), recognises the text in each, and picks the reading that looks like
 * a real collector number ("125/197", "4/102", "SP3/006", "TG05/TG30") plus a set code and language when
 * the card prints them ("OBF EN", "VEN · SP3/006 · EN").
 *
 * What it does NOT do: it never decides which card this is. The reading goes into the editable details
 * and then through the same card lookup and "This is my card" confirmation as typed text, because a
 * misread digit would otherwise silently pick a different card.
 *
 * The recogniser is injected: in the browser `browserRecognizer()` loads tesseract.js from cdnjs on first
 * use (about 7 MB once, then cached); tests pass a Node recogniser.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CardOCR = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CARD_W = 750, CARD_H = 1048;   // must match Vision
  const MARGIN = 48;
  const RIFTBOUND_SETS = ["OGN", "OGS", "SFD", "UNL", "VEN", "PR", "JDG", "OPP"];
  const LANGS = ["EN", "JP", "JA", "DE", "FR", "IT", "ES", "PT", "KO", "ZH"];

  // Where each field is printed, as fractions of the card (x0, y0, x1, y1). Collector lines move by era:
  // bottom right on WOTC to DP-era Pokemon cards, bottom left from Black & White on and on Riftbound.
  // "lines" regions are searched for rows of character-sized marks, which are read one row at a time
  // (this copes with holo backgrounds and art behind the text); "plain" regions are read whole, which
  // works on clean borders. Both vote. Glyph = expected character height as a share of the card height.
  const REGIONS = {
    pokemon: {
      name: { box: [0.03, 0.015, 0.75, 0.12], glyph: 0.028, cardWidth: 1000 },
      lines: [
        { id: "bottom-right", box: [0.60, 0.92, 0.995, 0.998] },
        { id: "bottom-left", box: [0.005, 0.92, 0.5, 0.998] },
      ],
      plain: [
        { id: "bottom-left-line", box: [0.02, 0.935, 0.42, 0.99] },
        { id: "bottom-right-line", box: [0.62, 0.90, 0.97, 0.97] },
      ],
    },
    riftbound: {
      name: null,   // Riftbound names sit on the art at varying heights; the set + number is enough to look it up
      lines: [{ id: "bottom-left", box: [0.005, 0.925, 0.5, 0.998] }],
      plain: [
        { id: "bottom-left-line", box: [0.03, 0.945, 0.40, 0.99] },
        { id: "bottom-left", box: [0.02, 0.93, 0.50, 1.0] },
      ],
    },
  };
  const NUMBER_GLYPH = 0.013;
  const LINES_CARD_WIDTH = 2400;
  const PLAIN_CARD_WIDTHS = [1500, 2250];
  const MAX_LINES = 4;

  /* ------------------------------------------------------------- image prep */

  /** A source for `crop`: an image plus the homography from card coordinates (0..750, 0..1048) to image pixels. */
  function fromWarped(warped, margin = MARGIN) {
    return { img: warped, H: [1, 0, margin, 0, 1, margin, 0, 0, 1] };
  }

  /**
   * Crop a region of the card (fractions x0, y0, x1, y1) out of `src` ({img, H}), rendered as if the whole
   * card were `cardWidth` px wide: grey, contrast stretched (2nd-98th percentile), bilinear sampling.
   * With the original photo as `src.img`, small print keeps the photo's own resolution instead of the
   * 750 px flattened card's. -> {width, height, data: RGBA}
   */
  function crop(src, region, cardWidth = 1800, shear = 0) {
    const { img, H } = src;
    const k = cardWidth / CARD_W;
    const [x0, y0, x1, y1] = region;
    const W = Math.max(1, Math.round((x1 - x0) * CARD_W * k)), Ht = Math.max(1, Math.round((y1 - y0) * CARD_H * k));
    const g = new Float32Array(W * Ht);
    const sw = img.width, sh = img.height, d = img.data;
    for (let y = 0; y < Ht; y++) {
      const v = y0 * CARD_H + (y + 0.5) / k;
      for (let x = 0; x < W; x++) {
        const u = x0 * CARD_W + (x + 0.5 + shear * (Ht / 2 - y)) / k;   // shear > 0 straightens right-leaning italics
        const den = H[6] * u + H[7] * v + H[8];
        const px = Math.min(sw - 1, Math.max(0, (H[0] * u + H[1] * v + H[2]) / den));
        const py = Math.min(sh - 1, Math.max(0, (H[3] * u + H[4] * v + H[5]) / den));
        const xa = Math.floor(px), ya = Math.floor(py), xb = Math.min(sw - 1, xa + 1), yb = Math.min(sh - 1, ya + 1);
        const fx = px - xa, fy = py - ya;
        const lum = (xx, yy) => { const i = (yy * sw + xx) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
        g[y * W + x] = (lum(xa, ya) * (1 - fx) + lum(xb, ya) * fx) * (1 - fy) + (lum(xa, yb) * (1 - fx) + lum(xb, yb) * fx) * fy;
      }
    }
    const sorted = Float32Array.from(g).sort();
    const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.floor(sorted.length * 0.98)];
    const span = Math.max(16, hi - lo), base = hi - span;   // a plain area stays plain (light), not black
    const out = new Uint8ClampedArray(W * Ht * 4);
    for (let i = 0; i < g.length; i++) {
      const s = Math.max(0, Math.min(255, ((g[i] - base) / span) * 255));
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = s;
      out[i * 4 + 3] = 255;
    }
    return { width: W, height: Ht, data: out };
  }

  /* ------------------------------------------------------------- text-line finding */

  /** Dark-on-light mask by local mean (radius r px, offset c): 1 = ink. `invert` finds light text on dark. */
  function inkMask(img, r, c, invert) {
    const W = img.width, H = img.height, d = img.data;
    const S = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        row += invert ? 255 - d[(y * W + x) * 4] : d[(y * W + x) * 4];
        S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
      }
    }
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
        const mean = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
        const v = invert ? 255 - d[(y * W + x) * 4] : d[(y * W + x) * 4];
        m[y * W + x] = v < mean - c ? 1 : 0;
      }
    }
    return m;
  }

  /** Connected ink blobs (8-connected): [{x0, y0, x1, y1, n, id}] plus the label image. */
  function blobs(mask, W, H) {
    const lab = new Int32Array(W * H).fill(-1);
    const out = [];
    const stack = [];
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || lab[i] >= 0) continue;
      const b = { x0: W, y0: H, x1: 0, y1: 0, n: 0, id: out.length };
      lab[i] = b.id;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop(), x = j % W, y = (j - x) / W;
        b.n++;
        if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const k = yy * W + xx;
          if (mask[k] && lab[k] < 0) { lab[k] = b.id; stack.push(k); }
        }
        if (b.n > 20000) break;   // a big dark area, not a character
      }
      out.push(b);
    }
    return { list: out, lab };
  }

  /**
   * Find rows of character-sized blobs in a crop and render each row alone, black on white, with
   * everything else removed. `glyph` is the expected character height in px.
   * -> [{image, box, count, height}] best rows first.
   */
  function textLines(img, glyph, opts = {}) {
    const W = img.width, H = img.height;
    const rows = [];
    for (const invert of opts.polarities || [false, true]) {
      const mask = inkMask(img, Math.max(8, Math.round(glyph * 1.6)), opts.offset ?? 14, invert);
      const { list, lab } = blobs(mask, W, H);
      const chars = list.filter((b) => {
        const h = b.y1 - b.y0 + 1, w = b.x1 - b.x0 + 1;
        return h >= glyph * 0.55 && h <= glyph * 1.7 && w <= h * 1.3 && b.n >= h * 0.8;
      }).sort((a, b) => a.x0 - b.x0);
      const used = new Set();
      for (const seed of chars) {
        if (used.has(seed.id)) continue;
        const chain = [seed];
        let last = seed;
        const hs = seed.y1 - seed.y0 + 1;
        for (const c of chars) {
          if (c.x0 <= last.x0 || used.has(c.id) || chain.includes(c)) continue;
          const h = c.y1 - c.y0 + 1;
          const gap = c.x0 - last.x1;
          if (gap > hs * 1.4) continue;
          if (Math.abs(c.y1 - last.y1) > hs * 0.45 || h < hs * 0.5 || h > hs * 1.8) continue;
          chain.push(c);
          last = c;
        }
        if (chain.length < 3) continue;
        chain.forEach((c) => used.add(c.id));
        const box = {
          x0: Math.min(...chain.map((c) => c.x0)), y0: Math.min(...chain.map((c) => c.y0)),
          x1: Math.max(...chain.map((c) => c.x1)), y1: Math.max(...chain.map((c) => c.y1)),
        };
        const h = box.y1 - box.y0 + 1, pad = Math.round(h * 0.6);
        const ids = new Set(chain.map((c) => c.id));
        // Keep small marks inside the row too (the dot of "i", a "/" split in two), not only whole characters.
        for (const b of list) {
          if (ids.has(b.id)) continue;
          if (b.x0 >= box.x0 - h && b.x1 <= box.x1 + h && b.y0 >= box.y0 - h * 0.3 && b.y1 <= box.y1 + h * 0.3 && b.y1 - b.y0 < h * 1.5) ids.add(b.id);
        }
        const ow = box.x1 - box.x0 + 1 + 2 * pad, oh = h + 2 * pad;
        const data = new Uint8ClampedArray(ow * oh * 4).fill(255);
        for (let y = box.y0 - Math.round(h * 0.3); y <= box.y1 + Math.round(h * 0.3); y++) {
          for (let x = box.x0 - h; x <= box.x1 + h; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H || !ids.has(lab[y * W + x])) continue;
            const ox = x - box.x0 + pad, oy = y - box.y0 + pad;
            if (ox < 0 || oy < 0 || ox >= ow || oy >= oh) continue;
            const o = (oy * ow + ox) * 4;
            data[o] = data[o + 1] = data[o + 2] = 0;
          }
        }
        rows.push({ image: { width: ow, height: oh, data }, box, count: chain.length, height: h, invert });
      }
    }
    return rows.sort((a, b) => b.count - a.count).slice(0, opts.max || 6);
  }

  /* ------------------------------------------------------------- text parsing */

  // Characters recognisers confuse with digits, fixed only inside a token that is otherwise a number.
  const DIGIT_FIX = { O: "0", o: "0", D: "0", Q: "0", l: "1", I: "1", i: "1", "|": "1", "!": "1", S: "5", s: "5", B: "8", Z: "2", z: "2", g: "9" };
  const fixDigits = (t) => t.replace(/[OoDQlIi|!SsBZzg]/g, (c) => DIGIT_FIX[c]);

  /**
   * Find a collector number in recognised text.
   * -> {number, set_code, language, line, pattern} or null. `pattern` is "slash" (125/197), "promo" (TG05, SWSH050).
   */
  function parseNumber(text, game = "pokemon") {
    const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    let best = null;
    for (const raw of lines) {
      const line = raw.replace(/[•·*+|]/g, " ").replace(/\s+/g, " ");
      // left part: optional letter prefix (SP, TG, GG, SV) then 1-3 digits; right part: optional prefix then 2-3 digits
      const re = /(?:^|[^A-Za-z0-9])((?:SP|TG|GG|SV|RC|H)?[0-9OoDQlIi|!SsBZz]{1,3}[a-z]?)\s*[/\\]\s*((?:TG|GG|SV|RC|H|[0-9A-Z]{2}(?=\d{2}))?[0-9OoDQlIi|!SsBZz]{2,3})(?![0-9])/g;
      let m;
      while ((m = re.exec(line))) {
        const pre = (s) => (s.match(/^(SP|TG|GG|SV|RC|H)/) || [""])[0];
        const left = pre(m[1]) + fixDigits(m[1].slice(pre(m[1]).length));
        let right = pre(m[2]) + fixDigits(m[2].slice(pre(m[2]).length));
        // "SV55/5V94": the right side repeats the left's letters, often misread ("5V", "6G", "T6")
        const lp = pre(m[1]);
        if (lp && !pre(m[2]) && /^[A-Z0-9]{2}\d{2,3}$/.test(m[2]) && m[2].length > 2) right = lp + fixDigits(m[2].slice(lp.length));
        if (!/\d/.test(left) || !/^\D*\d{2,3}$/.test(right)) continue;
        const ln = parseInt(left.replace(/\D/g, ""), 10), rn = parseInt(right.replace(/\D/g, ""), 10);
        if (!(rn > 0) || ln === 0 && !/^[A-Z]/.test(left)) continue;
        if (!/^[A-Z]/.test(left) && ln > rn * 2 + 50) continue;   // "999/12": not a collector number
        const cand = { number: `${left}/${right}`, set_code: "", language: "", line: raw, pattern: "slash" };
        const before = line.slice(0, m.index + (m[0].length - m[0].trimStart().length)).toUpperCase();
        const after = line.slice(m.index + m[0].length).toUpperCase();
        const lang = (after.match(/\b([A-Z]{2})\b/) || before.match(/\b([A-Z]{2})\s*$/) || [])[1];
        if (lang && LANGS.includes(lang)) cand.language = lang === "JA" ? "JP" : lang;
        if (game === "riftbound") {
          const code = (before.match(/\b([A-Z]{2,3})\b[^A-Z]*$/) || [])[1];
          if (code && RIFTBOUND_SETS.includes(code)) cand.set_code = code;
        } else {
          // Scarlet & Violet prints "OBF EN 125/197": a set code directly followed by the language.
          const code = (line.toUpperCase().match(/\b([A-Z]{2,4}[0-9]?)\s+(EN|JP|DE|FR|IT|ES|PT)\b/) || [])[1];
          if (code && !/^(HP|EN|JP|DE|FR|IT|ES|PT|ILLUS)$/.test(code)) { cand.set_code = code; if (!cand.language) cand.language = (line.toUpperCase().match(/\b[A-Z]{2,4}[0-9]?\s+(EN|JP|DE|FR|IT|ES|PT)\b/) || [])[1] || ""; }
        }
        if (!best || (cand.set_code && !best.set_code)) best = cand;
      }
    }
    if (best) return best;
    for (const raw of lines) {   // promos without a total: "SWSH050", "SVP 085", "TG05"
      const m = raw.toUpperCase().match(/\b(SWSH|SVP|SM|XY|BW|TG|GG)\s?([0-9OQDISB]{2,3})\b/);
      if (m) return { number: `${m[1]}${fixDigits(m[2])}`, set_code: "", language: "", line: raw, pattern: "promo" };
    }
    return null;
  }

  const NAME_STOP = new Set(["BASIC", "STAGE", "STAGE1", "STAGE2", "HP", "EVOLVES", "FROM", "PUT", "ON", "THE", "LV", "LV.X", "TRAINER", "ITEM", "SUPPORTER", "STADIUM", "ENERGY", "TOOL", "POKEMON", "TERA"]);

  /** The card's name from the top strip: the longest run of name-like words. -> {name, key} or null. */
  function parseName(text) {
    const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    let best = null;
    for (const line of lines) {
      const words = line.replace(/[^A-Za-zÀ-ÿ'.\- ]+/g, " ").split(/\s+/).filter(Boolean);
      let run = [];
      const flush = () => {
        const name = run.join(" ").replace(/^[-.' ]+|[-.' ]+$/g, "");
        // The longest capitalised word is the safest to look up: a misread short word ("Shinin T") still matches.
        const key = run.filter((w) => w.replace(/[^A-Za-z]/g, "").length >= 4 && /^[A-Z]/.test(w)).sort((a, b) => b.length - a.length)[0] || "";
        if (key && (!best || name.length > best.name.length)) best = { name, key: key.replace(/[^A-Za-zÀ-ÿ'.-]/g, "") };
        run = [];
      };
      for (const w of words) {
        const up = w.toUpperCase().replace(/[^A-Z.]/g, "");
        if (NAME_STOP.has(up) || w.length > 18) { flush(); continue; }
        if (/^[A-Z]/.test(w) || (run.length && /^(ex|EX|GX|V|VMAX|VSTAR|of|the|'s)$/.test(w))) run.push(w);
        else flush();
      }
      flush();
    }
    return best;
  }

  /* ------------------------------------------------------------- reading */

  /**
   * Read the name and collector number of a card.
   * `src` is {img, H} (the original photo and the card-to-photo homography, best) or fromWarped(scan.warped).
   * `recognize(image, {psm})` -> Promise<{text, confidence 0-100}>.
   * -> {found, number, set_code, language, name, name_key, confidence 0..1, alternatives, readings}
   */
  async function read(src, game, recognize, opts = {}) {
    const R = REGIONS[game] || REGIONS.pokemon;
    const readings = [];
    const votes = new Map();
    const ask = async (img, psm, where) => {
      try {
        const res = await recognize(img, { psm });
        return { text: String(res.text || ""), conf: Math.max(0, Math.min(100, Number(res.confidence) || 0)) / 100 };
      } catch (err) {
        readings.push({ where, error: String((err && err.message) || err) });
        return null;
      }
    };
    const vote = (p, conf, where) => {
      const v = votes.get(p.number) || { ...p, n: 0, conf: 0, where: [] };
      v.n += 1;
      v.conf = Math.max(v.conf, conf);
      v.where.push(where);
      if (!v.set_code && p.set_code) v.set_code = p.set_code;
      if (!v.language && p.language) v.language = p.language;
      votes.set(p.number, v);
    };

    // Name: the tallest row of letters near the top.
    let name = null;
    if (R.name) {
      const img = crop(src, R.name.box, R.name.cardWidth);
      const glyph = R.name.glyph * CARD_H * (R.name.cardWidth / CARD_W);
      const rows = textLines(img, glyph, { max: 3 }).sort((a, b) => b.height * Math.min(b.count, 8) - a.height * Math.min(a.count, 8));
      for (const row of rows) {
        const res = await ask(row.image, 7, "name");
        if (!res) continue;
        const n = parseName(res.text);
        readings.push({ where: "name", text: res.text.trim(), confidence: res.conf, name: n && n.name });
        if (n) { name = { ...n, conf: res.conf }; break; }
      }
    }

    // Collector number: rows of small characters in the bottom corners, then the plain crops.
    const glyph = NUMBER_GLYPH * CARD_H * (LINES_CARD_WIDTH / CARD_W);
    for (const r of R.lines) {
      const img = crop(src, r.box, LINES_CARD_WIDTH);
      for (const row of textLines(img, glyph, { max: MAX_LINES })) {
        const res = await ask(row.image, 7, r.id);
        if (!res) continue;
        const p = parseNumber(res.text, game);
        readings.push({ where: `${r.id} row`, text: res.text.trim(), confidence: res.conf, number: p && p.number });
        if (p) vote(p, res.conf, `${r.id} row`);
      }
    }
    for (const r of R.plain) {
      for (const cw of PLAIN_CARD_WIDTHS) {
        const res = await ask(crop(src, r.box, cw), 6, r.id);
        if (!res) continue;
        const p = parseNumber(res.text, game);
        readings.push({ where: r.id, text: res.text.trim(), confidence: res.conf, number: p && p.number });
        if (p) vote(p, res.conf, r.id);
      }
    }

    const rank = (v) => v.n + v.conf + (v.pattern === "slash" ? 0.5 : 0) + (v.set_code ? 0.3 : 0);
    const ranked = [...votes.values()].sort((a, b) => rank(b) - rank(a));
    const top = ranked[0] || null;
    const conflict = !!(top && ranked.length > 1 && ranked[1].n >= top.n);
    const confidence = top ? Math.max(0, Math.min(1, Math.max(top.conf, 0.5) * (top.n >= 2 ? 1 : 0.75) * (conflict ? 0.6 : 1))) : 0;
    return {
      found: !!(top || name),
      number: top ? top.number : "",
      set_code: top ? top.set_code : "",
      language: top ? top.language : "",
      name: name ? name.name : "",
      name_key: name ? name.key : "",
      confidence: Math.round(confidence * 100) / 100,
      conflict,
      alternatives: ranked.slice(1, 3).map((v) => v.number),
      readings,
    };
  }

  /**
   * Card-lookup queries to try in order for a reading (for Identify.candidates): set + number, then number
   * (with the name as a cross-check), then name alone. The user still confirms the card.
   */
  function queries(reading, game) {
    const q = [];
    const base = { game, language: reading.language || "" };
    const name = reading.name_key || "";
    if (reading.number && reading.set_code) q.push({ ...base, set_code: reading.set_code, number: reading.number, name });
    if (reading.number) q.push({ ...base, set_code: "", number: reading.number, name });
    if (reading.name && reading.name !== name) q.push({ ...base, set_code: "", number: "", name: reading.name });
    if (name) q.push({ ...base, set_code: "", number: "", name });
    return q;
  }

  /* ------------------------------------------------------------- browser recogniser */

  const CDN = {
    lib: "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js",
    worker: "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/worker.min.js",
    core: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
    lang: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int",
  };
  let workerPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (typeof window !== "undefined" && window.Tesseract) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("The text reader couldn't be downloaded (offline, or this page can't load it)."));
      document.head.append(s);
    });
  }

  /** A recogniser for `read()` that runs tesseract.js in a Web Worker. Loaded on first use. */
  function browserRecognizer(onStatus) {
    async function worker() {
      if (!workerPromise) {
        workerPromise = (async () => {
          onStatus && onStatus("Downloading the text reader (about 7 MB, first time only)…");
          await loadScript(CDN.lib);
          const w = await window.Tesseract.createWorker("eng", 1, { workerPath: CDN.worker, corePath: CDN.core, langPath: CDN.lang, workerBlobURL: true });
          return w;
        })().catch((err) => { workerPromise = null; throw err; });
      }
      return workerPromise;
    }
    let queue = Promise.resolve();
    return (img, { psm = 6 } = {}) => {
      const job = queue.then(async () => {
        const w = await worker();
        onStatus && onStatus("Reading the card…");
        await w.setParameters({ tessedit_pageseg_mode: String(psm) });
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
        const r = await w.recognize(canvas);
        return { text: r.data.text, confidence: r.data.confidence };
      });
      queue = job.catch(() => {});
      return job;
    };
  }

  return { read, queries, crop, fromWarped, textLines, parseNumber, parseName, browserRecognizer, REGIONS, CDN, CARD_W, CARD_H };
});
