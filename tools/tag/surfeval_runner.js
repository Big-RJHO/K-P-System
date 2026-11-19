/*
 * Node runner for surfeval.py: for each card side, what the app does before showing surface-mark candidates.
 *
 *   Vision.scan(img, "auto", null, {scale})  ->  Inspect.quality(img, scan)  ->  Inspect.edgesAndCorners(scan, {quality, face})
 *   ->  Surface.findMarks(scan, {quality, check, side, revision: 1})   (every other option at the module's default)
 *
 * stdin:  {"vision": PATH, "inspect": PATH, "surface": PATH, "mode": "full" | "cache" | "marks",
 *          "jobs": [{"side": "front", "path": RAW_RGBA, "width": W, "height": H, "scale": S, "warp_out": PATH?,
 *                    "cached": {scan, quality, check, timing_ms, input}?}, ...]}
 * stdout: [{side, status, note, candidates: [{x, y, w, h, kind, score, detection, method, ...}], cannotAssess,
 *           stats, quality: {verdict, blocked, blocked_reasons}, scan: {width, height, margin}, timing_ms}, ...]
 * Modes:
 *   full   (default) as above, from the photo.
 *   cache  as full, and also writes the flattened card's raw RGBA (scan.warped) to job.warp_out and returns
 *          `cache`: {scan (everything but .warped), quality, check, timing_ms, input} for `surfeval.py cache`.
 *   marks  findMarks only: job.path is the cached warp (RGBA, width x height) and job.cached what `cache` returned;
 *          scan / quality / check are rebuilt from them, so a tuning run skips Vision.scan / Inspect.
 * Non-finite numbers (NaN in scan.lines when a border wasn't read) survive the JSON round trip as {"$num": "NaN"}.
 * A side that throws gives {side, status: "error", error}. Used only for offline measurement; the app never loads it.
 */
"use strict";
const fs = require("fs");

const cfg = JSON.parse(fs.readFileSync(0, "utf8"), revive);
const mode = cfg.mode || "full";
const Surface = require(cfg.surface);
const Vision = mode === "marks" ? null : require(cfg.vision), Inspect = mode === "marks" ? null : require(cfg.inspect);
const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;
const CAND_KEYS = ["x", "y", "w", "h", "kind", "score", "detection", "method", "contrast", "lengthMm", "sizeMm", "suggestedTypes", "channel", "reason"];

function revive(k, v) {
  return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$num === "string" ? Number(v.$num) : v;
}
function keepNonFinite(k, v) {
  if (typeof v === "number" && !Number.isFinite(v)) return { $num: String(v) };
  if (ArrayBuffer.isView(v)) return Array.from(v);
  return v;
}

const out = cfg.jobs.map((j) => {
  try {
    const raw = { width: j.width, height: j.height, data: new Uint8ClampedArray(fs.readFileSync(j.path)) };
    const timing = {};
    let t = process.hrtime.bigint();
    const t0 = t;
    let scan, quality, check;
    if (mode === "marks") {
      const c = j.cached;
      scan = Object.assign({}, c.scan, { warped: raw });
      quality = c.quality; check = c.check;
      Object.assign(timing, c.timing_ms || {});
      delete timing.findMarks; delete timing.total;
    } else {
      // as scanworker.js: no options object at scale 1 (the app's main-thread path passes none either)
      scan = j.scale && j.scale !== 1 ? Vision.scan(raw, "auto", null, { scale: j.scale }) : Vision.scan(raw, "auto", null);
      timing.scan = ms(t); t = process.hrtime.bigint();
      quality = Inspect.quality(raw, scan);
      timing.quality = ms(t); t = process.hrtime.bigint();
      check = Inspect.edgesAndCorners(scan, { quality, face: j.side });
      timing.check = ms(t);
    }
    let cache = null;
    if (mode === "cache") {
      // round-trip through JSON now, so findMarks below sees exactly what a `marks` run will see
      const { warped, ...rest } = scan;
      fs.writeFileSync(j.warp_out, Buffer.from(warped.data.buffer, warped.data.byteOffset, warped.data.byteLength));
      cache = JSON.parse(JSON.stringify({ scan: rest, quality, check, timing_ms: { ...timing }, input: { width: j.width, height: j.height, scale: j.scale || 1 } }, keepNonFinite));
      const back = JSON.parse(JSON.stringify(cache), revive);
      scan = Object.assign({}, back.scan, { warped }); quality = back.quality; check = back.check;
    }
    t = process.hrtime.bigint();
    const res = Surface.findMarks(scan, { quality, check, side: j.side, revision: 1 });
    timing.findMarks = ms(t);
    timing.total = mode === "marks" ? Math.round(((timing.scan || 0) + (timing.quality || 0) + (timing.check || 0) + timing.findMarks) * 100) / 100 : ms(t0);
    const pick = (c) => Object.fromEntries(CAND_KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
    const input = mode === "marks" ? j.cached.input : { width: j.width, height: j.height, scale: j.scale || 1 };
    return {
      side: j.side, status: res.status, note: res.note, recoverable: !!res.recoverable,
      candidates: (res.candidates || []).map(pick),
      cannotAssess: res.cannotAssess || [],
      stats: res.stats,
      quality: { verdict: quality.verdict, blocked: quality.blocked, blocked_reasons: quality.blocked_reasons },
      scan: { width: scan.width, height: scan.height, margin: scan.margin, mode: scan.mode },
      input,
      timing_ms: timing,
      ...(cache ? { cache } : {}),
    };
  } catch (err) {
    return { side: j.side, status: "error", error: String((err && err.stack) || err).slice(0, 2000) };
  }
});
process.stdout.write(JSON.stringify(out));
