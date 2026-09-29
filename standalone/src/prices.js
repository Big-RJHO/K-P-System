/*
 * Card prices from PriceCharting, for the ungraded card and for the grade this report gives.
 *
 * What this does: builds a PriceCharting search from the confirmed card details, ranks the products it
 * returns (the right number, set and version: "[1st Edition]", "[Shadowless]", "[Reverse Holo]" and
 * "[Foil]" copies sell for very different amounts), fetches that product's prices, and maps each grading
 * company's grade to the PriceCharting price for that grade.
 *
 * What it does NOT do: it never changes a grade, and a price at a ceiling ("Up to 9") is labelled as a
 * best case, not a valuation. It does not scrape pricecharting.com: without an API token it only builds
 * a link the user opens themselves.
 *
 * Access (checked 2026-09-29, see docs/pricing.md): https://www.pricecharting.com/api/product(s)?t=TOKEN
 * needs a paid PriceCharting subscription token (40 characters). Responses carry CORS "*", prices are in
 * cents, and the limit is one call per second. PriceCharting licenses API data for the subscriber's own
 * use, so the token is the user's own, kept on their device only.
 *
 * Works in browsers and in Node (tests inject `fetch` and `storage`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Prices = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BASE = "https://www.pricecharting.com";
  const MIN_GAP_MS = 1100;             // PriceCharting allows one call per second
  const CACHE_MS = 24 * 3600 * 1000;   // its prices are regenerated once a day
  const CACHE_PREFIX = "kp.pc.";

  const norm = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  /* ------------------------------------------------------------- grade -> PriceCharting key */

  // PriceCharting keys for cards (API documentation, "Description of Keys"). Grades 1-9.5 are
  // "graded X by a grading company", with no split by company; only the 10s are per company.
  const GRADE_KEYS = [
    [9.5, "box-only-price"], [9, "graded-price"], [8, "new-price"], [7, "cib-price"],
    [6, "condition-16-price"], [5, "condition-15-price"], [4, "condition-14-price"],
    [3, "condition-13-price"], [2, "condition-10-price"], [1, "condition-9-price"],
  ];
  const LADDER = [
    ["Ungraded", "loose-price"],
    ["Grade 1", "condition-9-price"], ["Grade 2", "condition-10-price"], ["Grade 3", "condition-13-price"],
    ["Grade 4", "condition-14-price"], ["Grade 5", "condition-15-price"], ["Grade 6", "condition-16-price"],
    ["Grade 7 / 7.5", "cib-price"], ["Grade 8 / 8.5", "new-price"], ["Grade 9", "graded-price"], ["Grade 9.5", "box-only-price"],
    ["PSA 10", "manual-only-price"], ["BGS 10 (Pristine)", "bgs-10-price"], ["BGS 10 Black Label", "condition-20-price"],
    ["CGC 10 (Gem Mint)", "condition-17-price"], ["CGC Pristine 10", "condition-19-price"],
    ["TAG 10", "condition-21-price"], ["SGC 10", "condition-18-price"], ["ACE 10", "condition-22-price"],
  ];

  /**
   * Which PriceCharting price stands for this company's grade.
   * `g` is a grade from Grading.gradeAll: {company, grade, label, tier, complete}.
   * -> {key, basis, note} or {key:null, note} when there is no price for it (altered, authentic only).
   */
  function gradeKey(g) {
    if (!g || g.tier >= 99 || !(g.grade >= 1)) return { key: null, basis: "", note: "No graded price: this card wouldn't get a number." };
    const label = String(g.label || "");
    const co = g.company;
    if (g.grade >= 10) {
      if (co === "PSA") return { key: "manual-only-price", basis: "PSA 10", note: "" };
      if (co === "BGS") {
        if (/black label/i.test(label)) return { key: "condition-20-price", basis: "BGS 10 Black Label", note: "" };
        return { key: "bgs-10-price", basis: "BGS 10 (Pristine)", note: "" };
      }
      if (co === "CGC") {
        return /pristine/i.test(label)
          ? { key: "condition-19-price", basis: "CGC Pristine 10", note: "" }
          : { key: "condition-17-price", basis: "CGC 10 (Gem Mint)", note: "" };
      }
      if (co === "TAG") {
        return { key: "condition-21-price", basis: "TAG 10", note: /pristine/i.test(label) ? "" : "PriceCharting lists one TAG 10 price; it doesn't separate Gem Mint 10 from Pristine 10." };
      }
    }
    const v = g.grade;
    const [step, key] = GRADE_KEYS.find(([min]) => v >= min) || GRADE_KEYS[GRADE_KEYS.length - 1];
    const notes = ["PriceCharting's price for this grade from any grading company, not for this company alone."];
    if (v !== step && !(step === 7 || step === 8)) notes.push(`There is no separate ${v} price, so this is the grade ${step} price.`);
    const basis = step === 7 ? "Grade 7 / 7.5" : step === 8 ? "Grade 8 / 8.5" : `Grade ${step}`;
    return { key, basis, note: notes.join(" ") };
  }

  /* ------------------------------------------------------------- search + matching */

  const gameWord = (game) => (game === "riftbound" ? "Riftbound" : "Pokemon");

  /** Collector number as PriceCharting prints it: "125/197" -> "125", "025" -> "25", "SP3/006" -> "SP3", "TG05" -> "TG05". */
  function pcNumber(raw) {
    const left = String(raw == null ? "" : raw).trim().toUpperCase().split("/")[0].replace(/\s+/g, "");
    return /^\d+$/.test(left) ? String(parseInt(left, 10)) : left;
  }

  /** The search text for a card: "Charizard ex #125 Pokemon Obsidian Flames". */
  function query(card) {
    const num = pcNumber(card.number);
    return [card.name, num ? `#${num}` : "", gameWord(card.game), card.set_name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  /** A link to PriceCharting's own search, for the user to open (no token needed). */
  function searchUrl(card) {
    return `${BASE}/search-products?type=prices&q=${encodeURIComponent(query(card))}`;
  }

  /** Link to a product page, when the id and PriceCharting's own names are known. */
  function productUrl(p) {
    return p && p.id ? `${BASE}/game/${encodeURIComponent(p.id)}` : "";
  }

  // Words in square brackets that mean a different, differently priced version.
  function bracketsOf(name) {
    return (String(name || "").match(/\[([^\]]+)\]/g) || []).map((b) => b.slice(1, -1).trim());
  }

  /**
   * Rank PriceCharting products for a card. Returns every product with {score 0..1, reasons, variant}.
   * A product is only "matched" when its number agrees; the version in brackets decides among those.
   */
  function rankProducts(products, card) {
    const num = pcNumber(card.number);
    const want = norm(card.name);
    const setWords = norm(card.set_name);
    const finish = norm(card.finish);
    const wantsFirst = /1st/.test(norm(card.edition));
    const out = [];
    for (const p of products || []) {
      const name = String(p["product-name"] || "");
      const consoleName = String(p["console-name"] || "");
      const reasons = [];
      let s = 0;
      const numMatch = name.match(/#\s*([A-Za-z]*\d+[A-Za-z]*)/);
      const pnum = numMatch ? pcNumber(numMatch[1]) : "";
      if (num && pnum === num) { s += 0.45; reasons.push(`number #${pnum} matches`); }
      else if (num && pnum) { s -= 0.5; reasons.push(`different number (#${pnum})`); }
      const base = norm(name.replace(/\[[^\]]*\]/g, "").replace(/#\s*\S+/, ""));
      if (want && base === want) { s += 0.25; reasons.push("name matches"); }
      else if (want && (base.includes(want) || want.includes(base))) { s += 0.12; reasons.push("name partly matches"); }
      else if (want) { s -= 0.2; reasons.push("different name"); }
      const cons = norm(consoleName.replace(/^(pokemon|riftbound)\s+/i, ""));
      if (setWords && cons === setWords) { s += 0.25; reasons.push("set matches"); }
      else if (setWords && (cons.includes(setWords) || setWords.includes(cons))) { s += 0.1; reasons.push("set partly matches"); }
      else if (setWords) { s -= 0.15; reasons.push(`different set (${consoleName})`); }
      const br = bracketsOf(name);
      const variant = br.join(", ");
      if (!br.length) { s += 0.05; }
      else {
        const b = norm(variant);
        const finishHit = (finish && b.includes(finish)) || (/reverse/.test(finish) && /reverse/.test(b)) || (/foil/.test(finish) && /foil/.test(b));
        const firstHit = wantsFirst && /1st/.test(b);
        if (finishHit || firstHit) { s += 0.05; reasons.push(`version [${variant}] matches what you entered`); }
        else { s -= 0.1; reasons.push(`a special version [${variant}]: check it's yours`); }
      }
      out.push({ id: String(p.id || ""), product_name: name, console_name: consoleName, variant, score: Math.max(0, Math.min(1, s)), reasons, raw: p });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /* ------------------------------------------------------------- network */

  let lastCall = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function call(path, params, opts) {
    const F = opts.fetch || (typeof fetch === "function" ? fetch : null);
    if (!F) throw new Error("No network available.");
    const gap = lastCall + MIN_GAP_MS - Date.now();
    if (gap > 0) await wait(gap);
    lastCall = Date.now();
    const qs = Object.entries({ t: opts.token, ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    let res;
    try {
      res = await F(`${BASE}${path}?${qs}`, { headers: { Accept: "application/json" } });
    } catch (err) {
      throw new Error("PriceCharting couldn't be reached (offline, or this page isn't allowed to contact it).");
    }
    let body = null;
    try { body = await res.json(); } catch (err) { body = null; }
    if (!res.ok || !body || body.status !== "success") {
      const msg = body && (body["error-message"] || body.error);
      if (/token/i.test(msg || "")) throw new Error("PriceCharting didn't accept the API token. Check it on your PriceCharting subscription page (API/Download).");
      throw new Error(`PriceCharting answered with an error${msg ? `: ${msg}` : ` (HTTP ${res.status})`}.`);
    }
    return body;
  }

  function cacheGet(storage, key, now) {
    try {
      const hit = storage && JSON.parse(storage.getItem(CACHE_PREFIX + key) || "null");
      return hit && now - hit.at < CACHE_MS ? hit.data : null;
    } catch (err) { return null; }
  }

  function cachePut(storage, key, data, now) {
    try { if (storage) storage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: now, data })); } catch (err) { /* full or blocked */ }
  }

  /** Remove every cached PriceCharting response (e.g. when the token is removed: its data must go too). */
  function clearCache(storage) {
    try {
      if (!storage) return;
      const keys = [];
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(CACHE_PREFIX)) keys.push(k); }
      keys.forEach((k) => storage.removeItem(k));
    } catch (err) { /* blocked */ }
  }

  /**
   * Search PriceCharting for a card and rank the results.
   * -> {query, matches:[ranked products], best|null, needs_choice, error?}
   */
  async function search(card, opts = {}) {
    const q = query(card);
    if (!opts.token) return { query: q, matches: [], best: null, needs_choice: false, error: "no-token" };
    if (!card.name && !card.number) return { query: q, matches: [], best: null, needs_choice: false, error: "Confirm the card's name and number first." };
    const now = (opts.now || Date.now)();
    let products = cacheGet(opts.storage, `q:${q}`, now);
    if (!products) {
      const body = await call("/api/products", { q }, opts);
      products = (body.products || []).map((p) => ({ id: p.id, "product-name": p["product-name"], "console-name": p["console-name"] }));
      cachePut(opts.storage, `q:${q}`, products, now);
    }
    const matches = rankProducts(products, card);
    const top = matches[0] || null;
    const best = top && top.score >= 0.5 ? top : null;
    return {
      query: q, matches, best,
      // Ask the user to check whenever other versions of the same card exist (1st Edition, Shadowless, ...).
      needs_choice: !best || !!best.variant || matches.slice(1).some((m) => m.score >= 0.7),
      error: matches.length ? undefined : "PriceCharting has no product matching this card.",
    };
  }

  /** Prices of one PriceCharting product (all values in cents, or null). */
  async function product(id, opts = {}) {
    if (!opts.token) throw new Error("no-token");
    const now = (opts.now || Date.now)();
    const hit = cacheGet(opts.storage, `p:${id}`, now);
    if (hit) return hit;
    const body = await call("/api/product", { id }, opts);
    const keep = { id: String(body.id || id), product_name: body["product-name"] || "", console_name: body["console-name"] || "", fetched_at: now, prices: {} };
    for (const [, key] of LADDER) keep.prices[key] = Number.isFinite(body[key]) && body[key] > 0 ? body[key] : null;
    cachePut(opts.storage, `p:${id}`, keep, now);
    return keep;
  }

  /**
   * Prices for a report: the ungraded price, and for each company the price at its grade.
   * `report` is Grading.gradeAll's result. Every row says what it's based on.
   */
  function forReport(prod, report) {
    const p = (prod && prod.prices) || {};
    const ceiling = !!report && report.complete === false;
    const rows = [];
    for (const g of Object.values((report && report.grades) || {})) {
      const k = gradeKey(g);
      rows.push({
        company: g.company, grade: g.grade, label: g.label, key: k.key, basis: k.basis,
        cents: k.key ? p[k.key] ?? null : null,
        note: [k.note, k.key && p[k.key] == null ? "PriceCharting has no sales at this grade yet." : ""].filter(Boolean).join(" "),
        ceiling: g.complete === false,
      });
    }
    return { ungraded: p["loose-price"] ?? null, rows, ceiling };
  }

  /** The full grade ladder for the product (for "all grades"). */
  function ladder(prod) {
    const p = (prod && prod.prices) || {};
    return LADDER.map(([label, key]) => ({ label, key, cents: p[key] ?? null }));
  }

  /** Ungraded market prices from TCGdex's card record (free, Pokemon only): TCGplayer (USD) and Cardmarket (EUR). */
  function fromTcgdex(pricing) {
    if (!pricing || typeof pricing !== "object") return null;
    const out = {};
    const tp = pricing.tcgplayer;
    if (tp && typeof tp === "object") {
      const kinds = Object.entries(tp).filter(([, v]) => v && typeof v === "object" && Number.isFinite(v.marketPrice));
      if (kinds.length) out.tcgplayer = { unit: tp.unit || "USD", updated: tp.updated || "", versions: kinds.map(([k, v]) => ({ version: k, market: v.marketPrice, low: Number.isFinite(v.lowPrice) ? v.lowPrice : null })) };
    }
    const cm = pricing.cardmarket;
    if (cm && Number.isFinite(cm.trend)) out.cardmarket = { unit: cm.unit || "EUR", updated: cm.updated || "", trend: cm.trend, avg30: Number.isFinite(cm.avg30) ? cm.avg30 : null };
    return out.tcgplayer || out.cardmarket ? out : null;
  }

  const money = (cents) => (cents == null ? "—" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  function validToken(t) { return /^[0-9a-f]{40}$/i.test(String(t || "").trim()); }

  return { query, searchUrl, productUrl, pcNumber, rankProducts, gradeKey, search, product, forReport, ladder, fromTcgdex, money, validToken, clearCache, LADDER, _reset: () => { lastCall = 0; } };
});
