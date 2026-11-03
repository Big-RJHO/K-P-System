/*
 * Surface tools for a flattened card (Vision.scan's `warped` image): preview filters, a reference-image
 * comparison, and EXPERIMENTAL surface-mark candidates. Plain RGBA buffers ({width, height, data}), no DOM, so it
 * runs on the main thread, in a Web Worker (scanworker.js) and in Node for tests.
 *
 * Three separate jobs, kept apart on purpose:
 *   1. Preview rendering   filter(src, {kind, intensity, reference}, cache?) -> NEW {width, height, data}
 *   2. Reference alignment compareReference(scanWarped, margin, refRgba, opts?) -> {ok, reason, aligned, ...}
 *   3. Candidate marks     findMarks(scan, opts) -> {status, candidates, cannotAssess, note, ...}
 * Grading integration is NOT here: candidates are suggestions for a person to look at. Only defects the user
 * confirms enter grading, through the app's existing defect list. findMarks always reads the ORIGINAL warp
 * (scan.warped), never a filtered preview, and has no filter input, so a preview can't change what it finds.
 *
 * ---------------------------------------------------------------- 1. filter(src, opts, cache)
 *   kinds: "original" (copy), "grayscale" (Rec.601 luma), "contrast" (local contrast: luma pushed away from its
 *   local mean, gain = clamp(targetSd / (localSd + eps), 1, maxGain), blended by intensity 0..1; the same luma
 *   change is added to R, G and B so colour is kept), "red" | "green" | "blue" (that channel as grey),
 *   "invert", "difference" (|src - reference| x (1 + 4 x intensity); reference = compareReference(...) result
 *   with ok, or its .aligned image, same size as src; otherwise returns {unavailable: true, reason}).
 *   Never mutates src; always returns a new image. Unknown kind -> throws. Cost is O(pixels) (two box passes for
 *   "contrast"); pass the same `cache` object ({}) between calls to reuse its float buffers.
 *
 * ---------------------------------------------------------------- 2. compareReference(scanWarped, margin, refRgba)
 *   -> {ok, reason, aligned, correlation, shift: {dx, dy}, exposure: {gain: [r,g,b], offset: [r,g,b]}, coverage}
 *   Trims a plain background off the reference, checks it is card-shaped, resizes it into the card box of the
 *   warp, then aligns it by a coarse-to-fine shift search (64 px wide, then 1/4, then full resolution; shifts only,
 *   no rotation or scale) on zero-mean normalised cross-correlation of luma. Rejected (ok false, aligned null) when
 *   the best correlation is below THRESHOLDS.refMinCorr or the best shift hits the search limit: a different
 *   card, a different printing, or an outline that is off. Then exposure / white balance are matched per channel
 *   (mean and standard deviation over the card; gain clamped to 0.5..2) so a brighter or warmer reference doesn't
 *   read as a difference. `aligned` is the size of the warp; the margin and any area the shifted reference
 *   doesn't cover are copied from the scan (difference 0 there); coverage = covered share of the card.
 *
 * ---------------------------------------------------------------- 3. findMarks(scan, opts)
 *   opts: {quality, check, side, revision, printedMask, reference, maxCandidates: 12, timeBudgetMs: 1500,
 *          analysisMaxSide: 1100, cache, debug}     (cache / debug are additions; reference = a compareReference
 *          result, or a raw reference image, which is then aligned here first)
 *   -> {status: "ok" | "timeout" | "cannot_assess", candidates: [Candidate], cannotAssess: [{x, y, w, h, reason}],
 *       note, recoverable (timeout: true), stats: {threshold, analysisScale, elapsedMs, rawComponents,
 *       rejected: {...counts by reason}, truncated, textureTiles, debug? (with opts.debug: the rejected marks)}}
 *       (recoverable / stats are additions; cannotAssess boxes are 0..1 card coordinates like candidates)
 *   Candidate = {id, side, revision, method, kind: "line" | "spot" | "discoloration", x, y, w, h (0..1 of the card,
 *     the card being the warp inside the margin), score (0..1 heuristic strength, NOT a probability),
 *     detection: "low" | "medium" | "high", detectionNote, reason, suggestedTypes: [defects.yaml ids],
 *     status: "pending", contrast (luma levels), lengthMm / sizeMm}                  (contrast / *Mm are additions)
 *
 *   How it looks (bounded: one analysis image at most analysisMaxSide px, a fixed number of passes, a time budget):
 *     - luma Y (3x3 smoothed) and chroma of the card at the analysis resolution;
 *     - a thin-ridge response at two widths (~0.17 / 0.34 mm) and four directions: min(Y - Y(+n), Y - Y(-n)) for a
 *       light ridge (and the reverse for a dark one), so a step between two printed areas, a shadow's smooth
 *       gradient and an exposure ramp give ~0 and only thin lines and small dots respond;
 *     - a threshold of max(minContrast, median + noiseK x noise) (noise from the MAD over the card), so JPEG
 *       blocking / mosquito noise and print grain stay under it; hysteresis grouping into components;
 *     - shape: long + thin + straight -> "line" (suggests surface_scratch, print_line; very long also crease),
 *       small + compact on plain surroundings -> "spot" (print_spot); a blotch of different colour on the plain
 *       printed border -> "discoloration" (stain). Anything else is left alone.
 *   Explicit false-positive handling (each rejection is counted in stats.rejected):
 *     - outside the card, an edge band (edgeBandMm) and the corner zones: the edge / corner detector's job;
 *       anything overlapping check.overlays (edge rects, corner polylines) is dropped as already covered;
 *     - the printed frame line (scan.lines.inner, where the border was read) and opts.printedMask pixels;
 *     - "boundary": a line whose two sides differ (it runs along the edge between two printed areas: artwork
 *       structure, text outline, JPEG ringing) and a dot whose surroundings aren't plain;
 *     - "cluster": a mark with several others within clusterRadiusMm (printed text, patterns, foil sparkle);
 *       ~4 mm tiles full of such marks are reported in cannotAssess: "foil / holo texture" when most of the marks
 *       are tiny light specks or colour changes everywhere (sparkle, shimmer), otherwise "busy print" (text, pattern);
 *     - "reference": the same structure in the aligned reference image (printed, not damage);
 *     - "reflection": a long, straight, colourless light line, or a light line on a broad light band (sleeve or
 *       slab reflection, light streak); thresholds go up by sleeveBoost when quality saw a sleeve;
 *     - "glare": over-exposed pixels can't show anything: those areas go to cannotAssess, not candidates;
 *     - quality: resolution or focus failures -> status "cannot_assess" for the whole face.
 *   It never claims what a flat photo can't show (dents, gloss loss, fine scratches that don't catch the light):
 *   finding nothing is not evidence of a clean surface. PRECISION / RECALL ON REAL PHOTOS IS UNMEASURED: these
 *   thresholds were set by hand on synthetic cards only (tests/test_standalone_surface.py).
 *   Caps: maxCandidates (strongest kept, stats.truncated says how many more), one pass per stage, and
 *   timeBudgetMs checked between rows / components: when exceeded the result is status "timeout" with whatever
 *   was finished (recoverable: just run it again, e.g. with a smaller analysisMaxSide). Deterministic.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Surface = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CARD_MM = [63, 88];
  const CORNER_R = 0.048;  // corner radius / card width (as vision.js / inspect.js)
  const KINDS = ["original", "grayscale", "contrast", "red", "green", "blue", "invert", "difference"];

  /* Thresholds: hand-set on synthetic cards; NOT calibrated on real photos. Luma is on the 0..255 scale. */
  const T = {
    // filter "contrast"
    contrastRadius: 1 / 24,   // local window radius as a share of the image's short side
    contrastTargetSd: 48, contrastEps: 6, contrastMaxGain: 4,
    // compareReference
    refAspectTol: 0.12,       // reference box aspect within 12% of 63:88
    refMinCorr: 0.6,          // best zero-mean NCC of luma below this: not this card / not aligned
    refSearch: 3,             // shift search +-3 cells at each level (64 px wide level: +-4.7% of the card)
    refGain: [0.5, 2],
    // findMarks geometry (mm)
    edgeBandMm: 1.5,          // in from the card's edge: whitening is looked for up to ~1.2 mm deep (inspect.js band1Mm)
    framePadMm: 0.6,          // either side of the read printed-frame line
    ridgeMm: [0.17, 0.34],    // ridge half-widths (2 / 4 px at 11.9 px/mm)
    // findMarks response
    minContrast: 10,          // luma levels: weaker marks are never candidates
    noiseK: 6,                // ... nor weaker than median + noiseK x 1.4826 MAD of the response
    lowFrac: 0.5,             // hysteresis: grow components down to this share of the threshold
    sleeveBoost: 1.3,         // threshold factor when quality saw a sleeve / slab
    maxComponentMm2: 40,      // larger connected structures are print, not marks
    // line
    lineMinMm: 1.5, lineAspect: 5, lineRmsPx: 1.5, lineCurve: 0.05, lineMaxWidthMm: 0.6, creaseMinMm: 20,
    // spot
    spotMinPx: 3, spotMaxMm: 1.5, spotMaxAspect: 3,
    ringAbs: 8, ringRel: 0.35,  // surroundings std must be under max(ringAbs, ringRel x contrast)
    // boundary test for lines: the two sides' luma / chroma differ by more than this
    sideAbs: 12, sideRel: 0.45, sideChroma: 16,
    // clusters / texture
    clusterRadiusMm: 3, clusterMax: 4,
    tileMm: 4, tileMarks: 8, tileFrac: 0.12, maxTextureRegions: 12,
    foilSpecks: 0.45, foilChroma: 35,  // a busy tile is foil-like when most marks are tiny light specks or colour changes everywhere (mean chroma gradient)
    glareShare: 0.3,          // a mark with this share of its pixels in a glare patch is glare, not a mark
    // reflections
    reflectSpan: 0.35, reflectSpanSleeve: 0.2, reflectChroma: 14, plateauRel: 0.4,
    // reference
    refStructure: 0.5, refShare: 0.4,
    // glare (over-exposed: min channel >= 248 and nearly colourless; inspect.js uses L >= 98.5, C < 6)
    clipMin: 248, clipSpread: 10, glareMinMm2: 0.3, glarePadMm: 1,
    // discoloration on the plain printed border
    stainDelta: 16, stainMinMm2: 1, stainMaxRidge: 0.15, stainWindowMm: 6,  // stainMaxRidge: share of sharp-ridge px (text)
    // dedupe against the edge/corner check's overlays
    dedupePadMm: 1,
    // score -> detection label (uncalibrated)
    detHigh: 0.6, detMedium: 0.3,
  };

  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const r2 = (v) => Math.round(v * 100) / 100;
  const validImg = (img) => !!(img && img.width > 0 && img.height > 0 && img.data && img.data.length >= img.width * img.height * 4);
  const newImg = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

  // A typed buffer of exactly n elements, reused from `cache` when it holds one of that type and size.
  function buf(cache, key, Type, n) {
    if (!cache) return new Type(n);
    const b = cache[key];
    if (b && b.length === n && b instanceof Type) return b;
    return (cache[key] = new Type(n));
  }

  /* ================================================================ 1. filters */

  function lumaOf(src, out) {
    const d = src.data, n = src.width * src.height;
    for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    return out;
  }

  // Box mean of `a` (w x h) with radius r (window clipped at the borders), separable running sums.
  function boxMean(a, w, h, r, tmp, out) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0, n = 0;
      for (let x = 0; x <= Math.min(r, w - 1); x++) { s += a[row + x]; n++; }
      for (let x = 0; x < w; x++) {
        tmp[row + x] = s / n;
        const add = x + r + 1, del = x - r;
        if (add < w) { s += a[row + add]; n++; }
        if (del >= 0) { s -= a[row + del]; n--; }
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let y = 0; y <= Math.min(r, h - 1); y++) { s += tmp[y * w + x]; n++; }
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / n;
        const add = y + r + 1, del = y - r;
        if (add < h) { s += tmp[add * w + x]; n++; }
        if (del >= 0) { s -= tmp[del * w + x]; n--; }
      }
    }
    return out;
  }

  function referenceImage(reference) {
    if (!reference) return { img: null, reason: "Difference needs a reference image of this card, aligned with compareReference first." };
    if (reference.ok === false) return { img: null, reason: reference.reason || "The reference image didn't line up with this card." };
    const img = reference.aligned || reference;
    return validImg(img) ? { img, reason: null } : { img: null, reason: "The reference image is missing or malformed." };
  }

  function filter(src, opts = {}, cache = null) {
    if (!validImg(src)) throw new Error("Surface.filter: source image is missing or malformed.");
    const kind = opts.kind || "original";
    if (!KINDS.includes(kind)) throw new Error(`Surface.filter: unknown kind "${kind}".`);
    const k = opts.intensity == null ? 0.5 : clamp01(Number(opts.intensity) || 0);
    const w = src.width, h = src.height, n = w * h, d = src.data;
    if (kind === "difference") {
      const { img: ref, reason } = referenceImage(opts.reference);
      if (!ref) return { unavailable: true, reason };
      if (ref.width !== w || ref.height !== h) return { unavailable: true, reason: "The reference isn't aligned to this scan (different size): run compareReference on this scan." };
      const out = newImg(w, h), o = out.data, rd = ref.data, gain = 1 + 4 * k;
      for (let p = 0; p < n * 4; p += 4) {
        o[p] = Math.abs(d[p] - rd[p]) * gain; o[p + 1] = Math.abs(d[p + 1] - rd[p + 1]) * gain; o[p + 2] = Math.abs(d[p + 2] - rd[p + 2]) * gain; o[p + 3] = 255;
      }
      return out;
    }
    const out = newImg(w, h), o = out.data;
    switch (kind) {
      case "original":
        o.set(d.subarray(0, n * 4));
        break;
      case "grayscale":
        for (let p = 0; p < n * 4; p += 4) { const v = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; o[p] = o[p + 1] = o[p + 2] = v; o[p + 3] = d[p + 3]; }
        break;
      case "red": case "green": case "blue": {
        const c = kind === "red" ? 0 : kind === "green" ? 1 : 2;
        for (let p = 0; p < n * 4; p += 4) { o[p] = o[p + 1] = o[p + 2] = d[p + c]; o[p + 3] = d[p + 3]; }
        break;
      }
      case "invert":
        for (let p = 0; p < n * 4; p += 4) { o[p] = 255 - d[p]; o[p + 1] = 255 - d[p + 1]; o[p + 2] = 255 - d[p + 2]; o[p + 3] = d[p + 3]; }
        break;
      case "contrast": {
        const Y = lumaOf(src, buf(cache, "fY", Float32Array, n));
        const Y2 = buf(cache, "fY2", Float32Array, n);
        for (let i = 0; i < n; i++) Y2[i] = Y[i] * Y[i];
        const tmp = buf(cache, "fTmp", Float32Array, n);
        const r = Math.max(2, Math.round(Math.min(w, h) * T.contrastRadius));
        const mean = boxMean(Y, w, h, r, tmp, buf(cache, "fMean", Float32Array, n));
        const mean2 = boxMean(Y2, w, h, r, tmp, buf(cache, "fMean2", Float32Array, n));
        for (let i = 0, p = 0; i < n; i++, p += 4) {
          const sd = Math.sqrt(Math.max(0, mean2[i] - mean[i] * mean[i]));
          const gain = Math.min(T.contrastMaxGain, Math.max(1, T.contrastTargetSd / (sd + T.contrastEps)));
          const delta = k * (Y[i] - mean[i]) * (gain - 1);
          o[p] = d[p] + delta; o[p + 1] = d[p + 1] + delta; o[p + 2] = d[p + 2] + delta; o[p + 3] = d[p + 3];
        }
        break;
      }
    }
    return out;
  }

  /* ================================================================ 2. reference */

  // Bounding box of the non-background content (plain ring around the card). Card-shaped images are kept whole.
  function trimBox(img) {
    const { width: w, height: h, data: d } = img;
    const full = { x: 0, y: 0, w, h };
    if (Math.abs(w / h / (CARD_MM[0] / CARD_MM[1]) - 1) <= 0.04) return full;
    const ring = [];
    const push = (x, y) => { const i = (y * w + x) * 4; ring.push([d[i], d[i + 1], d[i + 2], d[i + 3]]); };
    for (let x = 0; x < w; x += Math.max(1, w >> 6)) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y += Math.max(1, h >> 6)) { push(0, y); push(w - 1, y); }
    const med = (k) => ring.map((p) => p[k]).sort((a, b) => a - b)[ring.length >> 1];
    const bg = [med(0), med(1), med(2), med(3)];
    const isBg = (i) => (bg[3] < 32 ? d[i + 3] < 32 : d[i + 3] >= 32 && Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) <= 36);
    let uniform = 0;
    for (const p of ring) if (bg[3] < 32 ? p[3] < 32 : p[3] >= 32 && Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) <= 36) uniform++;
    if (uniform / ring.length < 0.9) return full;
    const colHits = new Int32Array(w), rowHits = new Int32Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!isBg((y * w + x) * 4)) { colHits[x]++; rowHits[y]++; }
    let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
    const minCol = Math.max(2, h * 0.01), minRow = Math.max(2, w * 0.01);
    while (x0 < x1 && colHits[x0] < minCol) x0++;
    while (x1 > x0 && colHits[x1] < minCol) x1--;
    while (y0 < y1 && rowHits[y0] < minRow) y0++;
    while (y1 > y0 && rowHits[y1] < minRow) y1--;
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // Area-average + bilinear resize of a box of an RGBA image to w x h, as Float32 RGB planes.
  function resizeBox(img, box, w, h) {
    const sw = img.width, sd = img.data;
    const out = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
    const fx = box.w / w, fy = box.h / h;
    for (let y = 0; y < h; y++) {
      const sy0 = box.y + y * fy, sy1 = sy0 + fy;
      const ya = Math.floor(sy0), yb = Math.max(ya + 1, Math.min(box.y + box.h, Math.ceil(sy1)));
      for (let x = 0; x < w; x++) {
        const sx0 = box.x + x * fx, sx1 = sx0 + fx;
        const xa = Math.floor(sx0), xb = Math.max(xa + 1, Math.min(box.x + box.w, Math.ceil(sx1)));
        let r = 0, g = 0, b = 0, n = 0;
        if (fx <= 1 && fy <= 1) {  // enlarging: bilinear
          const cx = Math.min(box.x + box.w - 1, Math.max(box.x, sx0 + fx / 2 - 0.5)), cy = Math.min(box.y + box.h - 1, Math.max(box.y, sy0 + fy / 2 - 0.5));
          const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(box.x + box.w - 1, x0 + 1), y1 = Math.min(box.y + box.h - 1, y0 + 1);
          const tx = cx - x0, ty = cy - y0;
          const P = (xx, yy, c) => sd[(yy * sw + xx) * 4 + c];
          for (let c = 0; c < 3; c++) out[c][y * w + x] = (P(x0, y0, c) * (1 - tx) + P(x1, y0, c) * tx) * (1 - ty) + (P(x0, y1, c) * (1 - tx) + P(x1, y1, c) * tx) * ty;
          continue;
        }
        for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) { const p = (yy * sw + xx) * 4; r += sd[p]; g += sd[p + 1]; b += sd[p + 2]; n++; }
        const i = y * w + x;
        out[0][i] = r / n; out[1][i] = g / n; out[2][i] = b / n;
      }
    }
    return out;
  }

  // Luma of an RGB-planes image reduced by integer factor f (box average).
  function reduceLuma(planes, w, h, f) {
    const sw = Math.floor(w / f), sh = Math.floor(h / f), out = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let s = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
        const p = (y * f + j) * w + x * f + i;
        s += 0.299 * planes[0][p] + 0.587 * planes[1][p] + 0.114 * planes[2][p];
      }
      out[y * sw + x] = s / (f * f);
    }
    return { a: out, w: sw, h: sh };
  }

  // Zero-mean NCC of a and b (same w x h) with b shifted by (dx, dy), over the inner area (skipping `pad` cells), every `step`.
  function ncc(a, b, w, h, dx, dy, pad, step) {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    const y0 = Math.max(pad, pad - dy), y1 = Math.min(h - pad, h - pad - dy), x0 = Math.max(pad, pad - dx), x1 = Math.min(w - pad, w - pad - dx);
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const va = a[y * w + x], vb = b[(y + dy) * w + x + dx];
      n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
    if (n < 16) return -1;
    const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return va <= 1e-6 || vb <= 1e-6 ? -1 : cov / Math.sqrt(va * vb);
  }

  function searchShift(a, b, w, h, cx, cy, range, pad, step) {
    let best = { dx: cx, dy: cy, r: -2 };
    for (let dy = cy - range; dy <= cy + range; dy++) for (let dx = cx - range; dx <= cx + range; dx++) {
      const r = ncc(a, b, w, h, dx, dy, pad, step);
      if (r > best.r) best = { dx, dy, r };
    }
    return best;
  }

  function compareReference(scanWarped, margin, refRgba) {
    const fail = (reason, extra) => Object.assign({ ok: false, reason, aligned: null }, extra || {});
    if (!validImg(scanWarped)) return fail("The scan image is missing or malformed.");
    if (!validImg(refRgba)) return fail("The reference image is missing or malformed.");
    const W = scanWarped.width, H = scanWarped.height, M = margin | 0;
    const cw = W - 2 * M, ch = H - 2 * M;
    if (cw < 32 || ch < 32) return fail("The margin is larger than the scan.");
    const box = trimBox(refRgba);
    if (!box) return fail("The reference image is blank.");
    const aspect = box.w / box.h, cardAspect = CARD_MM[0] / CARD_MM[1];
    if (Math.abs(aspect / cardAspect - 1) > T.refAspectTol) return fail(`The reference isn't card-shaped (${r2(aspect)} wide-to-tall; a card is ${r2(cardAspect)}).`);
    const ref = resizeBox(refRgba, box, cw, ch);
    const sd = scanWarped.data;
    const scn = [new Float32Array(cw * ch), new Float32Array(cw * ch), new Float32Array(cw * ch)];
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const p = ((y + M) * W + x + M) * 4, i = y * cw + x;
      scn[0][i] = sd[p]; scn[1][i] = sd[p + 1]; scn[2][i] = sd[p + 2];
    }
    // Coarse to fine: ~64 px wide, then 1/4 resolution, then full (sampled every 2nd px).
    const f1 = Math.max(1, Math.floor(cw / 64)), f2 = Math.max(1, Math.min(f1, 4));
    const A1 = reduceLuma(scn, cw, ch, f1), B1 = reduceLuma(ref, cw, ch, f1);
    const S = T.refSearch;
    const s1 = searchShift(A1.a, B1.a, A1.w, A1.h, 0, 0, S, Math.max(2, S + 1), 1);
    if (s1.r < T.refMinCorr) return fail(`The reference doesn't match this card (correlation ${r2(s1.r)}): a different card or printing, or the outline is off.`, { correlation: r3(s1.r) });
    if (Math.abs(s1.dx) >= S || Math.abs(s1.dy) >= S) return fail("The reference only lines up shifted well off the card: the outline may be wrong, or it is a cropped or different image.", { correlation: r3(s1.r) });
    let dx = s1.dx * f1, dy = s1.dy * f1, r = s1.r;
    if (f1 > f2) {
      const A2 = reduceLuma(scn, cw, ch, f2), B2 = reduceLuma(ref, cw, ch, f2);
      const k = Math.ceil(f1 / f2);
      const s2 = searchShift(A2.a, B2.a, A2.w, A2.h, Math.round(dx / f2), Math.round(dy / f2), k, Math.ceil(S * f1 / f2) + 2, 1);
      dx = s2.dx * f2; dy = s2.dy * f2; r = s2.r;
    }
    if (f2 > 1) {
      const A3 = reduceLuma(scn, cw, ch, 1), B3 = reduceLuma(ref, cw, ch, 1);
      const s3 = searchShift(A3.a, B3.a, cw, ch, dx, dy, f2, S * f1 + f2 + 2, 2);
      dx = s3.dx; dy = s3.dy; r = s3.r;
    }
    if (r < T.refMinCorr) return fail(`The reference doesn't line up closely enough with this card (correlation ${r2(r)}).`, { correlation: r3(r) });
    // Exposure / white balance: per-channel mean and sd over the overlapping card area.
    const gain = [1, 1, 1], offset = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      let n = 0, sa = 0, saa = 0, sb = 0, sbb = 0;
      for (let y = Math.max(0, -dy); y < Math.min(ch, ch - dy); y += 2) for (let x = Math.max(0, -dx); x < Math.min(cw, cw - dx); x += 2) {
        const va = scn[c][y * cw + x], vb = ref[c][(y + dy) * cw + x + dx];
        n++; sa += va; saa += va * va; sb += vb; sbb += vb * vb;
      }
      const ma = sa / n, mb = sb / n;
      const sdA = Math.sqrt(Math.max(0, saa / n - ma * ma)), sdB = Math.sqrt(Math.max(0, sbb / n - mb * mb));
      gain[c] = Math.min(T.refGain[1], Math.max(T.refGain[0], sdB > 1 ? sdA / sdB : 1));
      offset[c] = ma - gain[c] * mb;
    }
    const aligned = newImg(W, H), ad = aligned.data;
    ad.set(sd.subarray(0, W * H * 4));
    let covered = 0;
    for (let y = 0; y < ch; y++) {
      const ry = y + dy;
      if (ry < 0 || ry >= ch) continue;
      for (let x = 0; x < cw; x++) {
        const rx = x + dx;
        if (rx < 0 || rx >= cw) continue;
        const p = ((y + M) * W + x + M) * 4, j = ry * cw + rx;
        ad[p] = gain[0] * ref[0][j] + offset[0]; ad[p + 1] = gain[1] * ref[1][j] + offset[1]; ad[p + 2] = gain[2] * ref[2][j] + offset[2];
        covered++;
      }
    }
    return { ok: true, reason: null, aligned, correlation: r3(r), shift: { dx, dy }, exposure: { gain: gain.map(r3), offset: offset.map(r2) }, coverage: r3(covered / (cw * ch)) };
  }

  /* ================================================================ 3. candidate marks */

  // Card area of the warp at analysis resolution (factor f >= 1): smoothed luma, raw luma, chroma (Cb, Cr), clipped.
  function cardPlanes(scan, aw, ah, f, cache) {
    const W = scan.width, M = scan.margin, d = scan.warped.data;
    const n = aw * ah;
    const Y = buf(cache, "mY", Float32Array, n), CB = buf(cache, "mCb", Float32Array, n), CR = buf(cache, "mCr", Float32Array, n);
    const CLIP = buf(cache, "mClip", Uint8Array, n);
    CLIP.fill(0);
    for (let y = 0; y < ah; y++) {
      const ya = Math.floor(y * f), yb = Math.max(ya + 1, Math.floor((y + 1) * f));
      for (let x = 0; x < aw; x++) {
        const xa = Math.floor(x * f), xb = Math.max(xa + 1, Math.floor((x + 1) * f));
        let r = 0, g = 0, b = 0, k = 0, clip = 0;
        for (let yy = ya; yy < yb; yy++) {
          let p = ((yy + M) * W + xa + M) * 4;
          for (let xx = xa; xx < xb; xx++, p += 4) {
            const R = d[p], G = d[p + 1], B = d[p + 2];
            r += R; g += G; b += B; k++;
            const mn = R < G ? (R < B ? R : B) : G < B ? G : B, mx = R > G ? (R > B ? R : B) : G > B ? G : B;
            if (mn >= T.clipMin && mx - mn <= T.clipSpread) clip = 1;
          }
        }
        const i = y * aw + x, yv = (0.299 * r + 0.587 * g + 0.114 * b) / k;
        Y[i] = yv; CB[i] = b / k - yv; CR[i] = r / k - yv; CLIP[i] = clip;
      }
    }
    // 3x3 binomial smoothing of luma
    const tmp = buf(cache, "mTmp", Float32Array, n), YS = buf(cache, "mYs", Float32Array, n);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      const l = x > 0 ? x - 1 : x, r = x < aw - 1 ? x + 1 : x;
      tmp[y * aw + x] = (Y[y * aw + l] + 2 * Y[y * aw + x] + Y[y * aw + r]) / 4;
    }
    for (let y = 0; y < ah; y++) {
      const u = y > 0 ? y - 1 : y, dn = y < ah - 1 ? y + 1 : y;
      for (let x = 0; x < aw; x++) YS[y * aw + x] = (tmp[u * aw + x] + 2 * tmp[y * aw + x] + tmp[dn * aw + x]) / 4;
    }
    return { Y, YS, CB, CR, CLIP };
  }

  // Ridge response: R = strongest thin light (+) or dark (-) ridge over widths and directions, |R| in luma levels.
  function ridgeRows(YS, aw, ah, valid, ds, R, y0, y1) {
    const offs = [];
    for (const d of ds) {
      const k = d > 1 ? Math.max(1, Math.round(d / Math.SQRT2)) : 1;
      offs.push(d, d * aw, k + k * aw, k - k * aw);
    }
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < aw; x++) {
        const i = y * aw + x;
        if (!valid[i]) { R[i] = 0; continue; }
        const c = YS[i];
        let best = 0;
        for (let o = 0; o < offs.length; o++) {
          const a = YS[i + offs[o]], b = YS[i - offs[o]];
          const light = Math.min(c - a, c - b), dark = Math.min(a - c, b - c);
          if (light > (best > 0 ? best : -best)) best = light;
          if (dark > (best > 0 ? best : -best)) best = -dark;
        }
        R[i] = best;
      }
    }
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = Float64Array.from(arr).sort();
    return s[s.length >> 1];
  }

  // Rectangles (analysis px) of the set cells of a tile grid: merge runs along rows, then equal runs down columns.
  function tileRects(flags, tw, th) {
    const runs = [];
    for (let ty = 0; ty < th; ty++) {
      let tx = 0;
      while (tx < tw) {
        if (!flags[ty * tw + tx]) { tx++; continue; }
        const v = flags[ty * tw + tx];
        let e = tx;
        while (e + 1 < tw && flags[ty * tw + e + 1] === v) e++;
        runs.push({ x0: tx, x1: e, y0: ty, y1: ty, v });
        tx = e + 1;
      }
    }
    const out = [];
    for (const r of runs) {
      const prev = out.find((o) => o.x0 === r.x0 && o.x1 === r.x1 && o.y1 === r.y0 - 1 && o.v === r.v);
      if (prev) prev.y1 = r.y0; else out.push({ ...r });
    }
    return out;
  }

  function findMarks(scan, opts = {}) {
    const t0 = now();
    const budget = opts.timeBudgetMs != null ? opts.timeBudgetMs : 1500;
    const maxC = opts.maxCandidates != null ? Math.max(0, opts.maxCandidates | 0) : 12;
    const side = opts.side || null, revision = opts.revision != null ? opts.revision : 0;
    const q = opts.quality || null, check = opts.check || null;
    const stats = { threshold: null, analysisScale: null, elapsedMs: 0, rawComponents: 0, rejected: { boundary: 0, cluster: 0, reference: 0, reflection: 0, irregular: 0, glare: 0, deduped: 0, texture: 0, faint: 0 }, truncated: 0 };
    const finish = (status, candidates, cannotAssess, note) => {
      stats.elapsedMs = Math.round(now() - t0);
      const out = { status, candidates, cannotAssess, note, stats };
      if (status === "timeout") out.recoverable = true;
      return out;
    };
    const whole = (reason) => [{ x: 0, y: 0, w: 1, h: 1, reason }];
    if (!scan || !validImg(scan.warped) || !(scan.margin >= 0)) return finish("cannot_assess", [], whole("No scan of this face."), "No scan to look at.");
    const qb = (q && q.blocked_reasons && q.blocked_reasons.surface) || [];
    if (qb.includes("resolution")) return finish("cannot_assess", [], whole("The card is too small in the photo to see surface marks."), "Surface marks can't be looked for: move closer and retake.");
    if (qb.includes("sharpness")) return finish("cannot_assess", [], whole("The photo is too blurry to see surface marks."), "Surface marks can't be looked for: the photo is blurry. Retake it in focus.");

    const W = scan.width, H = scan.height, M = scan.margin;
    const cw = W - 2 * M, ch = H - 2 * M;
    const maxSide = Math.max(64, opts.analysisMaxSide || 1100);
    const f = Math.max(1, Math.max(cw, ch) / maxSide);
    const aw = Math.max(16, Math.round(cw / f)), ah = Math.max(16, Math.round(ch / f));
    const fx = cw / aw, fy = ch / ah;  // analysis px -> card px
    const ppm = aw / CARD_MM[0];       // analysis px per mm
    stats.analysisScale = r3(1 / fx);
    const n = aw * ah, cache = opts.cache || null;
    const timeUp = () => now() - t0 > budget;
    const cannotAssess = [];
    const toCard = (x0, y0, x1, y1) => ({ x: r3(clamp01(x0 / aw)), y: r3(clamp01(y0 / ah)), w: r3(clamp01((x1 - x0) / aw)), h: r3(clamp01((y1 - y0) / ah)) });
    const timeoutNote = () => `Stopped after ${Math.round(now() - t0)} ms to keep the app responsive; these results are partial. Run it again (it may finish on a less busy device), or use a smaller analysis size.`;

    const { YS, CB, CR, CLIP } = cardPlanes(scan, aw, ah, f, cache);

    // ---- where to look: inside the edge band and corner zones, off the printed frame and the printed mask
    const band = Math.max(2, Math.round(T.edgeBandMm * ppm));
    const ds = [Math.max(1, Math.round(T.ridgeMm[0] * ppm)), Math.max(2, Math.round(T.ridgeMm[1] * ppm))];
    if (ds[1] <= ds[0]) ds[1] = ds[0] + 1;
    const guard = Math.max(band, ds[1] + 2);
    const rz = CORNER_R * aw + band;
    const per = (scan.confidence && scan.confidence.per_side) || {};
    const inner = scan.lines && scan.lines.inner;
    const frame = {};
    if (inner) {
      if (per.left >= 0.3) frame.left = (inner.left - M) / fx;
      if (per.right >= 0.3) frame.right = (inner.right - M) / fx;
      if (per.top >= 0.3) frame.top = (inner.top - M) / fy;
      if (per.bottom >= 0.3) frame.bottom = (inner.bottom - M) / fy;
    }
    const fpad = Math.max(1, Math.round(T.framePadMm * ppm));
    const pm = opts.printedMask && opts.printedMask.length >= W * H ? opts.printedMask : null;
    const valid = buf(cache, "mValid", Uint8Array, n), border = buf(cache, "mBorder", Uint8Array, n);
    for (let y = 0; y < ah; y++) {
      const ey = Math.min(y, ah - 1 - y);
      for (let x = 0; x < aw; x++) {
        const i = y * aw + x, ex = Math.min(x, aw - 1 - x);
        let v = ex >= guard && ey >= guard && !(ex < rz && ey < rz);
        if (v && ((frame.left != null && Math.abs(x - frame.left) <= fpad) || (frame.right != null && Math.abs(x - frame.right) <= fpad)
          || (frame.top != null && Math.abs(y - frame.top) <= fpad) || (frame.bottom != null && Math.abs(y - frame.bottom) <= fpad))) v = false;
        if (v && pm && pm[(Math.min(H - 1, M + Math.floor((y + 0.5) * fy))) * W + Math.min(W - 1, M + Math.floor((x + 0.5) * fx))]) v = false;
        valid[i] = v ? 1 : 0;
        // the plain printed border: between the edge band and a read frame line
        border[i] = v && ((frame.left != null && x < frame.left - fpad) || (frame.right != null && x > frame.right + fpad)
          || (frame.top != null && y < frame.top - fpad) || (frame.bottom != null && y > frame.bottom + fpad)) ? 1 : 0;
      }
    }

    // ---- glare: over-exposed patches can't show anything; they become cannotAssess regions
    const glareRects = [];
    {
      const seen = buf(cache, "mSeen", Uint8Array, n);
      seen.fill(0);
      const stack = buf(cache, "mStack", Int32Array, n);
      const minPx = Math.max(2, T.glareMinMm2 * ppm * ppm), pad = Math.round(T.glarePadMm * ppm);
      for (let i0 = 0; i0 < n; i0++) {
        if (!CLIP[i0] || seen[i0]) continue;
        let sp = 0, cnt = 0, x0 = aw, y0 = ah, x1 = 0, y1 = 0;
        stack[sp++] = i0; seen[i0] = 1;
        while (sp) {
          const i = stack[--sp], x = i % aw, y = (i - x) / aw;
          cnt++;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= aw || yy >= ah) continue;
            const j = yy * aw + xx;
            if (CLIP[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
          }
        }
        if (cnt >= minPx) glareRects.push([Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(aw, x1 + 1 + pad), Math.min(ah, y1 + 1 + pad)]);
      }
      glareRects.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
      for (const g of glareRects.slice(0, 8)) cannotAssess.push({ ...toCard(...g), reason: "Glare (over-exposed) hides the surface here." });
      if (glareRects.length > 8) {
        const u = glareRects.slice(8).reduce((a, g) => [Math.min(a[0], g[0]), Math.min(a[1], g[1]), Math.max(a[2], g[2]), Math.max(a[3], g[3])]);
        cannotAssess.push({ ...toCard(...u), reason: "Several small glare spots hide the surface here." });
      }
    }
    const inGlare = (x0, y0, x1, y1) => glareRects.some((g) => x0 < g[2] && x1 > g[0] && y0 < g[3] && y1 > g[1]);
    const glareShare = (c) => {
      if (!glareRects.length) return 0;
      let k = 0;
      for (let j = c.start; j < c.start + c.cnt; j++) {
        const i = pix[j], x = i % aw, y = (i - x) / aw;
        if (glareRects.some((g) => x >= g[0] && x < g[2] && y >= g[1] && y < g[3])) k++;
      }
      return k / c.cnt;
    };

    // ---- reference (aligned): its own ridge response marks printed structure
    let refR = null, refNote = "";
    if (opts.reference) {
      let al = opts.reference;
      if (al && al.ok === undefined && validImg(al) && (al.width !== W || al.height !== H)) al = compareReference(scan.warped, M, al);
      if (al && al.ok === false) refNote = ` Reference not used: ${al.reason}`;
      else {
        const img = al && al.aligned ? al.aligned : al;
        if (validImg(img) && img.width === W && img.height === H) {
          const rp = cardPlanes({ warped: img, width: W, height: H, margin: M }, aw, ah, f, null);
          refR = new Float32Array(n);
          ridgeRows(rp.YS, aw, ah, valid, ds, refR, 0, ah);
        } else refNote = " Reference not used: it isn't aligned to this scan.";
      }
    }

    // ---- ridge response (time-checked every 32 rows)
    const R = buf(cache, "mR", Float32Array, n);
    for (let y = 0; y < ah; y += 32) {
      ridgeRows(YS, aw, ah, valid, ds, R, y, Math.min(ah, y + 32));
      if (timeUp()) return finish("timeout", [], cannotAssess, timeoutNote());
    }

    // ---- threshold from the response's own noise
    const sample = [];
    const stride = Math.max(1, Math.floor(n / 40000));
    for (let i = 0; i < n; i += stride) if (valid[i]) sample.push(Math.abs(R[i]));
    const med = median(sample);
    const mad = median(sample.map((v) => Math.abs(v - med)));
    const sleeve = !!(q && q.checks && q.checks.sleeve && q.checks.sleeve.value);
    const thr = Math.max(T.minContrast, med + T.noiseK * 1.4826 * mad) * (sleeve ? T.sleeveBoost : 1);
    const lo = thr * T.lowFrac;
    stats.threshold = r2(thr);

    // ---- components: same-sign pixels above lo, holding at least one above thr (8-connected)
    const label = buf(cache, "mLabel", Int32Array, n);
    label.fill(0);
    const pix = buf(cache, "mPix", Int32Array, n);
    const comps = [];
    const maxPx = T.maxComponentMm2 * ppm * ppm;
    let top = 0;
    for (let i0 = 0; i0 < n; i0++) {
      const v0 = R[i0];
      if (label[i0] || (v0 < thr && -v0 < thr)) continue;
      const sign = v0 > 0 ? 1 : -1, id = comps.length + 1, start = top;
      let head = top;
      pix[top++] = i0; label[i0] = id;
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sr = 0, peak = 0, x0 = aw, y0 = ah, x1 = 0, y1 = 0, clipped = 0;
      while (head < top) {
        const i = pix[head++], x = i % aw, y = (i - x) / aw, r = R[i] * sign;
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sr += r; if (r > peak) peak = r;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (CLIP[i]) clipped++;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ah) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= aw) continue;
            const j = yy * aw + xx;
            if (!label[j] && R[j] * sign >= lo) { label[j] = id; pix[top++] = j; }
          }
        }
      }
      const cnt = top - start;
      const mx = sx / cnt, my = sy / cnt;
      const cxx = sxx / cnt - mx * mx, cyy = syy / cnt - my * my, cxy = sxy / cnt - mx * my;
      const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
      const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      comps.push({ id, sign, start, cnt, mx, my, l1, l2, theta, mean: sr / cnt, peak, x0, y0, x1, y1, clipped });
      if ((comps.length & 255) === 0 && timeUp()) return finish("timeout", [], cannotAssess, timeoutNote());
    }
    stats.rawComponents = comps.length;

    // ---- neighbourhood: marks close together are print (text, pattern) or foil texture
    const cr = T.clusterRadiusMm * ppm;
    const gridW = Math.ceil(aw / cr) + 1, grid = new Map();
    for (const c of comps) {
      const key = Math.floor(c.my / cr) * gridW + Math.floor(c.mx / cr);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(c);
    }
    // Texture tiles (for cannotAssess): many marks, or many response pixels, in a ~4 mm tile.
    const ts = Math.max(8, Math.round(T.tileMm * ppm)), tw = Math.ceil(aw / ts), th = Math.ceil(ah / ts);
    const tileMarks = new Int32Array(tw * th), tilePx = new Int32Array(tw * th), tileValid = new Int32Array(tw * th);
    const tileHF = new Float64Array(tw * th);  // fine colour change (chroma gradient): foil / holo sparkle has lots
    const tileSpecks = new Int32Array(tw * th), speckPx = Math.max(4, (0.5 * ppm) ** 2);
    for (const c of comps) {
      const t = Math.floor(c.my / ts) * tw + Math.floor(c.mx / ts);
      tileMarks[t]++;
      if (c.sign > 0 && c.cnt <= speckPx) tileSpecks[t]++;
    }
    for (let y = 0; y < ah; y += 2) for (let x = 0; x < aw; x += 2) {
      const i = y * aw + x;
      if (!valid[i]) continue;
      const t = Math.floor(y / ts) * tw + Math.floor(x / ts);
      tileValid[t]++;
      if (Math.abs(R[i]) >= lo) tilePx[t]++;
      if (x + 1 < aw && y + 1 < ah) tileHF[t] += Math.abs(CB[i] - CB[i + 1]) + Math.abs(CR[i] - CR[i + 1]) + Math.abs(CB[i] - CB[i + aw]) + Math.abs(CR[i] - CR[i + aw]);
    }
    const tileFlag = new Uint8Array(tw * th);  // 1 busy print, 2 foil-like (specks / colour shimmer)
    for (let t = 0; t < tw * th; t++) {
      const nv = tileValid[t];
      if (nv < 0.25 * (ts * ts) / 4) continue;
      if (tileMarks[t] >= T.tileMarks || tilePx[t] / nv >= T.tileFrac) {
        tileFlag[t] = tileSpecks[t] >= T.foilSpecks * tileMarks[t] || tileHF[t] / nv >= T.foilChroma ? 2 : 1;
        if (opts.debug) (stats.tiles = stats.tiles || []).push({ x: r3((t % tw) * ts / aw), y: r3(Math.floor(t / tw) * ts / ah), marks: tileMarks[t], specks: tileSpecks[t], frac: r2(tilePx[t] / nv), hf: r2(tileHF[t] / nv) });
      }
    }
    {
      // Merge busy tiles (of either kind) into rectangles; each is labelled by the kind most of its tiles are.
      const busy = new Uint8Array(tw * th);
      let nBusy = 0;
      for (let t = 0; t < tw * th; t++) if (tileFlag[t]) { busy[t] = 1; nBusy++; }
      stats.textureTiles = nBusy;
      const label = (x0, y0, x1, y1) => {
        let foil = 0, all = 0;
        for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) { const v = tileFlag[ty * tw + tx]; if (v) { all++; if (v === 2) foil++; } }
        return foil >= all / 2 ? "Foil / holo texture (sparkle or colour shimmer): marks can't be told apart from the foil here." : "Busy print (text or fine pattern): marks can't be told apart from the print here.";
      };
      const rects = tileRects(busy, tw, th).filter((r) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) >= 2);
      const rect = (x0, y0, x1, y1) => ({ ...toCard(x0 * ts, y0 * ts, Math.min(aw, (x1 + 1) * ts), Math.min(ah, (y1 + 1) * ts)), reason: label(x0, y0, x1, y1) });
      if (rects.length > T.maxTextureRegions) {
        // too fragmented to list: one region around all of it (coarse, but it says where marks can't be judged)
        const u = rects.reduce((a, r) => ({ x0: Math.min(a.x0, r.x0), y0: Math.min(a.y0, r.y0), x1: Math.max(a.x1, r.x1), y1: Math.max(a.y1, r.y1) }));
        cannotAssess.push(rect(u.x0, u.y0, u.x1, u.y1));
      } else for (const r of rects) cannotAssess.push(rect(r.x0, r.y0, r.x1, r.y1));
    }

    // ---- dedupe regions from the edge / corner check (warp px -> analysis px)
    const dedupe = [];
    if (check && Array.isArray(check.overlays)) {
      const pad = T.dedupePadMm * ppm;
      for (const o of check.overlays) {
        if (o.kind !== "edge" && o.kind !== "corner") continue;
        let bx0, by0, bx1, by1;
        if (o.type === "polyline" && Array.isArray(o.points) && o.points.length) {
          bx0 = Math.min(...o.points.map((p) => p[0])); bx1 = Math.max(...o.points.map((p) => p[0]));
          by0 = Math.min(...o.points.map((p) => p[1])); by1 = Math.max(...o.points.map((p) => p[1]));
        } else if (o.w != null) { bx0 = o.x; by0 = o.y; bx1 = o.x + o.w; by1 = o.y + o.h; } else continue;
        dedupe.push([(bx0 - M) / fx - pad, (by0 - M) / fy - pad, (bx1 - M) / fx + pad, (by1 - M) / fy + pad]);
      }
    }

    // ---- sampling helpers
    const at = (A, x, y) => {
      const xi = Math.min(aw - 2, Math.max(1, Math.round(x))), yi = Math.min(ah - 2, Math.max(1, Math.round(y)));
      const i = yi * aw + xi;
      return (A[i] + A[i - 1] + A[i + 1] + A[i - aw] + A[i + aw]) / 5;
    };
    const inside = (x, y) => x >= 1 && y >= 1 && x < aw - 1 && y < ah - 1;

    // ---- classify
    const out = [];
    const dbg = opts.debug ? (stats.debug = []) : null;
    const reject = (why, c, extra) => {
      stats.rejected[why]++;
      if (dbg && c && dbg.length < 400) dbg.push(Object.assign({ why, box: toCard(c.x0, c.y0, c.x1 + 1, c.y1 + 1), n: c.cnt, sign: c.sign, mean: r2(c.mean) }, extra || {}));
    };
    for (let ci = 0; ci < comps.length; ci++) {
      if ((ci & 63) === 0 && timeUp()) return finishCandidates("timeout");
      const c = comps[ci];
      if (c.cnt > maxPx) { reject("irregular", c); continue; }
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      const length = 4 * Math.sqrt(c.l1), rms = Math.sqrt(c.l2);
      const width = c.cnt / Math.max(1, length);
      let kind = null;
      const ux = Math.cos(c.theta), uy = Math.sin(c.theta), nx = -uy, ny = ux;
      if (length / ppm >= T.lineMinMm && length / Math.max(1, width) >= T.lineAspect && rms <= Math.max(T.lineRmsPx, T.lineCurve * length) && width / ppm <= T.lineMaxWidthMm + 2 * ds[1] / ppm) kind = "line";
      else if (Math.max(bw, bh) / ppm <= T.spotMaxMm + 2 * ds[1] / ppm && c.cnt >= T.spotMinPx && length / Math.max(1, width) < T.spotMaxAspect) kind = "spot";
      if (!kind) { reject("irregular", c); continue; }
      if (c.mean < thr * 0.75) { reject("faint", c); continue; }
      if (glareShare(c) >= T.glareShare) { reject("glare", c); continue; }
      // neighbours (other marks within the cluster radius that aren't pieces of the same line)
      let neighbours = 0;
      {
        const gx = Math.floor(c.mx / cr), gy = Math.floor(c.my / cr);
        for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) {
          const list = grid.get(yy * gridW + xx);
          if (!list) continue;
          for (const o of list) {
            if (o === c) continue;
            const ddx = o.mx - c.mx, ddy = o.my - c.my;
            if (ddx * ddx + ddy * ddy > cr * cr) continue;
            if (kind === "line" && Math.abs(ddx * nx + ddy * ny) <= Math.max(3, ds[1] + 1)) continue;  // same line, broken up
            neighbours++;
          }
        }
      }
      const tFlag = tileFlag[Math.floor(c.my / ts) * tw + Math.floor(c.mx / ts)];
      if (neighbours >= T.clusterMax) { reject(tFlag ? "texture" : "cluster", c, { neighbours }); continue; }
      if (tFlag) { reject("texture", c); continue; }
      // the reference shows the same structure: printed
      if (refR) {
        let same = 0;
        for (let k = c.start; k < c.start + c.cnt; k++) if (refR[pix[k]] * c.sign >= T.refStructure * thr) same++;
        if (same / c.cnt >= T.refShare) { reject("reference", c); continue; }
      }
      let contrast = c.mean, reason = "", sizeMm;
      const onBorder = border[Math.round(c.my) * aw + Math.round(c.mx)] === 1;
      if (kind === "line") {
        // sides of the line: the same surface on both sides (a mark on top of it) or two different printed areas?
        const proj = [];
        for (let k = c.start; k < c.start + c.cnt; k++) { const i = pix[k], x = i % aw, y = (i - x) / aw; proj.push((x - c.mx) * ux + (y - c.my) * uy); }
        let tmin = Infinity, tmax = -Infinity;
        for (const p of proj) { if (p < tmin) tmin = p; if (p > tmax) tmax = p; }
        const off = width / 2 + ds[1] + 1, K = 9, dY = [], dC = [], con = [], plateau = [], chroma = [];
        for (let k = 0; k < K; k++) {
          const t = tmin + (tmax - tmin) * (0.1 + 0.8 * (k / (K - 1)));
          const px = c.mx + t * ux, py = c.my + t * uy;
          const ax = px + nx * off, ay = py + ny * off, bx = px - nx * off, by = py - ny * off;
          if (!inside(ax, ay) || !inside(bx, by)) continue;
          const ya = at(YS, ax, ay), yb = at(YS, bx, by), yc = at(YS, px, py);
          dY.push(Math.abs(ya - yb));
          dC.push(Math.abs(at(CB, ax, ay) - at(CB, bx, by)) + Math.abs(at(CR, ax, ay) - at(CR, bx, by)));
          con.push(c.sign * (yc - (ya + yb) / 2));
          chroma.push(Math.hypot(at(CB, px, py), at(CR, px, py)));
          const fa = [px + nx * off * 4, py + ny * off * 4], fb = [px - nx * off * 4, py - ny * off * 4];
          if (inside(...fa) && inside(...fb)) plateau.push(c.sign * ((ya + yb) / 2 - (at(YS, ...fa) + at(YS, ...fb)) / 2));
        }
        if (dY.length < 3) { reject("irregular", c); continue; }
        contrast = median(con);
        if (contrast < thr * 0.75) { reject("faint", c); continue; }
        if (median(dY) > Math.max(T.sideAbs, T.sideRel * contrast) || median(dC) > T.sideChroma) { reject("boundary", c); continue; }
        const span = length / (Math.abs(ux) * aw + Math.abs(uy) * ah);
        const colourless = median(chroma) <= T.reflectChroma;
        if (c.sign > 0 && colourless && span >= (sleeve ? T.reflectSpanSleeve : T.reflectSpan)) { reject("reflection", c); continue; }
        if (c.sign > 0 && plateau.length >= 3 && median(plateau) > T.plateauRel * contrast) { reject("reflection", c); continue; }
        sizeMm = length / ppm;
        reason = `${c.sign > 0 ? "Light" : "Dark"} thin line ${r2(sizeMm)} mm long, ${Math.round(contrast)} levels ${c.sign > 0 ? "lighter" : "darker"} than the surface on both sides`;
      } else {
        // a dot: its surroundings must be plain (one surface), not printed detail
        const rr = Math.max(bw, bh) / 2 + ds[1] + 1, ring = [], ringC = [];
        for (const rad of [rr, rr + 1.5]) for (let k = 0; k < 16; k++) {
          const a = (k / 16) * 2 * Math.PI, x = c.mx + rad * Math.cos(a), y = c.my + rad * Math.sin(a);
          if (!inside(x, y)) continue;
          ring.push(at(YS, x, y)); ringC.push(Math.hypot(at(CB, x, y), at(CR, x, y)));
        }
        if (ring.length < 16) { reject("irregular", c); continue; }
        const mean = ring.reduce((a, b) => a + b, 0) / ring.length;
        const sd = Math.sqrt(ring.reduce((a, b) => a + (b - mean) ** 2, 0) / ring.length);
        const cmean = ringC.reduce((a, b) => a + b, 0) / ringC.length;
        const csd = Math.sqrt(ringC.reduce((a, b) => a + (b - cmean) ** 2, 0) / ringC.length);
        let ext = c.sign > 0 ? -Infinity : Infinity;
        for (let k = c.start; k < c.start + c.cnt; k++) { const v = YS[pix[k]]; if (c.sign > 0 ? v > ext : v < ext) ext = v; }
        contrast = Math.abs(ext - mean);
        if (contrast < thr) { reject("faint", c); continue; }
        if (sd > Math.max(T.ringAbs, T.ringRel * contrast) || csd > Math.max(T.ringAbs, T.ringRel * contrast)) { reject("boundary", c); continue; }
        sizeMm = Math.max(bw, bh) / ppm;
        reason = `${c.sign > 0 ? "Light" : "Dark"} dot about ${r2(Math.max(0.1, sizeMm - 2 * ds[0] / ppm))} mm across, ${Math.round(contrast)} levels ${c.sign > 0 ? "lighter" : "darker"} than its plain surroundings`;
      }
      // already covered by the edge / corner check
      const cx0 = c.x0 - ds[1], cy0 = c.y0 - ds[1], cx1 = c.x1 + 1 + ds[1], cy1 = c.y1 + 1 + ds[1];
      if (dedupe.some((g) => cx0 < g[2] && cx1 > g[0] && cy0 < g[3] && cy1 > g[1])) { reject("deduped", c); continue; }
      let score = clamp01((contrast / thr - 1) / 3);
      score *= 0.6 + 0.4 * (1 - neighbours / T.clusterMax);
      score *= onBorder ? 1 : 0.85;
      if (kind === "line") score *= 0.6 + 0.4 * clamp01(sizeMm / 5);
      if (sleeve) score *= 0.8;
      const soft = q && q.checks && q.checks.sharpness && q.checks.sharpness.status === "warn";
      if (soft) score *= 0.8;
      const types = kind === "line" ? (sizeMm >= T.creaseMinMm ? ["surface_scratch", "print_line", "crease"] : ["surface_scratch", "print_line"]) : ["print_spot"];
      out.push({
        kind, sign: c.sign, score: r2(score), contrast: Math.round(contrast), sizeMm: r2(sizeMm),
        box: [Math.max(0, c.x0 - 1), Math.max(0, c.y0 - 1), Math.min(aw, c.x1 + 2), Math.min(ah, c.y1 + 2)],
        reason: `${reason}${onBorder ? " on the plain printed border" : ""}${sleeve ? "; seen through plastic" : ""}${soft ? "; the photo is slightly soft" : ""}.`,
        types,
      });
    }

    // ---- discoloration on the plain printed border (where colour should be even)
    if (!timeUp()) findStains();
    return finishCandidates("ok");

    function findStains() {
      if (!Object.keys(frame).length) return;
      // Work on blocks of ~0.33 mm: the border's LOCAL colour (masked box mean over stainWindowMm) is the reference,
      // so the smooth gradient of a shadow or of uneven light isn't a stain; a blotch smaller than the window is.
      const b = Math.max(1, Math.round(ppm / 3)), sw = Math.ceil(aw / b), sh = Math.ceil(ah / b), sn = sw * sh;
      const cnt = new Float32Array(sn), sy = new Float32Array(sn), sb = new Float32Array(sn), sr = new Float32Array(sn), rid = new Float32Array(sn), tot = new Float32Array(sn);
      for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
        const i = y * aw + x, j = Math.floor(y / b) * sw + Math.floor(x / b);
        tot[j]++;
        if (!border[i] || CLIP[i]) continue;
        cnt[j]++; sy[j] += YS[i]; sb[j] += CB[i]; sr[j] += CR[i];
        if (Math.abs(R[i]) >= thr) rid[j]++;
      }
      const okB = new Uint8Array(sn);
      let any = 0;
      for (let j = 0; j < sn; j++) if (cnt[j] >= 0.5 * tot[j] && cnt[j] > 0) { okB[j] = 1; any++; sy[j] /= cnt[j]; sb[j] /= cnt[j]; sr[j] /= cnt[j]; }
      if (any < 50) return;
      const m = new Float32Array(sn), my = new Float32Array(sn), mb = new Float32Array(sn), mr = new Float32Array(sn);
      for (let j = 0; j < sn; j++) if (okB[j]) { m[j] = 1; my[j] = sy[j]; mb[j] = sb[j]; mr[j] = sr[j]; }
      const rad = Math.max(3, Math.round((T.stainWindowMm * ppm) / b)), tmp = new Float32Array(sn);
      const Mm = boxMean(m, sw, sh, rad, tmp, new Float32Array(sn)), My = boxMean(my, sw, sh, rad, tmp, new Float32Array(sn));
      const Mb = boxMean(mb, sw, sh, rad, tmp, new Float32Array(sn)), Mr = boxMean(mr, sw, sh, rad, tmp, new Float32Array(sn));
      const dev = new Float32Array(sn);
      for (let j = 0; j < sn; j++) if (okB[j] && Mm[j] > 0) dev[j] = Math.hypot(sy[j] - My[j] / Mm[j], sb[j] - Mb[j] / Mm[j], sr[j] - Mr[j] / Mm[j]);
      const seen = new Uint8Array(sn), stack = new Int32Array(sn);
      const minBlocks = (T.stainMinMm2 * ppm * ppm) / (b * b);
      for (let j0 = 0; j0 < sn; j0++) {
        if (seen[j0] || !okB[j0] || dev[j0] < T.stainDelta) continue;
        let sp = 0, k = 0, ridge = 0, px = 0, x0 = sw, y0 = sh, x1 = 0, y1 = 0, dsum = 0, ysum = 0, csum = 0;
        stack[sp++] = j0; seen[j0] = 1;
        while (sp) {
          const j = stack[--sp], x = j % sw, y = (j - x) / sw;
          k++; dsum += dev[j]; ysum += sy[j] - My[j] / Mm[j]; ridge += rid[j]; px += cnt[j];
          csum += Math.hypot(sb[j], sr[j]) - Math.hypot(Mb[j] / Mm[j], Mr[j] / Mm[j]);
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          const nb = [x > 0 ? j - 1 : -1, x < sw - 1 ? j + 1 : -1, j - sw, j + sw];
          for (let q4 = 0; q4 < 4; q4++) {
            const jj = nb[q4];
            if (jj < 0 || jj >= sn || seen[jj] || !okB[jj] || dev[jj] < T.stainDelta * 0.6) continue;
            seen[jj] = 1; stack[sp++] = jj;
          }
        }
        if (k < minBlocks) continue;
        const box = [Math.max(0, x0 * b - 1), Math.max(0, y0 * b - 1), Math.min(aw, (x1 + 1) * b + 1), Math.min(ah, (y1 + 1) * b + 1)];
        const sizeMm = Math.max(box[2] - box[0], box[3] - box[1]) / ppm;
        const fake = { x0: box[0], y0: box[1], x1: box[2] - 1, y1: box[3] - 1, cnt: px, sign: ysum >= 0 ? 1 : -1, mean: dsum / k };
        if (sizeMm <= T.spotMaxMm) continue;  // dots are handled above
        if (ridge / Math.max(1, px) > T.stainMaxRidge) { reject("boundary", fake, { kind: "discoloration" }); continue; }  // printed text / sharp detail
        if (inGlare(box[0], box[1], box[2], box[3])) { reject("glare", fake); continue; }
        // lighter AND greyer than the border around it: light reflected off the surface (sleeve, sheen), not a stain
        if (ysum > 0 && csum < 0 && -csum / k >= 0.25 * (dsum / k)) { reject("reflection", fake, { kind: "discoloration" }); continue; }
        if (dedupe.some((g) => box[0] < g[2] && box[2] > g[0] && box[1] < g[3] && box[3] > g[1])) { reject("deduped", fake); continue; }
        const delta = dsum / k;
        const score = clamp01((delta / T.stainDelta - 1) / 2) * (sleeve ? 0.8 : 1);
        out.push({
          kind: "discoloration", sign: fake.sign, score: r2(score), contrast: Math.round(delta), sizeMm: r2(sizeMm), box,
          reason: `A ${r2(sizeMm)} mm patch of the plain printed border is a different colour from the border around it (${Math.round(delta)} levels).`,
          types: ["stain"],
        });
        if (out.length > 4 * Math.max(1, maxC) + 20) break;
      }
    }

    function finishCandidates(status) {
      out.sort((a, b) => b.score - a.score || a.box[1] - b.box[1] || a.box[0] - b.box[0]);
      stats.truncated = Math.max(0, out.length - maxC);
      const kept = out.slice(0, maxC);
      const candidates = kept.map((m, k) => ({
        id: `${side || "card"}-r${revision}-m${k + 1}`, side, revision,
        method: m.kind === "discoloration" ? "border-colour-v1" : "local-ridge-v1",
        kind: m.kind, ...toCard(...m.box),
        score: m.score, detection: m.score >= T.detHigh ? "high" : m.score >= T.detMedium ? "medium" : "low",
        detectionNote: "Uncalibrated heuristic strength from contrast and surroundings, not a probability: precision on real photos is unmeasured.",
        reason: m.reason, suggestedTypes: m.types, status: "pending",
        contrast: m.contrast, ...(m.kind === "line" ? { lengthMm: m.sizeMm } : { sizeMm: m.sizeMm }),
      }));
      const parts = [];
      if (status === "timeout") parts.push(timeoutNote());
      parts.push(candidates.length ? `${candidates.length} possible surface mark${candidates.length > 1 ? "s" : ""} to check by eye (experimental, uncalibrated)${stats.truncated ? `; ${stats.truncated} weaker one${stats.truncated > 1 ? "s" : ""} not shown` : ""}.`
        : "No surface marks stood out in this photo. That isn't evidence of a clean surface: scratches, dents and gloss loss often only show under angled light.");
      if (cannotAssess.length) parts.push(`${cannotAssess.length} area${cannotAssess.length > 1 ? "s" : ""} can't be assessed (${[...new Set(cannotAssess.map((r) => r.reason.split(/[:(]/)[0].trim().toLowerCase()))].join(", ")}).`);
      parts.push("Suggestions only: nothing is added to the grade unless you confirm it.");
      return finish(status, candidates, cannotAssess, parts.join(" ") + refNote);
    }
  }

  return { filter, compareReference, findMarks, KINDS, THRESHOLDS: T };
});
