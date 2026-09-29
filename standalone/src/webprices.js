/*
 * Web price search: asks Gemini, with Grounding with Google Search, what a card has recently sold for,
 * ungraded and at the grades this report gives. Uses the user's own Gemini API key.
 *
 * What this does: sends one prompt (card name, set, number, version, and the grades wanted) to the Gemini
 * API with the google_search tool, then reads the prices the model reports together with the search
 * results Google used. Each price must name its source site; a price whose site isn't among Google's
 * results for this request is flagged, and PriceCharting prices are dropped (its terms don't allow its
 * data in apps without permission).
 *
 * What it does NOT do: it never fetches or scrapes the source pages itself, and it never stores results.
 * Google's terms for Grounding with Google Search require showing the results with Google's search
 * suggestions to the person who asked, and don't allow caching them, so results live only on screen.
 * An AI summary of web prices can be wrong: the app says so and shows the sources to check.
 *
 * Access (checked 2026-09-29, see docs/pricing.md): POST
 * https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent, key in the
 * x-goog-api-key header (CORS allowed from the app's origin). Search grounding on Gemini 3.x needs billing
 * on the key (5,000 searches/month free, then $14 per 1,000); gemini-2.5-flash (free search) is refused to
 * new users.
 *
 * Works in browsers and in Node (tests inject `fetch`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WebPrices = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
  // Google search needs billing on the key for the 3.x models (tested 2026-09-29 with a new free key: plain
  // requests work, search answers 429 "check your plan and billing"); 2.5 is refused to new users (404).
  const MODELS = [
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (needs billing on your key: 5,000 searches a month free, then $14 per 1,000)" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (older accounts only: free search, up to 500 a day)" },
  ];
  const BLOCKED_SOURCES = ["pricecharting.com"];   // its terms don't allow its prices in apps without permission
  const MAX_PRICE = 10000000;

  const domainOf = (s) => {
    const t = String(s || "").trim().toLowerCase();
    try { return new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, ""); } catch (err) { return t.replace(/^www\./, ""); }
  };
  const sameSite = (a, b) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));

  /**
   * Grades to ask about, from a Grading.gradeAll report: ungraded, each company at its reported grade
   * (the ceiling when incomplete), and PSA 10 / PSA 9 as reference points.
   */
  function wantedGrades(report) {
    const out = ["Ungraded"];
    const add = (g) => { if (!out.includes(g)) out.push(g); };
    for (const g of Object.values((report && report.grades) || {})) {
      if (!g || g.tier >= 99 || !(g.grade >= 1)) continue;
      const label = String(g.label || "");
      if (g.company === "BGS" && /black label/i.test(label)) add("BGS 10 Black Label");
      else if ((g.company === "CGC" || g.company === "TAG") && g.grade >= 10 && /pristine/i.test(label)) add(`${g.company} Pristine 10`);
      else add(`${g.company} ${Number.isInteger(g.grade) ? g.grade : g.grade.toFixed(1)}`);
    }
    add("PSA 10");
    add("PSA 9");
    return out;
  }

  /** The prompt. Plain text in, one JSON object out (grounded answers can't use a response schema on 2.5). */
  function buildPrompt(card, grades) {
    const game = card.game === "riftbound" ? "Riftbound (Riot Games trading card game)" : "Pokémon TCG";
    const ident = [
      `Game: ${game}`,
      `Card: ${card.name || "?"}`,
      card.set_name && `Set: ${card.set_name}`,
      card.set_code && `Set code: ${card.set_code}`,
      card.number && `Collector number: ${card.number}`,
      card.finish && `Finish: ${card.finish}`,
      card.variant && `Version: ${card.variant}`,
      card.language && `Language: ${card.language}`,
    ].filter(Boolean).join("\n");
    return `Find what this exact trading card has recently sold for, in US dollars.

${ident}

Grades wanted: ${grades.join(", ")}.

Rules:
- Search the web. Prefer completed sales (eBay sold listings, auction results, TCGplayer or Cardmarket market data) from the last 12 months.
- Do not use pricecharting.com.
- Match the exact card: same set and number. 1st Edition, Shadowless, reverse holo, promo and other versions are different cards; say which version a price is for.
- Only report a price you found on a page in your search results. Do not estimate or invent prices. Leave out a grade if you found nothing for it.
- "source" is the website's domain, like "ebay.com". "date" is the sale or data date as YYYY-MM-DD, or YYYY-MM if that's all you know.

Reply with only this JSON, no other text:
{"card_found": "<name, set and number as the sources describe it>", "prices": [{"grade": "<one of the grades wanted>", "price_usd": <number>, "kind": "sold" | "listing" | "market", "date": "<date>", "source": "<domain>", "version": "<version, if not the normal one>"}], "notes": "<one short sentence on how reliable these are>"}`;
  }

  /** Pull the first JSON object out of the model's text (it may add a code fence). */
  function extractJSON(text) {
    const t = String(text || "");
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : t;
    const start = body.indexOf("{");
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch (err) { return null; }
      }
    }
    return null;
  }

  /**
   * Read a generateContent response.
   * -> {text, data, sources:[{title, uri, site}], queries, suggestionsHtml, grounded}
   */
  function readResponse(body) {
    const cand = (body && body.candidates && body.candidates[0]) || {};
    const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
    const gm = cand.groundingMetadata || {};
    const sources = (gm.groundingChunks || []).map((c) => c.web || {}).filter((w) => w.uri)
      .map((w) => ({ title: String(w.title || ""), uri: String(w.uri), site: domainOf(w.title || w.uri) }));
    return {
      text,
      data: extractJSON(text),
      sources,
      queries: (gm.webSearchQueries || []).map(String),
      suggestionsHtml: (gm.searchEntryPoint && gm.searchEntryPoint.renderedContent) || "",
      grounded: sources.length > 0,
      finishReason: cand.finishReason || "",
    };
  }

  /**
   * Keep only usable prices: a number in range, a grade we asked for, a source site. Flag each by whether
   * its site is among the search results Google returned for this request; drop blocked sites.
   */
  function checkPrices(data, sources, grades) {
    const kept = [], dropped = [];
    const wanted = new Map(grades.map((g) => [g.toLowerCase().replace(/\s+/g, " "), g]));
    for (const p of (data && Array.isArray(data.prices) ? data.prices : [])) {
      const price = typeof p.price_usd === "string" ? Number(p.price_usd.replace(/[$,\s]/g, "")) : Number(p.price_usd);
      const grade = wanted.get(String(p.grade || "").toLowerCase().replace(/\s+/g, " "));
      const site = domainOf(p.source);
      if (!(price > 0 && price < MAX_PRICE) || !grade || !site) { dropped.push({ ...p, why: "incomplete" }); continue; }
      if (BLOCKED_SOURCES.some((b) => sameSite(site, b))) { dropped.push({ ...p, why: "blocked source" }); continue; }
      kept.push({
        grade, price_usd: Math.round(price * 100) / 100, kind: ["sold", "listing", "market"].includes(p.kind) ? p.kind : "",
        date: /^\d{4}-\d{2}(-\d{2})?$/.test(String(p.date || "")) ? String(p.date) : "",
        source: site, version: String(p.version || "").slice(0, 80),
        in_results: sources.some((s) => sameSite(s.site, site)),
      });
    }
    kept.sort((a, b) => grades.indexOf(a.grade) - grades.indexOf(b.grade) || (b.in_results - a.in_results));
    return { prices: kept, dropped };
  }

  function friendlyError(status, body) {
    const msg = String((body && body.error && body.error.message) || "");
    if (status === 400 && /api key/i.test(msg)) return "Google didn't accept the Gemini API key. Check it in Google AI Studio.";
    if (status === 401 || status === 403) return /billing|paid|free tier/i.test(msg)
      ? "This model's web search needs billing on your Gemini key. Turn on billing in Google AI Studio, or choose Gemini 2.5 Flash."
      : "Google refused the request with this key (permission denied). Check the key's restrictions in Google AI Studio.";
    if (/new users/i.test(msg)) return "Google no longer offers this model to new keys. Choose Gemini 3.5 Flash-Lite in Web search access.";
    if (status === 404 || /not found|not available|no longer available|limit(ed|ing) access/i.test(msg)) return "This Gemini model isn't available to your key. Choose the other model in Web search access.";
    if (status === 429 && /billing|plan/i.test(msg)) return "Google's web search isn't included in the Gemini free tier for your key. Turn on billing for the key's project in Google AI Studio (5,000 searches a month are then free, then $14 per 1,000), or you've used this month's allowance.";
    if (status === 429) return "Your Gemini key has hit its rate limit. Try again in a minute.";
    if (status === 503) return "Gemini is busy right now. Try again in a minute.";
    return `Gemini answered with an error${msg ? `: ${msg.slice(0, 200)}` : ` (HTTP ${status})`}.`;
  }

  /**
   * Search for prices. `card` = {game, name, set_name, set_code, number, finish, variant, language};
   * opts = {apiKey, model, fetch, report}.
   * -> {model, grades, prices, dropped, card_found, notes, sources, queries, suggestionsHtml, grounded, text}
   */
  async function search(card, opts = {}) {
    const F = opts.fetch || (typeof fetch === "function" ? fetch : null);
    if (!opts.apiKey) throw new Error("Add your Gemini API key first (Prices → Web search).");
    if (!card || !card.name) throw new Error("Confirm which card this is first.");
    if (!F) throw new Error("No network available.");
    const model = MODELS.some((m) => m.id === opts.model) ? opts.model : MODELS[0].id;
    const grades = wantedGrades(opts.report);
    const req = {
      contents: [{ role: "user", parts: [{ text: buildPrompt(card, grades) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 },
    };
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await F(`${ENDPOINT}/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
          body: JSON.stringify(req),
        });
      } catch (err) {
        throw new Error("Gemini couldn't be reached (offline, or this page isn't allowed to contact it).");
      }
      if (res.status !== 503 || attempt) break;
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 2000));   // "high demand": one retry
    }
    let body = null;
    try { body = await res.json(); } catch (err) { body = null; }
    if (!res.ok) throw new Error(friendlyError(res.status, body));
    const r = readResponse(body);
    const checked = checkPrices(r.data, r.sources, grades);
    return {
      model, grades, ...checked,
      card_found: r.data && r.data.card_found ? String(r.data.card_found).slice(0, 200) : "",
      notes: r.data && r.data.notes ? String(r.data.notes).slice(0, 300) : "",
      sources: r.sources, queries: r.queries, suggestionsHtml: r.suggestionsHtml, grounded: r.grounded,
      parsed: !!r.data, text: r.text,
    };
  }

  /** Google's search-suggestion widget as a sandboxed page: no scripts, links open in a new tab. */
  function suggestionsDoc(html) {
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:0">${String(html || "")}</body></html>`;
  }

  // Older keys look like "AIza…" (39 characters); newer ones like "AQ.Ab8…" (with a dot).
  const validKey = (k) => /^[A-Za-z0-9_.-]{30,120}$/.test(String(k || "").trim());

  return { search, wantedGrades, buildPrompt, extractJSON, readResponse, checkPrices, suggestionsDoc, domainOf, validKey, MODELS, BLOCKED_SOURCES };
});
