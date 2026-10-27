#!/usr/bin/env node
/*
 * Read a card from its flattened front photo and look it up, the same way the phone app does:
 * Gemini reads the name and number (GeminiID), then the card databases are searched with the same
 * queries the app tries (CardOCR.queries -> Identify.candidates). Used by scripts/sample_check.py.
 *
 * stdin:  [{"id": "...", "image": "path/to/front_card.jpg", "game": "pokemon", "reading": optional}, ...]
 *         With "reading" (an earlier Gemini reading of the same photo) only the lookup is run again.
 * stdout: [{"id", "reading", "query", "candidates": [top 5], "needs_confirmation", "error"}, ...]
 *
 * The Gemini key is read from the GEMINI_API_KEY environment variable only; it is never printed or saved.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "standalone", "src");
const GeminiID = require(path.join(SRC, "geminiid.js"));
const CardOCR = require(path.join(SRC, "ocr.js"));
const Identify = require(path.join(SRC, "identify.js"));

const pick = (c) => ({ name: c.name, number: c.number, set_name: c.set_name, set_code: c.set_code, language: c.language, confidence: c.confidence, source_id: c.source_id });

async function one(job, apiKey) {
  const out = { id: job.id, reading: null, query: null, candidates: [], needs_confirmation: false, error: "" };
  if (job.reading) out.reading = job.reading;
  else if (!apiKey) { out.error = "no-key"; return out; }
  else try {
    const b64 = fs.readFileSync(job.image).toString("base64");
    out.reading = await GeminiID.identify(b64, { apiKey, fetch });
  } catch (e) {
    out.error = `read: ${(e && e.message) || e}`;
    return out;
  }
  const game = job.game || out.reading.game || "pokemon";
  for (const q of CardOCR.queries(out.reading, game)) {
    const res = await Identify.candidates(q, { fetch });
    out.query = q;
    if (res.candidates && res.candidates.length) {
      out.candidates = res.candidates.slice(0, 5).map(pick);
      out.needs_confirmation = !!res.needs_confirmation;
      out.error = "";
      break;
    }
    out.error = `lookup: ${res.error || "no match"}`;
  }
  return out;
}

(async () => {
  const jobs = JSON.parse(fs.readFileSync(0, "utf8"));
  const key = process.env.GEMINI_API_KEY || "";
  const results = [];
  for (const job of jobs) {
    results.push(await one(job, key));
    if (!job.reading) await new Promise((r) => setTimeout(r, 1500));  // stay well inside the free tier's per-minute limit
  }
  process.stdout.write(JSON.stringify(results));
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
