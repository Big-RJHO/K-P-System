/*
 * Riftbound card prices: TCGplayer market prices for the ungraded card, from the daily file the Pages
 * workflow builds (scripts/fetch_riftbound_prices.py, data via tcgcsv.com).
 *
 * The card is matched by its TCGplayer product id when the card database gave one (Riftcodex does for most
 * cards), otherwise by set code and collector number, with the name as a check. Graded Riftbound prices
 * aren't in this data (TCGplayer doesn't list graded cards): the app's web search covers those.
 *
 * Works in browsers and in Node (tests inject `fetch`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RiftPrices = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------- request deadline (net.js) */

  // The shared helper: required next to this file in Node, the page's global in the browser. Without it
  // (this file loaded alone) requests still work, only without a deadline.
  function netLib() {
    try { if (typeof require === "function") return require("./net.js"); } catch (err) { /* not next to it */ }
    const g = typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : {};
    return (g && g.Net) || null;
  }
  async function fetchJSON(url, opts) {
    const N = netLib();
    if (N) return N.fetchJSON(url, opts);
    const { timeoutMs, fetch: F, ...init } = opts;
    const res = await F(url, init);
    let body = null;
    try { body = await res.json(); } catch (err) { body = null; }
    return { res, ok: !!res.ok, status: res.status, body };
  }
  const isTimeout = (err) => !!err && (err.timeout === true || err.name === "TimeoutError");

  // The file lives on the app's GitHub Pages site (which allows cross-site reads), so the Claude-hosted
  // copy of the app can read it too.
  const SITE_URL = "https://big-rjho.github.io/K-P-System/riftbound-prices.json";
  const TIMEOUT_MS = 15000;   // headers and body together
  let cached = null;

  const norm = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  /** "001/298" -> "1/298", "sp3/006" -> "SP3/6", "021a/166" -> "21A/166". */
  const numKey = (s) => String(s == null ? "" : s).toUpperCase().replace(/\s+/g, "").split("/")
    .map((p) => p.replace(/^([A-Z]*)0+(?=\d)/, "$1")).join("/");

  /** Load the price file once per page session. `url` defaults to the site copy. */
  async function load(opts = {}) {
    if (cached && !opts.force) return cached;
    const F = opts.fetch || (typeof fetch === "function" ? fetch : null);
    if (!F) throw new Error("No network available.");
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    let res;
    try {
      res = await fetchJSON(opts.url || SITE_URL, { fetch: F, timeoutMs, cache: "no-cache" });
    } catch (err) {
      if (isTimeout(err)) throw new Error(`The Riftbound price list didn't download within ${Math.round(timeoutMs / 1000)} seconds (slow connection?). Try again.`);
      throw new Error("The Riftbound price list couldn't be downloaded (offline?).");
    }
    if (!res.ok) throw new Error(`The Riftbound price list isn't available right now (HTTP ${res.status}).`);
    const data = res.body;
    if (!data || typeof data.cards !== "object") throw new Error("The Riftbound price list couldn't be read.");
    cached = data;
    return data;
  }

  /**
   * Find the card. `card` = {tcgplayer_id, set_code, number, name}.
   * -> {id, card, how: "tcgplayer id" | "set and number", name_matches} or null
   */
  function find(data, card) {
    const cards = (data && data.cards) || {};
    const id = String(card.tcgplayer_id || "");
    const nameOk = (c) => {
      const a = norm(card.name), b = norm(c.name);
      return !a || b.includes(a) || a.includes(b.split(" (")[0]) || b.startsWith(a.split(" ")[0]);
    };
    if (id && cards[id]) return { id, card: cards[id], how: "tcgplayer id", name_matches: nameOk(cards[id]) };
    const want = numKey(card.number);
    if (!want) return null;
    const set = String(card.set_code || "").toUpperCase();
    const hits = Object.entries(cards).filter(([, c]) => numKey(c.number) === want && (!set || c.set === set));
    if (!hits.length) return null;
    hits.sort(([, a], [, b]) => Number(nameOk(b)) - Number(nameOk(a)) || Number(/\(/.test(a.name)) - Number(/\(/.test(b.name)));
    const [hid, hc] = hits[0];
    return { id: hid, card: hc, how: "set and number", name_matches: nameOk(hc), others: hits.length - 1 };
  }

  /** Price rows, one per printing (Normal, Foil, ...). */
  function rows(card) {
    return Object.entries((card && card.prices) || {}).map(([printing, p]) => ({ printing, market: p.market ?? null, low: p.low ?? null, mid: p.mid ?? null }))
      .sort((a, b) => (b.market || b.mid || 0) - (a.market || a.mid || 0));
  }

  return { load, find, rows, numKey, SITE_URL, TIMEOUT_MS, _reset: () => { cached = null; } };
});
