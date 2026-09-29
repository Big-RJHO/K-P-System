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

  // The file lives on the app's GitHub Pages site (which allows cross-site reads), so the Claude-hosted
  // copy of the app can read it too.
  const SITE_URL = "https://big-rjho.github.io/K-P-System/riftbound-prices.json";
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
    let res;
    try {
      res = await F(opts.url || SITE_URL, { cache: "no-cache" });
    } catch (err) {
      throw new Error("The Riftbound price list couldn't be downloaded (offline?).");
    }
    if (!res.ok) throw new Error(`The Riftbound price list isn't available right now (HTTP ${res.status}).`);
    const data = await res.json();
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

  return { load, find, rows, numKey, SITE_URL, _reset: () => { cached = null; } };
});
