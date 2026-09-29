/*
 * Read the card from the front photo with Gemini (the user's own API key), instead of on-device text
 * recognition.
 *
 * What this does: sends the flattened front of the card (a JPEG, about 1000 px tall) to Gemini with a
 * fixed JSON schema and gets back the printed name, collector number, set code, set name, language and
 * version. The reading has the same shape as CardOCR.read(), so it goes through the same card lookup and
 * "This is my card" confirmation.
 *
 * What it does NOT do: it never decides which card this is and never grades. The photo leaves the phone
 * (to Google), which the app says before the first use.
 *
 * Measured 2026-09-29 on the 31 real photos of docs/blind-test.md (30 slabbed Pokemon cards, 1 raw Riftbound
 * card), gemini-3.5-flash-lite, free tier: collector number right on 31/31, name on 30/30, about 2 s each.
 * The on-device reader got 15/31 numbers on the same photos. Plain image requests work on a free key;
 * only Google Search grounding needs billing.
 *
 * Works in browsers and in Node (tests inject `fetch`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GeminiID = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
  const MODEL = "gemini-3.5-flash-lite";
  const LANGS = { english: "EN", en: "EN", japanese: "JP", ja: "JP", jp: "JP", french: "FR", fr: "FR", german: "DE", de: "DE",
    italian: "IT", it: "IT", spanish: "ES", es: "ES", portuguese: "PT", pt: "PT", korean: "KO", ko: "KO", kr: "KO",
    chinese: "ZH", zh: "ZH", cn: "ZH" };

  const SCHEMA = {
    type: "object",
    properties: {
      game: { type: "string", enum: ["pokemon", "riftbound", "other", "unknown"] },
      name: { type: "string" },
      set_name: { type: "string" },
      set_code: { type: "string" },
      number: { type: "string" },
      language: { type: "string" },
      variant: { type: "string" },
      graded_slab: { type: "boolean" },
      confidence: { type: "number" },
    },
    required: ["game", "name", "number", "confidence"],
  };

  const PROMPT = "Identify this trading card from the photo. Read the printed name, the collector number exactly as printed " +
    "(e.g. 4/102, 125/197, SP3/006, TG05/TG30, GG70/GG70), the set code if printed (e.g. OBF, VEN), the set name if you can tell, " +
    "the language, and the version (1st Edition, Shadowless, reverse holo, foil, alternate art...) only if visible. " +
    "Leave a field empty if you can't read it; don't guess numbers. confidence is 0 to 1.";

  const clean = (s, n = 80) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

  /** Gemini's JSON -> a reading like CardOCR.read()'s. */
  function toReading(g) {
    const number = clean(g.number, 20).toUpperCase().replace(/\s+/g, "");
    const code = clean(g.set_code, 8).toUpperCase();
    const name = clean(g.name);
    const words = name.split(/\s+/).filter((w) => w.replace(/[^A-Za-z]/g, "").length >= 4);
    const lang = LANGS[clean(g.language, 20).toLowerCase()] || "";
    const conf = Number(g.confidence);
    return {
      found: !!(name || number),
      source: "gemini",
      game: ["pokemon", "riftbound"].includes(g.game) ? g.game : "",
      name, name_key: words.sort((a, b) => b.length - a.length)[0] || name,
      number: /^[A-Z0-9-]{1,8}(\/[A-Z0-9-]{1,8})?$/.test(number) ? number : "",
      set_code: /^[A-Z0-9]{2,6}$/.test(code) ? code : "",
      set_name: clean(g.set_name),
      language: lang,
      variant: clean(g.variant),
      graded_slab: g.graded_slab === true,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
      alternatives: [],
      readings: [],
    };
  }

  function friendlyError(status, body) {
    const msg = String((body && body.error && body.error.message) || "");
    if (status === 400 && /api key/i.test(msg)) return "Google didn't accept the Gemini API key. Check it in Google AI Studio.";
    if (status === 401 || status === 403) return "Google refused the request with this key (permission denied).";
    if (/new users/i.test(msg) || status === 404) return "This Gemini model isn't available to your key.";
    if (status === 429) return "Your Gemini key has hit its limit for now. Try again in a minute.";
    if (status === 503) return "Gemini is busy right now. Try again in a minute.";
    return `Gemini answered with an error${msg ? `: ${msg.slice(0, 160)}` : ` (HTTP ${status})`}.`;
  }

  /**
   * Identify a card. `jpegBase64` is the photo (JPEG, base64 without the data: prefix).
   * opts = {apiKey, fetch, model, retryDelayMs}. -> reading (see toReading)
   */
  async function identify(jpegBase64, opts = {}) {
    const F = opts.fetch || (typeof fetch === "function" ? fetch : null);
    if (!opts.apiKey) throw new Error("no-key");
    if (!F) throw new Error("No network available.");
    const body = {
      contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: jpegBase64 } }, { text: PROMPT }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
    };
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await F(`${ENDPOINT}/${opts.model || MODEL}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new Error("Gemini couldn't be reached (offline, or this page isn't allowed to contact it).");
      }
      if (res.status !== 503 || attempt) break;
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 2000));
    }
    let out = null;
    try { out = await res.json(); } catch (err) { out = null; }
    if (!res.ok) throw new Error(friendlyError(res.status, out));
    const text = ((out && out.candidates && out.candidates[0] && out.candidates[0].content && out.candidates[0].content.parts) || [])
      .map((p) => p.text || "").join("");
    let g;
    try { g = JSON.parse(text); } catch (err) { throw new Error("Gemini's answer couldn't be read. Try again."); }
    return toReading(g || {});
  }

  return { identify, toReading, SCHEMA, PROMPT, MODEL };
});
