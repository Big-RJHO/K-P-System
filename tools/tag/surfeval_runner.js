/*
 * Node runner for surfeval.py: for each card side, what the app does before showing surface-mark candidates.
 *
 *   Vision.scan(img, "auto", null, {scale})  ->  Inspect.quality(img, scan)  ->  Inspect.edgesAndCorners(scan, {quality, face})
 *   ->  Surface.findMarks(scan, {quality, check, side, revision: 1})   (every other option at the module's default)
 *
 * stdin:  {"vision": PATH, "inspect": PATH, "surface": PATH,
 *          "jobs": [{"side": "front", "path": RAW_RGBA, "width": W, "height": H, "scale": S}, ...]}
 * stdout: [{side, status, note, candidates: [{x, y, w, h, kind, score, detection, method, ...}], cannotAssess,
 *           stats, quality: {verdict, blocked, blocked_reasons}, scan: {width, height, margin}, timing_ms}, ...]
 * A side that throws gives {side, status: "error", error}. Pixels are read from the raw RGBA files; nothing is
 * written. Used only for offline measurement; the app itself never loads this file.
 */
"use strict";
const fs = require("fs");

const cfg = JSON.parse(fs.readFileSync(0, "utf8"));
const Vision = require(cfg.vision), Inspect = require(cfg.inspect), Surface = require(cfg.surface);
const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;
const CAND_KEYS = ["x", "y", "w", "h", "kind", "score", "detection", "method", "contrast", "lengthMm", "sizeMm", "suggestedTypes"];

const out = cfg.jobs.map((j) => {
  try {
    const img = { width: j.width, height: j.height, data: new Uint8ClampedArray(fs.readFileSync(j.path)) };
    const timing = {};
    let t = process.hrtime.bigint();
    const t0 = t;
    // as scanworker.js: no options object at scale 1 (the app's main-thread path passes none either)
    const scan = j.scale && j.scale !== 1 ? Vision.scan(img, "auto", null, { scale: j.scale }) : Vision.scan(img, "auto", null);
    timing.scan = ms(t); t = process.hrtime.bigint();
    const quality = Inspect.quality(img, scan);
    timing.quality = ms(t); t = process.hrtime.bigint();
    const check = Inspect.edgesAndCorners(scan, { quality, face: j.side });
    timing.check = ms(t); t = process.hrtime.bigint();
    const res = Surface.findMarks(scan, { quality, check, side: j.side, revision: 1 });
    timing.findMarks = ms(t);
    timing.total = ms(t0);
    const pick = (c) => Object.fromEntries(CAND_KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
    return {
      side: j.side, status: res.status, note: res.note, recoverable: !!res.recoverable,
      candidates: (res.candidates || []).map(pick),
      cannotAssess: res.cannotAssess || [],
      stats: res.stats,
      quality: { verdict: quality.verdict, blocked: quality.blocked, blocked_reasons: quality.blocked_reasons },
      scan: { width: scan.width, height: scan.height, margin: scan.margin, mode: scan.mode },
      input: { width: j.width, height: j.height, scale: j.scale || 1 },
      timing_ms: timing,
    };
  } catch (err) {
    return { side: j.side, status: "error", error: String((err && err.stack) || err).slice(0, 2000) };
  }
});
process.stdout.write(JSON.stringify(out));
