/*
 * Card identification and reference-image support.
 *
 * What this does: given what the user typed (set code, collector number, name) it asks a public card
 * database for the exact card and returns candidates with a confidence and the evidence behind it. It
 * also validates a reference image and turns it into a "printed white" mask.
 *
 * What it does NOT do: it never decides a grade and never copies anything from a reference card's
 * condition. A reference image is only support evidence (what the card is supposed to look like);
 * it can be a scan of a card with its own defects, and the alignment used here is approximate.
 *
 * Sources (verified 2026-09-29, see docs/identification.md):
 *   pokemon   -> TCGdex        https://api.tcgdex.net/v2/{lang}/...        (no key, CORS *, images CORS *)
 *   riftbound -> Riftcodex     https://api.riftcodex.com/...               (no key, CORS *, images NOT CORS-readable)
 * The Pokemon TCG API (api.pokemontcg.io) is deprecated and intermittently returns 5xx, so it is not used.
 *
 * Works in browsers and in Node (tests inject `fetch`). DOM use is behind feature checks.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Identify = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CARD_W = 750, CARD_H = 1048;   // must match Vision (63 x 88 mm at ~300 dpi)
  const MARGIN = 48;
  const CARD_ASPECT = 63 / 88;         // width / height of a standard card
  const MIN_LONG_SIDE = 500;
  const TCGDEX = "https://api.tcgdex.net/v2";
  const RIFTCODEX = "https://api.riftcodex.com";
  const RIFTBOUND_SETS = ["OGN", "OGS", "SFD", "UNL", "VEN", "PR", "JDG", "OPP"];
  const TCGDEX_LANGS = { EN: "en", FR: "fr", DE: "de", ES: "es", IT: "it", PT: "pt", NL: "nl", PL: "pl", RU: "ru", JA: "ja", JP: "ja", KO: "ko", KR: "ko", ID: "id", TH: "th" };
  const MAX_ENRICH = 12;               // number-only lookups: how many listed cards get a detail request
  const MAX_LISTED = 8;                // and how many are returned

  /* ------------------------------------------------------------- helpers */

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const r2 = (v) => Math.round(v * 100) / 100;
  const norm = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  /** "125/197" -> {left:"125", right:"197", leftInt:125, rightInt:197}; "SP3/006" -> {left:"SP3", right:"006", leftInt:null,...}. */
  function parseNumber(raw) {
    const s = String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s+/g, "");
    if (!s) return { raw: "", left: "", right: "", leftInt: null, rightInt: null };
    const [left, right = ""] = s.split("/");
    const int = (t) => (/^\d+$/.test(t) ? parseInt(t, 10) : null);
    return { raw: s, left, right, leftInt: int(left), rightInt: int(right) };
  }

  /** Same collector number? "25" == "025"; "SP3" == "sp3"; "066a" != "066". */
  function sameLocal(a, b) {
    const x = String(a).toUpperCase(), y = String(b).toUpperCase();
    if (x === y) return true;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return parseInt(x, 10) === parseInt(y, 10);
    return false;
  }

  function gameOf(q) {
    const g = norm(q.game);
    if (g.startsWith("pok")) return "pokemon";
    if (g.startsWith("rift")) return "riftbound";
    const code = String(q.set_code || "").toUpperCase();
    return RIFTBOUND_SETS.includes(code) || /^SP\d/i.test(String(q.number || "")) ? "riftbound" : "pokemon";
  }

  /** Never throws. -> {ok, status, json, error}; error is set on a network failure or bad JSON. */
  async function getJSON(F, url, timeoutMs) {
    let timer = null, opts;
    if (typeof AbortController === "function") {
      const ac = new AbortController();
      timer = setTimeout(() => ac.abort(), timeoutMs || 12000);
      opts = { signal: ac.signal, headers: { Accept: "application/json" } };
    }
    try {
      const res = await F(url, opts);
      let json = null;
      try { json = await res.json(); } catch (e) { /* not JSON (e.g. a 500 page) */ }
      return { ok: !!res.ok, status: res.status, json };
    } catch (e) {
      return { ok: false, status: 0, json: null, error: String((e && e.message) || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function finish(candidates, notes, extra) {
    candidates.forEach((c) => { c.confidence = r2(c.confidence); });
    candidates.sort((a, b) => b.confidence - a.confidence);
    const top = candidates[0], second = candidates[1];
    const decisive = !!top && top.confidence >= 0.9 && (!second || second.confidence <= top.confidence - 0.3);
    const out = { candidates, needs_confirmation: candidates.length > 0 && !decisive };
    if (extra) Object.assign(out, extra);
    if (!candidates.length && !out.error) out.error = notes.error || "No matching card found.";
    return out;
  }

  const emptyCard = () => ({ name: "", set_name: "", set_code: "", number: "", rarity: "", variant: "", year: null, language: "", image_url: "", thumb_url: "", image_readable: false, source_url: "", source: "", source_id: "", confidence: 0, evidence: [] });

  /** Confidence from how many typed fields agree with a database record. */
  function score(base, q, rec, ev) {
    let c = base;
    if (q.name && rec.name) {
      const a = norm(q.name), b = norm(rec.name);
      if (a && (a === b || b.includes(a) || a.includes(b))) { c += base >= 0.85 ? 0.05 : 0.2; ev.push(`name "${q.name}" matches "${rec.name}"`); }
      else { c -= 0.4; ev.push(`name differs: you typed "${q.name}", the database has "${rec.name}"`); }
    }
    if (rec.total != null) {
      const n = parseNumber(q.number);
      if (n.rightInt != null) {
        if (n.rightInt === rec.total) { c += base >= 0.85 ? 0.05 : 0.2; ev.push(`printed total /${rec.total} matches`); }
        else { c -= 0.15; ev.push(`printed total differs: you typed /${n.right}, this set has /${rec.total}`); }
      }
    }
    return clamp01(c);
  }

  /* ------------------------------------------------------------- TCGdex (Pokemon) */

  function tcgdexCandidate(card, set, lang, L) {
    const c = emptyCard();
    const s = set || card.set || {};
    c.name = card.name || "";
    c.set_name = s.name || (card.set && card.set.name) || "";
    c.set_code = (set && set.abbreviation && set.abbreviation.official) || "";
    c.number = card.localId || "";
    c.rarity = card.rarity || "";
    const v = card.variants || {};
    const kinds = [["normal", "Normal"], ["reverse", "Reverse holo"], ["holo", "Holo"], ["firstEdition", "1st edition"], ["wPromo", "W promo"]].filter(([k]) => v[k]).map(([, n]) => n);
    c.variant = kinds.join(" / ");
    c.year = set && set.releaseDate ? parseInt(String(set.releaseDate).slice(0, 4), 10) || null : null;
    c.language = L;
    if (card.image) {
      c.image_url = card.image + "/high.png";   // 600 x 825 PNG, CORS *, readable in a canvas
      c.thumb_url = card.image + "/low.webp";
      c.image_readable = true;
    }
    c.source = "tcgdex";
    c.source_id = card.id || "";
    c.source_url = `${TCGDEX}/${lang}/cards/${encodeURIComponent(card.id || "")}`;
    c._total = (card.set && card.set.cardCount && card.set.cardCount.official) ?? (set && set.cardCount && set.cardCount.official) ?? null;
    return c;
  }

  async function resolveTcgdexSets(F, code, lang, notes) {
    const raw = String(code).trim();
    const guesses = [...new Set([raw, raw.toLowerCase(), raw.toLowerCase().replace(/^(sv|me)(\d)(?=$|\.)/, "$10$2")])];
    const found = [];
    const tries = await Promise.all(guesses.map((g) => getJSON(F, `${TCGDEX}/${lang}/sets/${encodeURIComponent(g)}`)));
    tries.forEach((t) => { if (t.ok && t.json && t.json.id && !found.some((s) => s.id === t.json.id)) found.push(t.json); if (t.error) notes.net.push(t.error); });
    if (found.length) return found.map((s) => ({ set: s, via: "id" }));
    // The code printed on modern cards (OBF, PAL, ...) is TCGdex's abbreviation. The filter is a
    // substring match, so verify each hit's abbreviation exactly; skip absurdly broad matches.
    const list = await getJSON(F, `${TCGDEX}/${lang}/sets?abbreviation.official=${encodeURIComponent(raw)}`);
    if (list.error) notes.net.push(list.error);
    if (!list.ok || !Array.isArray(list.json) || list.json.length === 0 || list.json.length > 4) return [];
    const details = await Promise.all(list.json.map((s) => getJSON(F, `${TCGDEX}/${lang}/sets/${encodeURIComponent(s.id)}`)));
    return details.filter((d) => d.ok && d.json && d.json.abbreviation && String(d.json.abbreviation.official).toUpperCase() === raw.toUpperCase()).map((d) => ({ set: d.json, via: "abbreviation" }));
  }

  async function pokemon(q, F) {
    const notes = { net: [] };
    const L = String(q.language || "EN").toUpperCase();
    const lang = TCGDEX_LANGS[L] || "en";
    const langNote = TCGDEX_LANGS[L] ? null : `language ${L} is not in TCGdex; searched English`;
    const num = parseNumber(q.number);
    const out = [];

    // 1) set code + number: the exact card.
    if (q.set_code && num.left) {
      const sets = await resolveTcgdexSets(F, q.set_code, lang, notes);
      for (const { set, via } of sets) {
        const locals = [...new Set([num.left, /^\d+$/.test(num.left) ? num.left.padStart(3, "0") : null, num.leftInt != null ? String(num.leftInt) : null].filter(Boolean))];
        let card = null;
        for (const local of locals) {
          const r = await getJSON(F, `${TCGDEX}/${lang}/sets/${encodeURIComponent(set.id)}/${encodeURIComponent(local)}`);
          if (r.error) notes.net.push(r.error);
          if (r.ok && r.json && r.json.id) { card = r.json; break; }
        }
        if (!card) continue;
        const c = tcgdexCandidate(card, set, lang, L);
        const ev = [`set code ${q.set_code} ${via === "id" ? "is TCGdex set id " + set.id : "is the printed abbreviation of " + set.name}`, `number ${card.localId} exists in ${set.name}`];
        c.confidence = score(0.9, q, { name: c.name, total: c._total }, ev);
        if (langNote) ev.push(langNote);
        c.evidence = ev;
        out.push(c);
      }
      if (out.length) return finish(strip(out), notes);
    }

    // 2) number and/or name without a usable set: list, then confirm by eye.
    if (!num.left && !q.name) return finish([], notes, { error: notes.net.length ? "Could not reach the card database: " + notes.net[0] : "Enter a set code and number, or a card name, to look the card up." });
    const params = [];
    if (q.name) params.push("name=" + encodeURIComponent(q.name));
    if (num.left) params.push("localId=" + encodeURIComponent(num.left));
    const list = await getJSON(F, `${TCGDEX}/${lang}/cards?${params.join("&")}`);
    if (list.error) notes.net.push(list.error);
    if (!list.ok || !Array.isArray(list.json)) {
      return finish([], notes, { error: notes.net.length ? "Could not reach the card database: " + notes.net[0] : `Card database returned HTTP ${list.status}.` });
    }
    let hits = list.json;
    if (num.left) hits = hits.filter((h) => sameLocal(h.localId, num.left));   // the localId filter is a substring match
    const totalHits = hits.length;
    // The printed total (the "/197" in 125/197) is a strong clue: sets whose official card count equals it
    // are looked at first, and their names come from the one set list request.
    const setIndex = new Map();
    if (num.rightInt != null && hits.length > 1) {
      const all = await getJSON(F, `${TCGDEX}/${lang}/sets`);
      if (all.error) notes.net.push(all.error);
      if (all.ok && Array.isArray(all.json)) all.json.forEach((st) => setIndex.set(st.id, st));
    }
    const setIdOf = (h) => String(h.id).slice(0, String(h.id).length - String(h.localId).length - 1);
    const totalOf = (h) => { const st = setIndex.get(setIdOf(h)); return st && st.cardCount ? st.cardCount.official : null; };
    if (setIndex.size) hits = hits.filter((h) => totalOf(h) === num.rightInt).concat(hits.filter((h) => totalOf(h) !== num.rightInt));
    hits = hits.slice(0, MAX_ENRICH);
    const details = await Promise.all(hits.map((h) => getJSON(F, `${TCGDEX}/${lang}/cards/${encodeURIComponent(h.id)}`)));
    hits.forEach((h, i) => {
      const detail = details[i].ok && details[i].json && details[i].json.id ? details[i].json : null;
      const st = setIndex.get(setIdOf(h));
      const card = detail || (st ? Object.assign({}, h, { set: { id: st.id, name: st.name, cardCount: st.cardCount } }) : h);
      const c = tcgdexCandidate(card, null, lang, L);
      const setNote = card.set ? [] : [`set details unavailable (card id ${h.id})`];
      c.source_id = c.source_id || h.id;
      const ev = [num.left ? `number ${c.number} matches; set ${q.set_code ? q.set_code + " not confirmed" : "not given"}` : "matched on name only"];
      const base = num.left ? (q.name ? 0.4 : 0.3) : 0.3;
      c.confidence = score(base, q, { name: c.name, total: c._total }, ev);
      if (langNote) ev.push(langNote);
      c.evidence = ev.concat(setNote);
      out.push(c);
    });
    const cands = strip(out).sort((a, b) => b.confidence - a.confidence).slice(0, MAX_LISTED);
    const res = finish(cands, notes, { total_matches: totalHits });
    if (!cands.length && !res.error) res.error = "No card matched.";
    if (!cands.length) res.error = notes.net.length ? "Could not reach the card database: " + notes.net[0] : `No Pokemon card found for ${[q.set_code, q.number, q.name].filter(Boolean).join(" ")}.`;
    return res;
  }

  function strip(list) { list.forEach((c) => { delete c._total; }); return list; }

  /* ------------------------------------------------------------- Riftcodex (Riftbound) */

  const rbVariant = (m) => (m && (m.signature ? "Signature" : m.alternate_art ? "Alternate Art" : m.overnumbered ? "Overnumbered" : "")) || "Standard";

  /** riftbound_id "ven-sp3-006" -> {set:"ven", num:"sp3", total:"006"}; "ogn-066a-298" -> num "066a". */
  function rbParts(id) {
    const p = String(id || "").toLowerCase().split("-");
    return { set: p[0] || "", num: p[1] || "", total: p[2] || "" };
  }

  function riftCandidate(card, setInfo) {
    const c = emptyCard();
    const cls = card.classification || {}, media = card.media || {}, set = card.set || {};
    const p = rbParts(card.riftbound_id);
    c.name = card.name || "";
    c.set_name = set.label || (setInfo && setInfo.name) || "";
    c.set_code = String(set.set_id || p.set).toUpperCase();
    c.number = p.total && /^(sp|\d)/.test(p.num) ? `${p.num.toUpperCase()}/${p.total.toUpperCase()}` : p.num.toUpperCase();
    c.rarity = cls.rarity || "";
    c.variant = rbVariant(card.metadata);
    c.year = setInfo && setInfo.published_on ? parseInt(String(setInfo.published_on).slice(0, 4), 10) || null : null;
    c.language = "EN";                         // the source lists English cards only
    c.image_url = media.image_url || "";       // 744 x 1039 PNG. No CORS header: shown in <img>, NOT readable in a canvas.
    c.thumb_url = c.image_url;
    c.image_readable = false;
    c.source = "riftcodex";
    c.source_id = card.riftbound_id || "";
    c.source_url = `${RIFTCODEX}/cards/riftbound/${encodeURIComponent(card.riftbound_id || "")}`;
    return c;
  }

  function dedupeRift(items) {
    const byId = new Map();
    for (const c of items) {
      const prev = byId.get(c.riftbound_id);
      if (!prev || (!prev.tcgplayer_id && c.tcgplayer_id)) byId.set(c.riftbound_id, c);   // the source lists some cards twice
    }
    return [...byId.values()];
  }

  async function riftSetInfo(F, setCode) {
    if (!setCode) return null;
    const r = await getJSON(F, `${RIFTCODEX}/sets/set-id/${encodeURIComponent(setCode)}`);
    return r.ok && r.json && r.json.set_id ? r.json : null;
  }

  async function riftScanSet(F, setCode, notes) {
    const url = (page) => `${RIFTCODEX}/cards?set_id=${encodeURIComponent(setCode)}&size=100&page=${page}`;
    const first = await getJSON(F, url(1));
    if (first.error) notes.net.push(first.error);
    if (!first.ok || !first.json || !Array.isArray(first.json.items)) return [];
    let items = first.json.items.slice();
    const pages = Math.min(first.json.pages || 1, 8);
    if (pages > 1) {
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => getJSON(F, url(i + 2))));
      rest.forEach((r) => { if (r.ok && r.json && Array.isArray(r.json.items)) items = items.concat(r.json.items); });
    }
    return items;
  }

  const rbNumMatches = (card, num) => {
    const p = rbParts(card.riftbound_id);
    const stripped = p.num.replace(/[a-z*]+$/, "");
    if (num.leftInt != null) return /^\d+$/.test(stripped) && parseInt(stripped, 10) === num.leftInt;
    return p.num === num.left.toLowerCase();
  };

  async function riftbound(q, F) {
    const notes = { net: [] };
    const num = parseNumber(q.number);
    const set = String(q.set_code || "").trim().toUpperCase();
    const L = String(q.language || "EN").toUpperCase();
    const langEv = L && L !== "EN" ? [`source lists English cards only; you entered ${L}`] : [];
    const out = [];
    const setInfoP = set ? riftSetInfo(F, set) : Promise.resolve(null);

    if (set && num.left) {
      // 1) The source's id is "<set>-<printed number, slash -> dash>", e.g. VEN + SP3/006 -> ven-sp3-006.
      const id = `${set}-${num.left}${num.right ? "-" + num.right : ""}`.toLowerCase();
      const r = await getJSON(F, `${RIFTCODEX}/cards/riftbound/${encodeURIComponent(id)}`);
      if (r.error) notes.net.push(r.error);
      const exact = r.ok && Array.isArray(r.json) ? dedupeRift(r.json.filter((c) => String(c.riftbound_id).toLowerCase() === id)) : [];
      if (exact.length) {
        const si = await setInfoP;
        for (const card of exact) {
          const c = riftCandidate(card, si);
          const ev = [`set ${set} and printed number ${num.raw} match id ${card.riftbound_id}`].concat(langEv);
          c.confidence = score(0.95, q, { name: c.name }, ev);
          c.evidence = ev;
          out.push(c);
        }
        return finish(out, notes);
      }
      // 2) Fall back to scanning the set for that number: alt-art / signature / overnumbered variants may share it.
      const items = dedupeRift(await riftScanSet(F, set, notes));
      const si = await setInfoP;
      const hits = items.filter((c) => rbNumMatches(c, num));
      for (const card of hits) {
        const c = riftCandidate(card, si);
        const ev = [`number ${num.left} exists in set ${set}` + (hits.length > 1 ? `; ${hits.length} variants share it, compare the artwork` : "")].concat(langEv);
        c.confidence = score(hits.length === 1 ? 0.9 : 0.6, q, { name: c.name }, ev);
        c.evidence = ev;
        out.push(c);
      }
      if (out.length) return finish(out, notes);
      return finish([], notes, { error: notes.net.length ? "Could not reach the card database: " + notes.net[0] : `Riftcodex has no card ${num.raw} in set ${set}. Check the set code and number, or use a manual reference image.` });
    }

    if (q.name) {
      const r = await getJSON(F, `${RIFTCODEX}/cards/name?fuzzy=${encodeURIComponent(q.name)}&size=50${set ? "&set_id=" + encodeURIComponent(set) : ""}`);
      if (r.error) notes.net.push(r.error);
      let items = r.ok && r.json && Array.isArray(r.json.items) ? dedupeRift(r.json.items) : [];
      if (num.left) items = items.filter((c) => rbNumMatches(c, num));
      const shown = items.slice(0, MAX_LISTED);
      const infos = {};
      await Promise.all([...new Set(shown.map((c) => c.set && c.set.set_id))].filter(Boolean).map(async (s) => { infos[s] = await riftSetInfo(F, s); }));
      for (const card of shown) {
        const c = riftCandidate(card, infos[card.set && card.set.set_id]);
        const ev = [num.left ? `name search plus number ${num.left}` : "name search only; set and number not given"].concat(langEv);
        c.confidence = score(num.left ? 0.65 : 0.3, q, { name: c.name }, ev);
        c.evidence = ev;
        out.push(c);
      }
      const res = finish(out, notes, { total_matches: items.length });
      if (!out.length) res.error = notes.net.length ? "Could not reach the card database: " + notes.net[0] : `Riftcodex found no card named "${q.name}"${num.left ? " with number " + num.left : ""}.`;
      return res;
    }

    return finish([], notes, { error: notes.net.length ? "Could not reach the card database: " + notes.net[0] : "Riftbound lookup needs a set code and number (from the bottom-left line, e.g. VEN SP3/006), or a card name. Use a manual reference image instead." });
  }

  /* ------------------------------------------------------------- public: candidates */

  /**
   * @param {{game?:string,set_code?:string,number?:string,name?:string,language?:string}} q
   * @param {{fetch?:Function}} [opts]  fetch(url, init) -> Promise<{ok,status,json()}>
   * @returns {Promise<{candidates:Array, needs_confirmation:boolean, error?:string, total_matches?:number}>}
   */
  async function candidates(q, opts) {
    q = q || {};
    const F = (opts && opts.fetch) || (typeof fetch === "function" ? fetch.bind(typeof globalThis !== "undefined" ? globalThis : undefined) : null);
    if (!F) return { candidates: [], needs_confirmation: false, error: "No fetch available; use a manual reference image." };
    const game = gameOf(q);
    try {
      return game === "riftbound" ? await riftbound(q, F) : await pokemon(q, F);
    } catch (e) {
      return { candidates: [], needs_confirmation: false, error: "Lookup failed: " + String((e && e.message) || e) };
    }
  }

  /* ------------------------------------------------------------- manual reference */

  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  /**
   * Validate a user-supplied reference: an https image URL or an image file/blob.
   * -> {ok:true, image_url|image, source:"user", warnings:[...]}  or  {ok:false, error}
   */
  function manualReference(ref) {
    ref = ref || {};
    if (ref.file) {
      const f = ref.file;
      const type = String(f.type || "").toLowerCase();
      const size = Number(f.size);
      if (!IMAGE_TYPES.includes(type)) return { ok: false, error: `Reference must be a PNG, JPEG or WebP image (got ${type || "unknown type"}).` };
      if (!(size > 0)) return { ok: false, error: "Reference file is empty." };
      if (size > MAX_FILE_BYTES) return { ok: false, error: "Reference file is larger than 25 MB." };
      return { ok: true, image: f, source: "user", name: f.name || "", type, size, warnings: [] };
    }
    if (ref.url) {
      const raw = String(ref.url).trim();
      if (/^data:image\/(png|jpeg|webp);base64,/i.test(raw)) {
        if (raw.length > MAX_FILE_BYTES * 1.4) return { ok: false, error: "Reference image is larger than 25 MB." };
        return { ok: true, image_url: raw, source: "user", warnings: [] };
      }
      let u;
      try { u = new URL(raw); } catch (e) { return { ok: false, error: "That is not a valid web address." }; }
      if (u.protocol !== "https:") return { ok: false, error: "Reference address must start with https://." };
      if (u.username || u.password) return { ok: false, error: "Reference address must not contain a login." };
      const warnings = [];
      if (!/\.(png|jpe?g|webp)(\?|#|$)/i.test(u.pathname + u.search)) warnings.push("Address does not end in .png/.jpg/.webp; it must point straight at the image, not a web page.");
      warnings.push("Many sites block other pages from reading their images. If the check fails, save the image and add it as a file instead.");
      return { ok: true, image_url: u.href, source: "user", warnings };
    }
    return { ok: false, error: "Give a reference image URL or file." };
  }

  /**
   * Browser only: load a manualReference()/candidate result into {width,height,data} RGBA (long side <= maxSide).
   * Rejects with a plain-language Error when the image cannot be read (cross-origin without CORS, decode failure).
   */
  async function loadReferenceRGBA(ref, maxSide = 1600) {
    if (typeof document === "undefined") throw new Error("loadReferenceRGBA needs a browser.");
    let source, revoke = null;
    if (ref.image) {
      if (typeof createImageBitmap === "function") source = await createImageBitmap(ref.image);
      else {
        revoke = URL.createObjectURL(ref.image);
        source = await loadImgElement(revoke, false);
      }
    } else if (ref.image_url) {
      source = await loadImgElement(ref.image_url, !/^data:/i.test(ref.image_url));
    } else throw new Error("No reference image.");
    try {
      const w0 = source.width || source.naturalWidth, h0 = source.height || source.naturalHeight;
      const k = Math.min(1, maxSide / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(source, 0, 0, w, h);
      try {
        const d = ctx.getImageData(0, 0, w, h);
        return { width: w, height: h, data: d.data };
      } catch (e) {
        throw new Error("The browser will not let this page read that image's pixels (the site does not allow it). Save the image and add it as a file instead.");
      }
    } finally {
      if (revoke) URL.revokeObjectURL(revoke);
    }
  }

  function loadImgElement(src, cors) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (cors) img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(cors ? "The image could not be loaded (or the site does not allow this page to read it). Save the image and add it as a file instead." : "The image could not be decoded."));
      img.src = src;
    });
  }

  /* ------------------------------------------------------------- reference checks */

  function validRGBA(img) {
    return img && img.width > 0 && img.height > 0 && img.data && img.data.length >= img.width * img.height * 4;
  }

  /**
   * Bounding box of the non-background content. The background is the colour of the image's outer ring
   * when that ring is uniform (a card photographed/scanned on a plain surface, or transparent PNG padding).
   * A full-bleed card image has a non-uniform ring and is not trimmed.
   */
  function trimBackground(img) {
    const { width: w, height: h, data: d } = img;
    const full = { x: 0, y: 0, w, h, trimmed: false };
    // Already card-shaped: keep it whole (a card with a white border must not be mistaken for background).
    if (Math.abs(w / h / CARD_ASPECT - 1) <= 0.04) return full;
    const ring = [];
    const push = (x, y) => { const i = (y * w + x) * 4; ring.push([d[i], d[i + 1], d[i + 2], d[i + 3]]); };
    for (let x = 0; x < w; x += Math.max(1, w >> 6)) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y += Math.max(1, h >> 6)) { push(0, y); push(w - 1, y); }
    const med = (k) => ring.map((p) => p[k]).sort((a, b) => a - b)[ring.length >> 1];
    const bg = [med(0), med(1), med(2), med(3)];
    const isBg = (i) => (bg[3] < 32 ? d[i + 3] < 32 : d[i + 3] >= 32 && Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) <= 36);
    const uniform = ring.filter((p) => (bg[3] < 32 ? p[3] < 32 : p[3] >= 32 && Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) <= 36)).length / ring.length;
    if (uniform < 0.9) return full;
    const colHits = new Int32Array(w), rowHits = new Int32Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!isBg((y * w + x) * 4)) { colHits[x]++; rowHits[y]++; }
    const minCol = Math.max(2, h * 0.01), minRow = Math.max(2, w * 0.01);
    let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
    while (x0 < x1 && colHits[x0] < minCol) x0++;
    while (x1 > x0 && colHits[x1] < minCol) x1--;
    while (y0 < y1 && rowHits[y0] < minRow) y0++;
    while (y1 > y0 && rowHits[y1] < minRow) y1--;
    if (x1 - x0 < 8 || y1 - y0 < 8) return { x: 0, y: 0, w: 0, h: 0, trimmed: true, blank: true };
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, trimmed: x0 > 0 || y0 > 0 || x1 < w - 1 || y1 < h - 1 };
  }

  /**
   * Is this image usable as a reference card face? Deliberately simple.
   * -> {usable, reasons:[...], long_side, aspect, box:{x,y,w,h}}
   */
  function checkReference(img) {
    const reasons = [];
    if (!validRGBA(img)) return { usable: false, reasons: ["No image data."], long_side: 0, aspect: 0, box: null };
    const box = trimBackground(img);
    if (box.blank) return { usable: false, reasons: ["The image is blank: only background was found."], long_side: 0, aspect: 0, box };
    const long = Math.max(box.w, box.h);
    const aspect = box.w / box.h;
    if (long < MIN_LONG_SIDE) reasons.push(`Too small: ${long} px on the long side (need about ${MIN_LONG_SIDE}+ for a useful comparison).`);
    if (aspect < 0.45 || aspect > 2.2) {
      reasons.push(`Extreme shape (${r2(aspect)} wide-to-tall): the image looks cropped or obstructed, not a whole card.`);
    } else if (Math.abs(aspect / (1 / CARD_ASPECT) - 1) <= 0.12) {
      reasons.push("Landscape image: rotate it so the card is upright before using it.");
    } else if (Math.abs(aspect / CARD_ASPECT - 1) > 0.12) {
      reasons.push(`Not card-shaped: ${r2(aspect)} wide-to-tall, a card is about ${r2(CARD_ASPECT)} (63:88)${box.trimmed ? " after trimming the plain background" : ""}.`);
    }
    // almost no detail (a solid colour, a logo on white) is not a card face
    const { width: w, data: d } = img;
    let n = 0, s = 0, s2 = 0;
    const step = Math.max(1, Math.floor(Math.sqrt((box.w * box.h) / 20000)));
    for (let y = box.y; y < box.y + box.h; y += step) for (let x = box.x; x < box.x + box.w; x += step) {
      const i = (y * w + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n++; s += l; s2 += l * l;
    }
    const sd = Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
    if (sd < 8) reasons.push("Almost no detail: this does not look like a card face.");
    return { usable: reasons.length === 0, reasons, long_side: long, aspect: r2(aspect), box: { x: box.x, y: box.y, w: box.w, h: box.h } };
  }

  /* ------------------------------------------------------------- printed-white mask */

  /** Bilinear resize of a sub-rectangle of an RGBA image to w x h (box pre-reduction when shrinking a lot). */
  function resizeRGBA(img, box, w, h) {
    let { width: sw, height: sh, data: sd } = img;
    let bx = box ? box.x : 0, by = box ? box.y : 0, bw = box ? box.w : sw, bh = box ? box.h : sh;
    const f = Math.floor(Math.min(bw / w, bh / h));
    if (f >= 2) {   // average f x f blocks first so a large reference does not alias
      const nw = Math.floor(bw / f), nh = Math.floor(bh / f);
      const nd = new Uint8ClampedArray(nw * nh * 4);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const acc = [0, 0, 0, 0];
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
          const p = ((by + y * f + j) * sw + bx + x * f + i) * 4;
          acc[0] += sd[p]; acc[1] += sd[p + 1]; acc[2] += sd[p + 2]; acc[3] += sd[p + 3];
        }
        const o = (y * nw + x) * 4, k = f * f;
        nd[o] = acc[0] / k; nd[o + 1] = acc[1] / k; nd[o + 2] = acc[2] / k; nd[o + 3] = acc[3] / k;
      }
      sd = nd; sw = nw; sh = nh; bx = 0; by = 0; bw = nw; bh = nh;
    }
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) * (bh / h) - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) * (bw / w) - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
        const a = ((by + y0) * sw + bx + x0) * 4, b = ((by + y0) * sw + bx + x1) * 4, c = ((by + y1) * sw + bx + x0) * 4, e = ((by + y1) * sw + bx + x1) * 4;
        const o = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) {
          out[o + k] = (sd[a + k] * (1 - tx) + sd[b + k] * tx) * (1 - ty) + (sd[c + k] * (1 - tx) + sd[e + k] * tx) * ty;
        }
      }
    }
    return { width: w, height: h, data: out };
  }

  // Whitening lives within a few mm of the edge (a card is ~750 px wide, so 60 px is ~5 mm); deeper than that is not inspected.
  const defaultBand = (cw) => Math.round(cw * 0.08);

  /** Square dilation by radius r on a 0/1 mask (two separable passes). */
  function dilate(mask, w, h, r) {
    if (r <= 0) return mask;
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let last = -1e9;
      const row = y * w;
      // forward: distance since the last set pixel; a pixel is set if a set pixel lies within r on either side
      for (let x = 0; x < w; x++) { if (mask[row + x]) last = x; if (x - last <= r) tmp[row + x] = 1; }
      last = 1e9;
      for (let x = w - 1; x >= 0; x--) { if (mask[row + x]) last = x; if (last - x <= r) tmp[row + x] = 1; }
    }
    for (let x = 0; x < w; x++) {
      let last = -1e9;
      for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
      last = 1e9;
      for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
    }
    return out;
  }

  /**
   * Where does the reference card show printed white / very light ink? 1 = yes, at that pixel of `warped`.
   *
   * The reference is trimmed of any plain background, resized to the card box (CARD_W x CARD_H inside a
   * `margin` px border, exactly as Vision.scan's warped image is laid out), thresholded for light,
   * low-chroma pixels within `band` px (default 8% of the card width, ~60 px) of the card's edges, then dilated a few px.
   *
   * This is SUPPORT EVIDENCE, not ground truth: alignment is approximate (it assumes the reference is a
   * full flat card face and the scan is upright), and the reference card may have its own defects, so a
   * whitening detector should use the mask to discount printed white, not to declare anything clean.
   *
   * @param {{width,height,data}} referenceRGBA
   * @param {{width,height,data}} warpedRGBA   Vision.scan(...).warped
   * @param {number} [margin=48]
   * @param {{band?:number, dilate?:number, minLuma?:number, maxChroma?:number, trim?:boolean}} [opts]
   * @returns {Uint8Array} length warped.width * warped.height
   */
  function printedMask(referenceRGBA, warpedRGBA, margin = MARGIN, opts = {}) {
    if (!validRGBA(referenceRGBA)) throw new Error("printedMask: reference image is missing or malformed.");
    if (!validRGBA(warpedRGBA)) throw new Error("printedMask: warped image is missing or malformed.");
    const W = warpedRGBA.width, H = warpedRGBA.height;
    const cw = W - 2 * margin, ch = H - 2 * margin;
    if (cw < 8 || ch < 8) throw new Error("printedMask: margin is larger than the warped image.");
    const band = opts.band != null ? opts.band : defaultBand(cw);
    const minLuma = opts.minLuma != null ? opts.minLuma : 205;
    const maxChroma = opts.maxChroma != null ? opts.maxChroma : 36;
    const box = opts.trim === false ? null : trimBackground(referenceRGBA);
    if (box && box.blank) return new Uint8Array(W * H);
    const ref = resizeRGBA(referenceRGBA, box && box.trimmed ? box : null, cw, ch);
    const rd = ref.data;
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < ch; y++) {
      const dy = Math.min(y, ch - 1 - y);
      for (let x = 0; x < cw; x++) {
        if (Math.min(dy, x, cw - 1 - x) >= band) continue;
        const i = (y * cw + x) * 4;
        if (rd[i + 3] < 128) continue;
        const r = rd[i], g = rd[i + 1], b = rd[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (0.299 * r + 0.587 * g + 0.114 * b >= minLuma && mx - mn <= maxChroma) mask[(y + margin) * W + x + margin] = 1;
      }
    }
    return dilate(mask, W, H, opts.dilate != null ? opts.dilate : 3);
  }

  /**
   * Share (0..1) of the card's edge band that the mask marks as printed white. If this is high (a white
   * card border), a whitening detector cannot tell wear from print there and should say "not assessable".
   */
  function maskCoverage(mask, width, height, margin = MARGIN, band) {
    const cw = width - 2 * margin, ch = height - 2 * margin;
    band = band != null ? band : defaultBand(cw);
    let inBand = 0, marked = 0;
    for (let y = 0; y < ch; y++) {
      const dy = Math.min(y, ch - 1 - y);
      for (let x = 0; x < cw; x++) {
        if (Math.min(dy, x, cw - 1 - x) >= band) continue;
        inBand++;
        if (mask[(y + margin) * width + x + margin]) marked++;
      }
    }
    return inBand ? marked / inBand : 0;
  }

  return { candidates, manualReference, loadReferenceRGBA, checkReference, printedMask, maskCoverage, parseNumber, CARD_W, CARD_H, MARGIN };
});
