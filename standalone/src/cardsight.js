/*
 * Sales prices from CardSight AI (Pokemon), for the ungraded card and for the grades this report gives.
 *
 * What this does: finds the confirmed card in CardSight's catalog (one search call), fetches its completed
 * auction sales for the last year (one pricing call), and summarises them per grade: number of sales,
 * median, range and the latest sale with a link to it. Versions (parallels such as reverse holo) are kept
 * apart; the base card is shown unless the user picks another.
 *
 * What it does NOT do: it never changes a grade. A price at a ceiling ("Up to 9") is labelled as a best case.
 *
 * Access (checked 2026-09-29, see docs/pricing.md): https://api.cardsight.ai, key in the X-API-Key header,
 * CORS "*". Free plan: 750 calls a month, hard-capped (no charges). CardSight's terms: the key is personal
 * and must not be shared, so each person enters their own and it stays on their device; data may be cached
 * short-term only, so answers are kept for 24 h and purged when the key is removed.
 *
 * Works in browsers and in Node (tests inject `fetch` and `storage`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CardSight = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BASE = "https://api.cardsight.ai";
  const CACHE_MS = 24 * 3600 * 1000;
  const CACHE_PREFIX = "kp.cs.";
  const PERIOD = "1y";

  const norm = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  /** "125/197" -> "125", "025" -> "25", "SP3/006" -> "SP3". */
  const cardNo = (raw) => {
    const left = String(raw == null ? "" : raw).trim().toUpperCase().split("/")[0].replace(/\s+/g, "");
    return /^\d+$/.test(left) ? String(parseInt(left, 10)) : left;
  };

  /* ------------------------------------------------------------- network */

  function cacheGet(storage, key, now) {
    try {
      const hit = storage && JSON.parse(storage.getItem(CACHE_PREFIX + key) || "null");
      return hit && now - hit.at < CACHE_MS ? hit.data : null;
    } catch (err) { return null; }
  }
  function cachePut(storage, key, data, now) {
    try { if (storage) storage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: now, data })); } catch (err) { /* full or blocked */ }
  }
  function clearCache(storage) {
    try {
      if (!storage) return;
      const keys = [];
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(CACHE_PREFIX)) keys.push(k); }
      keys.forEach((k) => storage.removeItem(k));
    } catch (err) { /* blocked */ }
  }

  async function get(path, params, opts) {
    const F = opts.fetch || (typeof fetch === "function" ? fetch : null);
    if (!F) throw new Error("No network available.");
    const qs = Object.entries(params || {}).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    let res;
    try {
      res = await F(`${BASE}${path}${qs ? `?${qs}` : ""}`, { headers: { "X-API-Key": opts.apiKey, Accept: "application/json" } });
    } catch (err) {
      throw new Error("CardSight couldn't be reached (offline, or this page isn't allowed to contact it).");
    }
    let body = null;
    try { body = await res.json(); } catch (err) { body = null; }
    if (!res.ok) {
      const msg = String((body && (body.message || body.error)) || "");
      if (res.status === 401 || res.status === 403) throw new Error("CardSight didn't accept the API key. Check it at app.cardsight.ai.");
      if (res.status === 429) throw new Error("CardSight's limit is reached (the free plan allows 750 calls a month, 4 a second). Try again later.");
      if (res.status === 404) return null;
      throw new Error(`CardSight answered with an error${msg ? `: ${msg.slice(0, 160)}` : ` (HTTP ${res.status})`}.`);
    }
    return body;
  }

  /* ------------------------------------------------------------- finding the card */

  /** Rank catalog search results for a card. -> [{id, name, number, set, release, year, score, reasons}] */
  function rankCards(results, card) {
    const num = cardNo(card.number);
    const want = norm(card.name);
    const setWords = norm(card.set_name);
    const out = [];
    for (const r of results || []) {
      if (r.type && r.type !== "card") continue;
      if (card.game !== "riftbound" && r.segmentName && !/pok/i.test(r.segmentName)) continue;
      const reasons = [];
      let s = 0;
      const n = cardNo(r.cardNumber);
      if (num && n === num) { s += 0.45; reasons.push(`number ${n} matches`); }
      else if (num && n) { s -= 0.5; reasons.push(`different number (${r.cardNumber})`); }
      const nm = norm(r.name);
      if (want && nm === want) { s += 0.25; reasons.push("name matches"); }
      else if (want && (nm.includes(want) || want.includes(nm))) { s += 0.12; reasons.push("name partly matches"); }
      else if (want) { s -= 0.2; reasons.push("different name"); }
      const sets = [norm(r.setName), norm(r.releaseName)].filter(Boolean);
      if (setWords && sets.some((x) => x === setWords || x.endsWith(` ${setWords}`) || x.startsWith(`${setWords} `))) { s += 0.25; reasons.push("set matches"); }
      else if (setWords && sets.some((x) => x.includes(setWords) || setWords.includes(x))) { s += 0.12; reasons.push("set partly matches"); }
      else if (setWords) { s -= 0.15; reasons.push(`different set (${r.setName || r.releaseName || "?"})`); }
      out.push({ id: String(r.id || ""), name: String(r.name || ""), number: String(r.cardNumber || ""), set: String(r.setName || ""),
        release: String(r.releaseName || ""), year: String(r.year || ""), score: Math.max(0, Math.min(1, s)), reasons });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Search the catalog for the card. -> {query, matches, best|null, needs_choice} */
  async function findCard(card, opts = {}) {
    if (!opts.apiKey) throw new Error("no-key");
    const q = [card.name, cardNo(card.number), card.set_name].filter(Boolean).join(" ").slice(0, 200);
    const now = (opts.now || Date.now)();
    let results = cacheGet(opts.storage, `s:${q}`, now);
    if (!results) {
      const body = await get("/v1/catalog/search", { q, type: "card", take: 25 }, opts);
      results = ((body && body.results) || []).map((r) => ({ type: r.type, id: r.id, name: r.name, cardNumber: r.cardNumber, setName: r.setName,
        releaseName: r.releaseName, year: r.year, segmentName: r.segmentName }));
      cachePut(opts.storage, `s:${q}`, results, now);
    }
    const matches = rankCards(results, card);
    const best = matches[0] && matches[0].score >= 0.5 ? matches[0] : null;
    return { query: q, matches, best, needs_choice: !best || matches.slice(1).some((m) => m.score >= best.score - 0.05) };
  }

  /** Completed auction sales for a card over the last year (raw and graded). */
  async function sales(cardId, opts = {}) {
    if (!opts.apiKey) throw new Error("no-key");
    const now = (opts.now || Date.now)();
    const hit = cacheGet(opts.storage, `p:${cardId}`, now);
    if (hit) return hit;
    const body = await get(`/v1/pricing/${encodeURIComponent(cardId)}`, { period: PERIOD, listing_type: "auction", limit: 500 }, opts);
    if (!body) return null;
    const slim = (recs) => (recs || []).map((r) => ({ price: Number(r.price), date: String(r.date || "").slice(0, 10), source: String(r.source || ""),
      url: /^https:\/\//.test(r.url || "") ? r.url : "", parallel: r.parallel_id || null, parallel_name: r.parallel_name || "", type: r.listing_type || "" }))
      .filter((r) => r.price > 0);
    const data = {
      card: body.card || {}, fetched_at: now,
      raw: slim(body.raw && body.raw.records),
      graded: (body.graded || []).map((c) => ({ company: String(c.company_name || ""), grades: (c.grades || []).map((g) => ({ grade: String(g.grade_value || ""), records: slim(g.records) })) })),
      messages: (body.messages || []).map((m) => String(m.message || "")).slice(0, 3),
    };
    cachePut(opts.storage, `p:${cardId}`, data, now);
    return data;
  }

  /* ------------------------------------------------------------- summarising */

  function stats(records) {
    const r = (records || []).filter((x) => x.type !== "fixed" && x.price > 0);
    if (!r.length) return null;
    const p = r.map((x) => x.price).sort((a, b) => a - b);
    const mid = p.length >> 1;
    const median = p.length % 2 ? p[mid] : (p[mid - 1] + p[mid]) / 2;
    const last = r.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    return { count: r.length, median: Math.round(median * 100) / 100, low: p[0], high: p[p.length - 1], last };
  }

  /** Versions (parallels) present in the sales, base card first. */
  function versions(data) {
    const seen = new Map([["", { id: "", name: "Base card", count: 0 }]]);
    const add = (r) => {
      const id = r.parallel || "";
      if (!seen.has(id)) seen.set(id, { id, name: r.parallel_name || "Other version", count: 0 });
      seen.get(id).count++;
    };
    (data && data.raw || []).forEach(add);
    (data && data.graded || []).forEach((c) => c.grades.forEach((g) => g.records.forEach(add)));
    return [...seen.values()].filter((v, i) => i === 0 || v.count > 0);
  }

  const gradeNum = (s) => { const v = parseFloat(String(s).replace(/[^0-9.]/g, "")); return Number.isFinite(v) ? v : null; };

  /**
   * Prices for a report: ungraded, and each company at its grade. `version` = parallel id ("" = base card).
   * -> {ungraded: stats|null, rows:[{company, label, grade, stats, ceiling, note}], all:[{company, grade, stats}], ceiling}
   */
  function forReport(data, report, version = "") {
    const pick = (recs) => (recs || []).filter((r) => (r.parallel || "") === version);
    const all = [];
    for (const c of (data && data.graded) || []) {
      for (const g of c.grades) {
        const st = stats(pick(g.records));
        if (st) all.push({ company: c.company, grade: g.grade, stats: st });
      }
    }
    all.sort((a, b) => a.company.localeCompare(b.company) || (gradeNum(b.grade) || 0) - (gradeNum(a.grade) || 0));
    const rows = [];
    for (const g of Object.values((report && report.grades) || {})) {
      if (!g || g.tier >= 99 || !(g.grade >= 1)) continue;
      const want = g.grade >= 10 ? 10 : g.grade;
      const hit = all.find((x) => x.company.toUpperCase() === g.company && gradeNum(x.grade) === want);
      const special = g.grade >= 10 && /pristine|black label/i.test(String(g.label || ""));
      rows.push({
        company: g.company, label: String(g.label || "").replace(/^Up to /, "").replace(/ · incomplete$/, ""), grade: want,
        stats: hit ? hit.stats : null, ceiling: g.complete === false,
        note: [hit ? "" : "No sales at this grade in the last year.", special && hit ? "Sales data doesn't separate Pristine / Black Label from a plain 10." : ""].filter(Boolean).join(" "),
      });
    }
    return { ungraded: stats(pick(data && data.raw)), rows, all, ceiling: !!(report && report.complete === false) };
  }

  const validKey = (k) => /^[A-Za-z0-9_\-.]{20,200}$/.test(String(k || "").trim());

  return { findCard, sales, forReport, versions, stats, rankCards, cardNo, clearCache, validKey };
});
