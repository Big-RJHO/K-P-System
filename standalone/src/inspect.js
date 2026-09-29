/*
 * Photo-quality gate and edge / corner wear candidates, on top of vision.js.
 *
 * Works on a Vision.scan result: the card flattened to CARD_W x CARD_H (63 x 88 mm at ~300 dpi) with
 * `margin` px of photo around it, so the card's physical edge sits at x = margin and x = width-1-margin
 * (likewise for y). Plain RGBA buffers, no DOM, so it runs in the browser and in Node for tests.
 *
 *   quality(img, scan)        can this photo support centering / edge / corner checks, and what to fix
 *   edgesAndCorners(scan, o)  candidate edge whitening and corner wear, with overlay geometry
 *
 * Results are candidates for a person to confirm by eye, never a clean bill of health: a phone photo can
 * miss wear, and glare, a sleeve or light printing near the edge can look like wear.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Inspect = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SIDES = ["top", "right", "bottom", "left"];                       // edge positions run left->right / top->bottom
  const CORNERS = ["top_left", "top_right", "bottom_right", "bottom_left"];  // same order as scan.corners (after un-rotating)
  const CARD_MM = [63, 88];
  const CORNER_R = 0.048;  // corner radius as a fraction of the card's width (vision.js uses the same)

  /*
   * Thresholds. All of these are PROPOSALS: tuned by hand on synthetic cards (tests/synthetic.py) and on
   * the only two real photos we have (a sleeved Riftbound card on a laptop, front and back, phone camera).
   * None were fitted to a labelled set of graded cards, so the severity cut-offs in particular are a
   * starting point, not evidence. Lab is on its natural scale here: L 0..100, a/b signed, C = hypot(a, b).
   */
  const T = {
    // Sharpness: estimated blur (Gaussian sigma, px of the flattened 300 dpi card) of the sharpest edges.
    // Measured: synthetic cards 0.3, the two real photos 0.5-0.55; synthetic photos blurred by sigma 1.5 /
    // 2 / 3 px read 1.25 / 1.5 / 2.25 (the sharpest edges soften less than the blur applied).
    blurOk: 1.3, blurFail: 2.0,
    minEdgePixels: 150,      // fewer strong edges than this: can't judge focus
    edgeContrast: 25,        // an edge must span at least this much L within +-5 px to be used
    // Glare: clipped highlight = near-white and colourless (RGB ~252+). Printed white is rarely this bright.
    glareL: 98.5, glareC: 6,
    glareZone: 0.02,         // clipped fraction of an edge band / corner patch that blocks assessing it
    glareCardWarn: 0.01, glareCardFail: 0.15,
    glareBand: 24,           // edge band depth (px in from the edge) the glare check looks at
    // Resolution: the card's short side in photo pixels. 600 px ~ 9.5 px/mm, whitening ~0.2 mm is ~2 px.
    resWarn: 600, resFail: 350,
    // Boundary: corners closer than this to the photo's edge (fraction of the photo's short side) are too tight.
    boundaryPad: 0.01, cutOffPx: 2,
    // Perspective: keystone = relative length difference of opposite sides; aspect vs 88/63.
    keystoneWarn: 0.06, keystoneFail: 0.15, aspectWarn: 0.04, aspectFail: 0.08, angleWarn: 8,
    // Card detection confidence (scan.confidence.card). Real photos give 0.86-0.92, clean synthetic ~0.9+.
    detectWarn: 0.7, detectFail: 0.5,
    // Rounded-corner test on the outline (as in vision.js): below this a corner doesn't look like a card's.
    roundedMin: 0.1,
    // Sleeve: a line parallel to the card edge in the margin, on at least this many sides.
    sleeveStep: 8, sleeveSides: 2,

    // Edges (px of the flattened card; 1 mm ~ 11.9 px).
    band0: 1, band1: 14,     // whitening band: depth in from the physical edge
    startBy: 3,              // whitening must start within this many px of the edge (printing further in doesn't count)
    ref0: 16, ref1: 28,      // local border colour: depth range ...
    refHalf: 20,             // ... and +- px along the edge
    whiteScore: 18,          // stock-like: (L - L_ref) + 0.5 * (C_ref - C) at least this
    stockL: 45, stockC: 18,  // and the pixel itself light and near-colourless
    headroom: 35,            // bare stock (L 95, C 3) would score less than this against the border: too light to judge
    lightSide: 0.5,          // fraction of an edge too light -> the whole side is not assessable
    minPixels: 2,            // whitening pixels at one position along the edge
    gap: 2, minRun: 3,       // merge runs across gaps; ignore shorter runs
    edgeSearch: 5,           // px either way to look for the true edge line
    candidateConf: 0.4,      // below this a run is shown greyed out and not offered as a DING
    // Severity from length along the edge and depth into the card (mm), same scale for corner whitening.
    sev: { major: [15, 1.0], moderate: [5, 0.6], minor: [1.5, 0.35] },
    // Corners
    rayStep: 3,              // degrees between rays across the rounded corner
    roundExcess: [0.35, 0.8, 1.5, 3.0],  // mm of extra radius for micro / minor / moderate / major softening
    roughPx: 3,              // MAD of the corner outline (px) above which it is called rough / frayed
  };

  /* ---------------------------------------------------------------- colour */

  const SRGB_TO_LINEAR = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function labF(t) {
    return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  }

  /** RGBA -> Lab on the natural scale (L 0..100, a/b signed), as Float32Array [L,a,b,...]. */
  function toLab(img) {
    const n = img.width * img.height;
    const out = new Float32Array(n * 3);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      const r = SRGB_TO_LINEAR[d[i * 4]], g = SRGB_TO_LINEAR[d[i * 4 + 1]], b = SRGB_TO_LINEAR[d[i * 4 + 2]];
      const x = (0.412453 * r + 0.35758 * g + 0.180423 * b) / 0.950456;
      const y = 0.212671 * r + 0.71516 * g + 0.072169 * b;
      const z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / 1.088754;
      const fx = labF(x), fy = labF(y), fz = labF(z);
      out[i * 3] = y > 0.008856 ? 116 * fy - 16 : 903.3 * y;
      out[i * 3 + 1] = 500 * (fx - fy);
      out[i * 3 + 2] = 200 * (fy - fz);
    }
    return out;
  }

  /* ---------------------------------------------------------------- stats */

  function median(arr) {
    if (!arr.length) return NaN;
    const s = Float64Array.from(arr).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function percentile(arr, p) {
    if (!arr.length) return NaN;
    const s = Float64Array.from(arr).sort();
    const pos = (s.length - 1) * (p / 100), lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  const r3 = (v) => Math.round(v * 1000) / 1000;

  // least squares for u = a*v + b; points are [v, u]
  function fitLine(points) {
    const n = points.length;
    if (n < 2) return null;
    let sv = 0, su = 0, svv = 0, svu = 0;
    for (const [v, u] of points) { sv += v; su += u; svv += v * v; svu += v * u; }
    const den = n * svv - sv * sv;
    if (Math.abs(den) < 1e-9) return null;
    const a = (n * svu - sv * su) / den;
    return { a, b: (su - a * sv) / n };
  }

  // Keep points close to the line (drops a whitened stretch that moved one block's edge), then refit.
  function robustFit(points) {
    let line = fitLine(points);
    if (!line) return null;
    for (let iter = 0; iter < 2; iter++) {
      const res = points.map(([v, u]) => Math.abs(u - (line.a * v + line.b)));
      const tol = Math.max(1, 2.5 * median(res));
      const next = fitLine(points.filter((_, i) => res[i] <= tol));
      if (!next) break;
      line = next;
    }
    return line;
  }

  /* ---------------------------------------------------------------- image ops */

  function blur3(img) {
    const { width: w, height: h, data: d } = img;
    const tmp = new Float32Array(w * h * 3), out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = Math.max(0, x - 1), r = Math.min(w - 1, x + 1);
        for (let c = 0; c < 3; c++) {
          tmp[(y * w + x) * 3 + c] = (d[(y * w + l) * 4 + c] + 2 * d[(y * w + x) * 4 + c] + d[(y * w + r) * 4 + c]) / 4;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      const u = Math.max(0, y - 1), dn = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          out[(y * w + x) * 4 + c] = (tmp[(u * w + x) * 3 + c] + 2 * tmp[(y * w + x) * 3 + c] + tmp[(dn * w + x) * 3 + c]) / 4;
        }
        out[(y * w + x) * 4 + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }

  // Lab of the flattened card, computed once per scan (quality and edgesAndCorners both need it).
  const labCache = new WeakMap();
  function labFor(scan, blurred) {
    let c = labCache.get(scan.warped);
    if (!c) { c = {}; labCache.set(scan.warped, c); }
    const key = blurred ? "blurred" : "raw";
    if (!c[key]) c[key] = toLab(blurred ? blur3(scan.warped) : scan.warped);
    return c[key];
  }

  /* ---------------------------------------------------------------- card geometry */

  function geom(scan) {
    const W = scan.width, H = scan.height, M = scan.margin;
    const cw = W - 2 * M, ch = H - 2 * M;
    return { W, H, M, cw, ch, R: CORNER_R * cw, pxPerMm: cw / CARD_MM[0] };
  }

  const sideLen = (g, side) => (side === "top" || side === "bottom" ? g.cw : g.ch);

  // Pixel (x, y) at position t along a side and depth d in from the card's physical edge (d < 0 = outside).
  function sideXY(g, side, t, d) {
    switch (side) {
      case "top": return [g.M + t, g.M + d];
      case "bottom": return [g.M + t, g.H - 1 - g.M - d];
      case "left": return [g.M + d, g.M + t];
      default: return [g.W - 1 - g.M - d, g.M + t];
    }
  }

  // Pixel (x, y) at (u, v) in a corner's own frame: u in from the vertical edge, v in from the horizontal edge.
  function cornerXY(g, ci, u, v) {
    return [ci === 0 || ci === 3 ? g.M + u : g.W - 1 - g.M - u, ci < 2 ? g.M + v : g.H - 1 - g.M - v];
  }

  const pixAt = (g, x, y) => Math.min(g.H - 1, Math.max(0, Math.round(y))) * g.W + Math.min(g.W - 1, Math.max(0, Math.round(x)));
  const sidePix = (g, side, t, d) => { const [x, y] = sideXY(g, side, t, d); return pixAt(g, x, y); };

  // Channel-wise median colour of the pixels `idx`, as {L, a, b, C}.
  function medLab(lab, idx) {
    const n = idx.length, v = new Float32Array(n);
    const out = [];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) v[i] = lab[idx[i] * 3 + c];
      v.sort();
      out.push(n % 2 ? v[n >> 1] : (v[(n >> 1) - 1] + v[n >> 1]) / 2);
    }
    return { L: out[0], a: out[1], b: out[2], C: Math.hypot(out[1], out[2]) };
  }

  const dE = (p, q) => Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
  const colorAt = (lab, i) => ({ L: lab[i * 3], a: lab[i * 3 + 1], b: lab[i * 3 + 2], C: Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]) });

  // How much closer to bare white card stock a colour is than the border: lighter, and less colourful.
  // A yellow border (L 85, C 75) and a navy one (L 20, C 30) both score ~45-65 for exposed stock.
  const whiteScore = (L, C, ref) => (L - ref.L) + 0.5 * (ref.C - C);
  const stockLike = (L, C, ref) => L - ref.L >= 4 && L >= T.stockL && C <= Math.max(T.stockC, 0.6 * ref.C) && whiteScore(L, C, ref) >= T.whiteScore;
  const headroomOf = (ref) => whiteScore(95, 3, ref);
  const clipped = (L, C) => L >= T.glareL && C <= T.glareC;

  function severityOf(lengthMm, depthMm) {
    for (const s of ["major", "moderate", "minor"]) if (lengthMm >= T.sev[s][0] || depthMm >= T.sev[s][1]) return s;
    return "micro";
  }
  const SEV_RANK = { micro: 1, minor: 2, moderate: 3, major: 4 };

  /** Photo corners (TL, TR, BR, BL of the found outline) in the flattened card's orientation (vision.warpMatrix). */
  function uprightCorners(corners) {
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const [tl, tr, br, bl] = corners;
    const width = (d(tr, tl) + d(br, bl)) / 2, height = (d(bl, tl) + d(br, tr)) / 2;
    return width > height ? [bl, tl, tr, br] : [tl, tr, br, bl];
  }

  /* ---------------------------------------------------------------- sleeve */

  /**
   * A sleeve (or top loader) shows up as a straight line parallel to the card's edge a little way outside
   * it. Per side, take the median colour profile across the margin along the middle 70% of the edge (a
   * median over hundreds of positions wipes out background texture, only a parallel line survives) and
   * look for a colour step or a thin line in it.
   */
  function detectSleeve(lab, g) {
    const sides = {};
    let count = 0;
    for (const side of SIDES) {
      const len = sideLen(g, side), dMin = -g.M + 2, dMax = -5;
      const prof = [];
      for (let d = dMin; d <= dMax; d++) {
        const idx = [];
        for (let t = Math.round(len * 0.15); t < len * 0.85; t += 6) idx.push(sidePix(g, side, t, d));
        prof.push(medLab(lab, idx));
      }
      const mean = (i0, i1) => {
        const m = { L: 0, a: 0, b: 0 };
        for (let i = i0; i <= i1; i++) { m.L += prof[i].L; m.a += prof[i].a; m.b += prof[i].b; }
        const n = i1 - i0 + 1;
        return { L: m.L / n, a: m.a / n, b: m.b / n };
      };
      let best = 0, at = null;
      for (let i = 4; i < prof.length - 4; i++) {
        const step = dE(mean(i - 4, i - 1), mean(i + 1, i + 4));
        const line = dE(prof[i], mean(i - 4, i - 4)) + dE(prof[i], mean(i + 4, i + 4));
        const v = Math.max(step, line / 2);
        if (v > best) { best = v; at = i + dMin; }
      }
      const found = best >= T.sleeveStep;
      if (found) count++;
      sides[side] = { found, strength: r1(best), distance_px: at === null ? null : -at };
    }
    return { found: count >= T.sleeveSides, sides };
  }

  /* ---------------------------------------------------------------- quality: sharpness */

  const erf = (x) => {  // Abramowitz-Stegun 7.1.26
    const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
    return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
  };
  // For a step edge blurred by a Gaussian of `sigma` px: central-difference slope / contrast within +-5 px.
  const stepRatio = (sigma) => erf(1 / (sigma * Math.SQRT2)) / 2 / erf(5 / (sigma * Math.SQRT2));
  const SIGMAS = [];
  for (let s = 0.3; s <= 8; s += 0.05) SIGMAS.push([s, stepRatio(s)]);
  const sigmaOf = (ratio) => { for (const [s, r] of SIGMAS) if (r <= ratio) return s; return 8; };

  /**
   * Focus as the blur width of the photo's sharpest edges, not as the raw variance of a Laplacian.
   * The Laplacian's variance mostly measures how much detail the artwork has, so a flat, soft painting
   * looks "blurry" and a busy one looks sharp. Instead, at every strong edge (local slope maximum with
   * at least T.edgeContrast of L within +-5 px) divide the slope by that edge's own contrast. For a step
   * blurred by a Gaussian this ratio depends only on the blur, so it is converted to an equivalent
   * sigma in px of the 300 dpi flattened card (0.3 = as sharp as it can read). The 90th percentile (the
   * sharpest 10% of edges: text, frame lines) is used, since artwork is often soft on purpose. The card's
   * own outline is left out (6 px inset): a sleeve's lip or the background can soften it.
   */
  function sharpness(lab, g) {
    const W = g.W, L = (x, y) => lab[(y * W + x) * 3];
    const ratios = [];
    for (let y = g.M + 6; y < g.H - g.M - 6; y++) {
      for (let x = g.M + 6; x < W - g.M - 6; x++) {
        const gx = (L(x + 1, y) - L(x - 1, y)) / 2, gy = (L(x, y + 1) - L(x, y - 1)) / 2;
        const ax = Math.abs(gx), ay = Math.abs(gy);
        if (Math.max(ax, ay) < 3) continue;
        let lo = Infinity, hi = -Infinity, slope;
        if (ax >= ay) {
          if (Math.abs(L(x + 2, y) - L(x, y)) / 2 > ax || Math.abs(L(x, y) - L(x - 2, y)) / 2 > ax) continue;
          for (let k = -5; k <= 5; k++) { const v = L(x + k, y); if (v < lo) lo = v; if (v > hi) hi = v; }
          slope = ax;
        } else {
          if (Math.abs(L(x, y + 2) - L(x, y)) / 2 > ay || Math.abs(L(x, y) - L(x, y - 2)) / 2 > ay) continue;
          for (let k = -5; k <= 5; k++) { const v = L(x, y + k); if (v < lo) lo = v; if (v > hi) hi = v; }
          slope = ay;
        }
        if (hi - lo < T.edgeContrast) continue;
        ratios.push(slope / (hi - lo));
      }
    }
    if (ratios.length < T.minEdgePixels) return { blur: null, edges: ratios.length };
    return { blur: sigmaOf(percentile(ratios, 90)), edges: ratios.length };
  }

  /**
   * Does each corner of the outline look like a card's rounded corner? The small patch cut off by the
   * rounding should look like what is outside the card, not like the card (vision.js's cornerRoundness,
   * on the flattened card). A card cut off by the photo's edge, or an outline on a printed frame, fails.
   * Returns one score per corner in [-1, 1]; +1 = clearly a rounded card corner.
   */
  function roundedCorners(lab, g) {
    const R = g.R, q = Math.max(2, Math.round(R * 0.3));
    const out = [];
    for (let ci = 0; ci < 4; ci++) {
      const at = (u, v) => { const [x, y] = cornerXY(g, ci, u, v); return pixAt(g, x, y); };
      const cut = [], inV = [], outV = [], inH = [], outH = [];
      for (let u = 2; u <= q; u++) for (let v = 2; v <= q; v++) if ((R - u) ** 2 + (R - v) ** 2 > 1.2 * R * R) cut.push(at(u, v));
      for (let a = 0.6 * R; a <= 1.8 * R; a += 1.5) {
        for (let d = 6; d <= 20; d += 3) { inV.push(at(d, a)); outV.push(at(-d, a)); inH.push(at(a, d)); outH.push(at(a, -d)); }
      }
      if (cut.length < 3) { out.push(0); continue; }
      const C = medLab(lab, cut);
      const one = (I, O) => { I = medLab(lab, I); O = medLab(lab, O); return (dE(C, I) - dE(C, O)) / Math.max(dE(I, O), 6); };
      out.push(Math.max(-1, Math.min(1, (one(inV, outV) + one(inH, outH)) / 2)));
    }
    return out;
  }

  /* ---------------------------------------------------------------- quality */

  const pretty = (s) => s.replace("_", "-");
  const listText = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

  /**
   * Scan-quality gate. `img` is the original photo (RGBA), `scan` the Vision.scan result for it.
   * Returns {verdict: "ok" | "warn" | "rescan", checks: {name: {value, status: "ok"|"warn"|"fail", note}},
   * blocked: ["edges:top", "corners:top_right", "centering", "surface", ...], blocked_reasons: {item: [check]},
   * overlays: [...]} where `blocked` lists what these problems prevent assessing and every note says what
   * to do about it. "rescan": retake the photo before trusting anything; "warn": usable, but see `blocked`.
   */
  function quality(img, scan) {
    const g = geom(scan);
    const lab = labFor(scan, false);
    const checks = {}, reasons = {};
    const overlays = [];
    const block = (item, why) => { (reasons[item] = reasons[item] || []).includes(why) || reasons[item].push(why); };
    const allEdges = SIDES.map((s) => `edges:${s}`), allCorners = CORNERS.map((c) => `corners:${c}`);

    // Sharpness
    const sh = sharpness(lab, g);
    if (sh.blur === null) {
      checks.sharpness = { value: null, status: "warn", note: "Too little fine detail on the card to judge focus. Make sure the card is in focus (tap on it) before relying on edge checks." };
    } else {
      const b = r2(sh.blur);
      const status = b <= T.blurOk ? "ok" : b <= T.blurFail ? "warn" : "fail";
      const note = status === "ok" ? `Sharp enough (edges blurred by ~${b} px).`
        : status === "warn" ? `Slightly soft (edges blurred by ~${b} px): fine whitening under ~0.3 mm can be missed. Hold the phone steady, tap the card to focus and add light.`
        : `Blurry (edges blurred by ~${b} px): edge and corner wear can't be judged. Hold the phone steady, tap the card to focus and add light, then retake.`;
      checks.sharpness = { value: b, status, note, edges_used: sh.edges };
      if (status === "fail") { [...allEdges, ...allCorners, "surface"].forEach((i) => block(i, "sharpness")); }
    }

    // Glare: clipped, colourless highlights, overall and per edge band / corner patch.
    const zone = {}, zoneN = {};
    for (const z of [...SIDES, ...CORNERS]) { zone[z] = 0; zoneN[z] = 0; }
    const BIN = 16, bins = {};
    for (const s of SIDES) bins[s] = new Uint16Array(Math.ceil(sideLen(g, s) / BIN) + 1);
    let total = 0, clippedN = 0;
    const R = g.R, cz = R + 16, rr = R * R;
    for (let y = g.M; y < g.H - g.M; y++) {
      const dy = y - g.M, dyr = g.H - 1 - g.M - y, ey = Math.min(dy, dyr);
      for (let x = g.M; x < g.W - g.M; x++) {
        const dx = x - g.M, dxr = g.W - 1 - g.M - x, ex = Math.min(dx, dxr);
        if (ex < R && ey < R && (R - ex) ** 2 + (R - ey) ** 2 > rr) continue;  // outside the rounded corner
        const i = y * g.W + x;
        const isClip = clipped(lab[i * 3], Math.hypot(lab[i * 3 + 1], lab[i * 3 + 2]));
        total++;
        if (isClip) clippedN++;
        let z = null;
        if (ex < cz && ey < cz) z = CORNERS[dy < dyr ? (dx < dxr ? 0 : 1) : (dx < dxr ? 3 : 2)];
        else if (ey < T.glareBand) z = dy < dyr ? "top" : "bottom";
        else if (ex < T.glareBand) z = dx < dxr ? "left" : "right";
        if (!z) continue;
        zoneN[z]++;
        if (isClip) {
          zone[z]++;
          if (z === "top" || z === "bottom") bins[z][Math.floor(dx / BIN)]++;
          else if (z === "left" || z === "right") bins[z][Math.floor(dy / BIN)]++;
        }
      }
    }
    const where = {}, glareSpots = [];
    for (const z of Object.keys(zone)) {
      where[z] = r3(zoneN[z] ? zone[z] / zoneN[z] : 0);
      if (where[z] >= T.glareZone) {
        glareSpots.push(z);
        block(SIDES.includes(z) ? `edges:${z}` : `corners:${z}`, "glare");
      }
    }
    for (const s of SIDES) {  // overlay: stretches of edge band with glare
      const len = sideLen(g, s);
      for (let k = 0; k < bins[s].length; k++) {
        if (bins[s][k] < 0.05 * BIN * T.glareBand) continue;
        const t0 = k * BIN, t1 = Math.min(len, t0 + BIN);
        const [xa, ya] = sideXY(g, s, t0, 0), [xb, yb] = sideXY(g, s, t1, T.glareBand);
        overlays.push({ type: "rect", kind: "glare", x: Math.min(xa, xb), y: Math.min(ya, yb), w: Math.abs(xb - xa), h: Math.abs(yb - ya), label: "glare" });
      }
    }
    const frac = total ? clippedN / total : 0;
    {
      const status = frac >= T.glareCardFail ? "fail" : glareSpots.length || frac >= T.glareCardWarn ? "warn" : "ok";
      const spots = glareSpots.map((z) => (SIDES.includes(z) ? `${z} edge` : `${pretty(z)} corner`));
      let note;
      if (status === "ok") note = "No clipped glare on the card.";
      else if (spots.length) note = `Glare on the ${listText(spots)} hides wear there. Move the light (or tilt the card slightly) so it doesn't reflect off ${spots.length > 1 ? "those areas" : "that area"}; with a sleeve, take the card out.`;
      else note = `Glare covers ${r1(frac * 100)}% of the card. Move the light so it doesn't reflect off the card.`;
      if (status === "fail") { block("surface", "glare"); block("centering", "glare"); }
      checks.glare = { value: r3(frac), status, note, where };
    }

    // Resolution: the card's short side in photo pixels.
    const [tl, tr, br, bl] = uprightCorners(scan.corners);
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const top = dist(tl, tr), bottom = dist(bl, br), left = dist(tl, bl), right = dist(tr, br);
    const cardPx = Math.min((top + bottom) / 2, (left + right) / 2);
    {
      const v = Math.round(cardPx);
      const status = v < T.resFail ? "fail" : v < T.resWarn ? "warn" : "ok";
      const perMm = r1(v / CARD_MM[0]);
      const note = status === "ok" ? `Card is ${v} px wide in the photo (${perMm} px/mm).`
        : `Card is only ${v} px wide in the photo (${perMm} px/mm); edges and corners need at least ${T.resWarn}. Move closer so the card fills most of the frame.`;
      checks.resolution = { value: v, status, note, px_per_mm: perMm };
      if (status !== "ok") [...allEdges, ...allCorners].forEach((i) => block(i, "resolution"));
      if (status === "fail") block("surface", "resolution");
    }

    // Boundary: all four corners inside the photo with some room.
    {
      const w = img.width, h = img.height, pad = Math.max(4, T.boundaryPad * Math.min(w, h));
      const up = [tl, tr, br, bl];
      const inset = up.map(([x, y]) => Math.min(x, y, w - 1 - x, h - 1 - y));
      const fullFrame = scan.corners.every(([x, y]) => (x < 1.5 || x > w - 2.5) && (y < 1.5 || y > h - 2.5));
      const photoAspect = Math.max(w, h) / Math.min(w, h), cardAspect = CARD_MM[1] / CARD_MM[0];
      const croppedScan = fullFrame && Math.abs(photoAspect - cardAspect) / cardAspect < 0.025;
      const round = fullFrame ? [1, 1, 1, 1] : roundedCorners(lab, g);
      const square = CORNERS.filter((_, i) => round[i] < T.roundedMin);
      const cut = [], tight = [];
      inset.forEach((v, i) => { if (v < T.cutOffPx) cut.push(i); else if (v < pad) tight.push(i); });
      let status = "ok", note = "The whole card is in the photo with room around it.";
      if (croppedScan) {
        status = "warn";
        note = "The photo is cropped right to the card, so the edges can't be compared with the background and a trimmed edge can't be seen. For edge and corner checks, leave a little background around the card.";
      } else if (fullFrame) {
        status = "fail";
        note = "The card wasn't found inside the photo: it may be cut off or too close. Move back so the whole card is in the frame with a little background around it.";
        ["centering", ...allEdges, ...allCorners].forEach((i) => block(i, "boundary"));
      } else if (cut.length) {
        status = "fail";
        note = `The card is cut off at the ${listText(cut.map((i) => pretty(CORNERS[i])))} corner${cut.length > 1 ? "s" : ""}. Move back so the whole card is in the frame with a little background around it.`;
        for (const i of cut) {
          block(`corners:${CORNERS[i]}`, "boundary");
          block(`edges:${SIDES[i]}`, "boundary");            // side from corner i to i+1
          block(`edges:${SIDES[(i + 3) % 4]}`, "boundary");  // side ending at corner i
        }
        block("centering", "boundary");
      } else if (tight.length) {
        status = "warn";
        note = `The ${listText(tight.map((i) => pretty(CORNERS[i])))} corner${tight.length > 1 ? "s are" : " is"} right at the photo's edge. Leave a little background around the card.`;
        for (const i of tight) block(`corners:${CORNERS[i]}`, "boundary");
      }
      // A found outline whose corners aren't rounded like a card's is probably not the card's own edge:
      // part of the card is outside the photo, or the outline is on a printed frame.
      if (status === "ok" && square.length >= 2) {
        status = square.length >= 3 ? "fail" : "warn";
        note = `The outline's ${listText(square.map(pretty))} corner${square.length > 1 ? "s don't" : " doesn't"} look like a card's rounded corners: the card may be cut off, or the outline sits on a printed frame. Check the outline on the photo, or retake with the whole card in the frame and a little background around it.`;
        for (const c of square) block(`corners:${c}`, "boundary");
        if (status === "fail") ["centering", ...allEdges].forEach((i) => block(i, "boundary"));
      }
      checks.boundary = { value: r1(Math.min(...inset)), status, note, rounded_corners: round.map(r2) };
    }

    // Perspective: keystone (opposite sides differ), aspect vs 63 x 88 and corner angles.
    {
      const keystone = Math.max(Math.abs(top - bottom) / Math.max(top, bottom), Math.abs(left - right) / Math.max(left, right));
      const aspect = ((left + right) / 2) / ((top + bottom) / 2);
      const aspectErr = Math.abs(aspect / (CARD_MM[1] / CARD_MM[0]) - 1);
      const up = [tl, tr, br, bl];
      const angles = up.map((p, i) => {
        const a = up[(i + 3) % 4], b = up[(i + 1) % 4];
        const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [b[0] - p[0], b[1] - p[1]];
        return (Math.acos((v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2))) * 180) / Math.PI;
      });
      const angleErr = Math.max(...angles.map((a) => Math.abs(a - 90)));
      const frame = scan.corners.every(([x, y]) => (x < 1.5 || x > img.width - 2.5) && (y < 1.5 || y > img.height - 2.5));
      const status = frame ? "ok" : keystone > T.keystoneFail || aspectErr > T.aspectFail ? "fail"
        : keystone > T.keystoneWarn || aspectErr > T.aspectWarn || angleErr > T.angleWarn ? "warn" : "ok";
      const note = frame ? "Not measured: the outline is the photo's own frame." : status === "ok" ? "The phone was held square to the card."
        : `The phone was tilted (opposite sides differ by ${r1(keystone * 100)}%, shape off by ${r1(aspectErr * 100)}%). Hold the phone parallel to the card, directly above it.${status === "fail" ? " At this angle the card's cut edge shows along one side and looks like whitening." : ""}`;
      checks.perspective = { value: r3(keystone), status, note, aspect_error: r3(aspectErr), angle_error: r1(angleErr) };
      if (status === "fail") [...allEdges, ...allCorners].forEach((i) => block(i, "perspective"));
    }

    // Card detection confidence
    {
      const c = scan.confidence && scan.confidence.card != null ? scan.confidence.card : 0;
      const status = c < T.detectFail ? "fail" : c < T.detectWarn ? "warn" : "ok";
      const note = status === "ok" ? "Card outline found clearly."
        : "The card's outline is uncertain. Check the outline on the photo and drag it onto the card's edges, or retake on a plain background that contrasts with the card's border.";
      checks.detection = { value: c, status, note };
      if (status === "fail") ["centering", ...allEdges, ...allCorners].forEach((i) => block(i, "detection"));
    }

    // Sleeve / holder (doesn't block, but edges are only seen through plastic)
    {
      const sl = detectSleeve(labFor(scan, true), g);
      checks.sleeve = {
        value: sl.found,
        status: sl.found ? "warn" : "ok",
        note: sl.found ? "The card seems to be in a sleeve or holder. Edges and corners are only seen through plastic and its reflections; take the card out of the sleeve for edge and corner checks."
          : "No sleeve edge seen around the card.",
        sides: sl.sides,
      };
    }

    const statuses = Object.values(checks).map((c) => c.status);
    const verdict = statuses.includes("fail") ? "rescan" : statuses.includes("warn") ? "warn" : "ok";
    const order = ["centering", "surface", ...allEdges, ...allCorners];
    const blocked = order.filter((i) => reasons[i]);
    return { verdict, checks, blocked, blocked_reasons: reasons, overlays };
  }

  /* ---------------------------------------------------------------- edges */

  /**
   * One side: where exactly the card's edge is, the local border colour along it, and the positions where
   * a thin band just inside the edge is much closer to bare white stock than that border colour.
   */
  function analyseSide(lab, g, scan, side, printedMask) {
    const len = sideLen(g, side), R = g.R;
    const tA = Math.ceil(R + 8), tB = Math.floor(len - R - 8);  // skip the rounded-corner arcs

    // The true edge line, to within a pixel: per 32 px block, the depth of the strongest colour step
    // across the edge (median profile over the block), then a robust straight line through the blocks.
    const pts = [];
    for (let t0 = tA; t0 + 32 <= tB; t0 += 32) {
      const prof = [];
      for (let d = -T.edgeSearch - 3; d <= T.edgeSearch + 3; d++) {
        const idx = [];
        for (let t = t0; t < t0 + 32; t += 2) idx.push(sidePix(g, side, t, d));
        prof.push(medLab(lab, idx));
      }
      let best = 0, at = 0;
      for (let d = -T.edgeSearch; d <= T.edgeSearch; d++) {
        const i = d + T.edgeSearch + 3;
        const a = prof[i - 1], b = prof[i], a2 = prof[i - 2], b2 = prof[i + 1];
        const s = dE({ L: (a.L + a2.L) / 2, a: (a.a + a2.a) / 2, b: (a.b + a2.b) / 2 }, { L: (b.L + b2.L) / 2, a: (b.a + b2.a) / 2, b: (b.b + b2.b) / 2 });
        if (s > best) { best = s; at = d; }
      }
      if (best >= 6) pts.push([t0 + 16, at]);
    }
    const fit = pts.length >= 3 ? robustFit(pts) : null;
    const edgeAt = (t) => (fit ? Math.max(-4, Math.min(4, Math.round(fit.a * t + fit.b))) : 0);

    // Border width from the measured frame (vision's lines), to keep the reference inside the border.
    const measured = scan.confidence && scan.confidence.per_side && scan.confidence.per_side[side] >= 0.3;
    const li = scan.lines.inner, lo = scan.lines.outer;
    const borderPx = side === "left" ? li.left - lo.left : side === "right" ? lo.right - li.right : side === "top" ? li.top - lo.top : lo.bottom - li.bottom;
    let ref0 = T.ref0, ref1 = T.ref1, band1 = T.band1;
    if (measured && borderPx < ref1 + 4) {
      ref1 = Math.max(8, Math.floor(borderPx - 4));
      ref0 = Math.max(5, ref1 - 10);
      band1 = Math.min(band1, ref0 - 2);
    }

    // Side border colour (median of the whole strip between the edge and the printed frame).
    let border = null;
    {
      const idx = [];
      const d1 = measured ? Math.max(ref1, Math.floor(borderPx - 4)) : ref1;
      for (let t = tA; t < tB; t += 4) for (let d = ref0; d <= d1; d += 2) idx.push(sidePix(g, side, t, d + edgeAt(t)));
      border = medLab(lab, idx);
    }

    // Local border colour every 4 px (median over +-refHalf px along and ref0..ref1 in); follows lighting
    // gradients across the photo and, on full-art cards, the artwork next to the edge.
    const refs = [];
    for (let t = tA; t < tB; t += 4) {
      const idx = [];
      for (let u = Math.max(tA, t - T.refHalf); u <= Math.min(tB - 1, t + T.refHalf); u += 4) {
        const e = edgeAt(u);
        for (let d = ref0; d <= ref1; d += 3) idx.push(sidePix(g, side, u, d + e));
      }
      refs.push(medLab(lab, idx));
    }
    const refAt = (t) => refs[Math.max(0, Math.min(refs.length - 1, Math.round((t - tA) / 4)))];

    const n = Math.max(0, tB - tA);
    const flag = new Uint8Array(n), depth = new Float32Array(n), score = new Float32Array(n);
    const light = new Uint8Array(n), outsideLight = new Uint8Array(n), crossing = new Uint8Array(n), clip = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const t = tA + k, e = edgeAt(t), ref = refAt(t);
      if (headroomOf(ref) < T.headroom) { light[k] = 1; continue; }
      let first = -1, last = -1, cnt = 0, sc = 0, clips = 0, gapRun = 0;
      for (let d = T.band0; d <= band1; d++) {
        const i = sidePix(g, side, t, d + e);
        if (printedMask && printedMask[i]) { if (first >= 0) break; continue; }
        const c = colorAt(lab, i);
        if (stockLike(c.L, c.C, ref)) {
          if (first < 0) { if (d > T.startBy) break; first = d; }
          last = d; cnt++; sc += whiteScore(c.L, c.C, ref); gapRun = 0;
          if (clipped(c.L, c.C)) clips++;
        } else if (first >= 0 && ++gapRun > 1) break;
      }
      if (cnt >= T.minPixels) {
        flag[k] = 1; depth[k] = last + 1; score[k] = sc / cnt; clip[k] = clips / cnt;
        // Is the photo just outside the card as light (glare, a sleeve's reflection, a light background)?
        const out = [4, 6, 8].map((d) => colorAt(lab, sidePix(g, side, t, e - d)));
        outsideLight[k] = out.filter((c) => c.L >= T.stockL && whiteScore(c.L, c.C, ref) >= T.whiteScore).length >= 2 ? 1 : 0;
        // Does the light patch carry on well into the card (a reflection or printed highlight crossing the edge)?
        let deep = 0;
        for (let d = ref0; d <= ref0 + 8; d += 2) { const c = colorAt(lab, sidePix(g, side, t, d + e)); if (stockLike(c.L, c.C, ref)) deep++; }
        crossing[k] = deep >= 3 ? 1 : 0;
      }
    }
    const lightFrac = n ? light.reduce((a, b) => a + b, 0) / n : 1;

    // Runs of flagged positions along the edge.
    const runs = [];
    let k = 0;
    while (k < n) {
      if (!flag[k]) { k++; continue; }
      let end = k;
      for (let j = k + 1; j < n && j - end <= T.gap + 1; j++) if (flag[j]) end = j;
      const s = k, e2 = end;
      k = end + 1;
      if (e2 - s + 1 < T.minRun) continue;
      const ds = [], scs = [];
      let hits = 0, ol = 0, cr = 0, cl = 0;
      for (let q = s; q <= e2; q++) {
        if (!flag[q]) continue;
        hits++; ds.push(depth[q]); scs.push(score[q]); ol += outsideLight[q]; cr += crossing[q]; cl += clip[q];
      }
      runs.push({
        t0: tA + s, t1: tA + e2 + 1, length: e2 - s + 1, depth: percentile(ds, 80), score: median(scs),
        coherence: hits / (e2 - s + 1), outsideLight: ol / hits, crossing: cr / hits, clipped: cl / hits,
        e: edgeAt(tA + Math.round((s + e2) / 2)),
      });
    }
    return { side, len, tA, tB, runs, refs, refAt, edgeAt, border, measured, borderPx, lightFrac, band1 };
  }

  /* ---------------------------------------------------------------- corners */

  /**
   * One rounded corner. Rays from where the arc's centre should be (R in from both edges) outward across
   * the corner find the card's outline, classifying each pixel as card or background by colour (plus bare
   * stock as card). From the outline: the corner radius that fits it (a worn corner is rounder) and how
   * ragged it is, and along each ray whether the first pixels inside the outline are stock-white.
   */
  function analyseCorner(lab, g, ci, sideInfo, printedMask) {
    const R0 = g.R;
    const vs = ci === 0 || ci === 3 ? "left" : "right", hs = ci < 2 ? "top" : "bottom";
    const V = sideInfo[vs], Hh = sideInfo[hs];
    const tV = ci < 2 ? V.tA : V.tB - 1, tH = ci === 0 || ci === 3 ? Hh.tA : Hh.tB - 1;
    const u0 = V.edgeAt(tV), v0 = Hh.edgeAt(tH);  // the edges' true positions near this corner
    const px = (u, v) => { const [x, y] = cornerXY(g, ci, u0 + u, v0 + v); return pixAt(g, x, y); };

    // Card colour next to the corner (from both sides' local border colours) and background just outside.
    const near = (S, t0, dir) => [0, 16, 32].map((o) => S.refAt(t0 + dir * o));
    const cr = [...near(V, tV, ci < 2 ? 1 : -1), ...near(Hh, tH, ci === 0 || ci === 3 ? 1 : -1)];
    const card = { L: median(cr.map((c) => c.L)), a: median(cr.map((c) => c.a)), b: median(cr.map((c) => c.b)) };
    card.C = Math.hypot(card.a, card.b);
    const bgIdx = [];
    for (let s = R0 + 6; s <= R0 + 40; s += 2) for (let o = 6; o <= 14; o += 2) { bgIdx.push(px(-o, s)); bgIdx.push(px(s, -o)); }
    const bg = medLab(lab, bgIdx);
    const contrast = dE(card, bg);
    const bgLight = bg.L >= T.stockL && whiteScore(bg.L, bg.C, card) >= T.whiteScore;
    // Whitening is only judged where the card next to the corner is dark or colourful enough on both sides.
    const lightNear = Math.min(...cr.map(headroomOf)) < T.headroom || V.lightFrac > T.lightSide || Hh.lightFrac > T.lightSide;
    const canWhiten = !lightNear && !bgLight;
    const isCard = (i) => {
      const c = colorAt(lab, i);
      if (dE(c, bg) >= 0.5 * contrast) return true;
      return canWhiten && stockLike(c.L, c.C, card);
    };

    // Self-check: the same classifier must put the straight edges beyond the arc where they are.
    let okLines = 0, lines = 0;
    for (let s = R0 + 8; s <= R0 + 40; s += 8) {
      for (const horiz of [false, true]) {
        lines++;
        for (let o = -6; o <= 6; o++) {
          const i = horiz ? px(s, o) : px(o, s);
          const i2 = horiz ? px(s, o + 1) : px(o + 1, s);
          if (isCard(i) && isCard(i2)) { if (Math.abs(o) <= 2) okLines++; break; }
        }
      }
    }
    const selfCheck = okLines / lines;

    // Rays across the corner through the nominal arc centre, walked inward from just outside the card
    // (5 px beyond both edge lines, inside any sleeve edge) to the first pixels that are card and stay card
    // further in. Walking inward means dark artwork inside the card can't cut the ray short; the "stays
    // card" test skips a thin light line outside (a sleeve's edge, a reflection) instead of stopping at it.
    const rays = [];
    for (let phi = 0; phi <= 90; phi += T.rayStep) {
      const c = Math.cos((phi * Math.PI) / 180), s = Math.sin((phi * Math.PI) / 180);
      const at = (rho) => px(R0 - rho * c, R0 - rho * s);
      const rhoStart = (R0 + 5) / Math.max(c, s);
      if (isCard(at(rhoStart))) { rays.push({ phi, valid: false }); continue; }
      let rhoB = null;
      for (let rho = rhoStart; rho >= 0; rho -= 0.5) {
        if (isCard(at(rho)) && isCard(at(rho - 0.5)) && isCard(at(rho - 3)) && isCard(at(rho - 6))) { rhoB = rho; break; }
      }
      if (rhoB === null) { rays.push({ phi, valid: false }); continue; }
      // Stock-white pixels just inside the outline, starting at it.
      let wd = 0, sc = 0, clips = 0, started = false, miss = 0;
      if (canWhiten) {
        for (let q = 0; q <= 12; q += 0.5) {
          const i = at(rhoB - q);
          if (printedMask && printedMask[i]) break;
          const col = colorAt(lab, i);
          if (stockLike(col.L, col.C, card)) {
            if (!started && q > 1.5) break;
            started = true; wd = q + 0.5; sc += whiteScore(col.L, col.C, card); miss = 0;
            if (clipped(col.L, col.C)) clips++;
          } else if (started && ++miss > 2) break;
          else if (!started && q > 1.5) break;
        }
      }
      const [x, y] = cornerXY(g, ci, u0 + R0 - rhoB * c, v0 + R0 - rhoB * s);
      rays.push({ phi, valid: true, rho: rhoB, whiteDepth: wd >= 1.5 ? wd : 0, score: wd >= 1.5 ? sc / (wd * 2) : 0, clipped: clips > 0, x, y });
    }
    const valid = rays.filter((r) => r.valid);

    // Radius that explains each mid-corner ray's outline point: a circle tangent to both edges.
    const rhoFor = (R, c, s) => { const k = R0 - R; return k * (c + s) + Math.sqrt(Math.max(0, k * k * ((c + s) ** 2 - 2) + R * R)); };
    const radii = [];
    for (const r of valid) {
      if (r.phi < 24 || r.phi > 66) continue;
      const c = Math.cos((r.phi * Math.PI) / 180), s = Math.sin((r.phi * Math.PI) / 180);
      let lo = 0.5 * R0, hi = 3.4 * R0;
      for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (rhoFor(mid, c, s) > r.rho) lo = mid; else hi = mid; }
      radii.push((lo + hi) / 2);
    }
    const radius = radii.length >= 5 ? median(radii) : null;
    const rough = radius === null ? null : median(radii.map((v) => Math.abs(v - radius)));

    // A worn-away corner shows the background where a new corner would still be card. Where the outline sits
    // further in than a new corner's, the "missing" pixels should look like the background just beside the
    // card. Glare or a sleeve's haze over the corner hides card pixels without looking like background, so
    // their median distance from the background (relative to card-vs-background contrast) is higher.
    const miss = [];
    for (const r of valid) {
      if (r.phi < 15 || r.phi > 75 || r.rho > R0 - 2) continue;
      const c = Math.cos((r.phi * Math.PI) / 180), s = Math.sin((r.phi * Math.PI) / 180);
      for (let rho = r.rho + 1.5; rho <= R0 - 0.5; rho += 1) miss.push(dE(colorAt(lab, px(R0 - rho * c, R0 - rho * s)), bg) / Math.max(contrast, 1));
    }
    const cutLook = miss.length >= 10 ? median(miss) : 0;

    // Whitening along the arc
    const white = valid.filter((r) => r.whiteDepth > 0);
    const arcPx = (Math.PI / 2) * R0;
    const wFrac = valid.length ? white.length / valid.length : 0;
    const wLen = wFrac * arcPx, wDepth = white.length ? median(white.map((r) => r.whiteDepth)) : 0;
    const wScore = white.length ? median(white.map((r) => r.score)) : 0;

    return { ci, card, bg, contrast, bgLight, lightNear, canWhiten, selfCheck, rays, valid, radius, rough, cutLook, white, wFrac, wLen, wDepth, wScore, u0, v0 };
  }

  /* ---------------------------------------------------------------- edges + corners */

  /**
   * Candidate edge whitening / chipping and corner wear on the flattened card.
   * opts: {quality: result of quality() for the same photo (optional, lowers confidence where glare or
   *        other problems block a side), printedMask: Uint8Array(width*height) over the flattened card,
   *        1 = printed light/white per a reference image (never counted as wear), face: "front" | "back"
   *        (the DINGs' `side`), sleeve: bool (override the sleeve check), cornerRadiusMm: a new corner's
   *        radius for this game (default 3.02 mm = 4.8% of the width), debug: bool (corner internals)}.
   * Returns {edges, corners, sides, overlays, defects, summary, limitations}:
   *   edges[]:   {side, type, start, end, start_px, end_px, length_mm, depth, depth_mm, contrast, severity,
   *               confidence, likely, note, ding?}. start/end are fractions 0..1 along the edge (top/bottom
   *               left->right, left/right top->bottom), *_px the same in flattened-card px from the card's
   *               corner, depth in px into the card.
   *   corners[]: {location, assessable, reason, whitening, rounding, severity, confidence, likely, note, dings}
   *   overlays[]: {type: "rect", x, y, w, h | "polyline", points, kind, label, severity?, confidence?, likely?}
   *               in flattened-card (scan.warped) pixels.
   *   defects[]: likely candidates as DINGs {side, location, type, severity, note} (types from defects.yaml).
   */
  function edgesAndCorners(scan, opts = {}) {
    const g = geom(scan);
    if (opts.cornerRadiusMm) g.R = opts.cornerRadiusMm * g.pxPerMm;
    const lab = labFor(scan, true);
    const q = opts.quality || null;
    const blocked = q ? q.blocked_reasons : {};
    const sleeve = opts.sleeve != null ? !!opts.sleeve : q ? !!q.checks.sleeve.value : detectSleeve(lab, g).found;
    const mask = opts.printedMask || null;
    const face = opts.face || null;
    const mm = (px) => r2(px / g.pxPerMm);
    const overlays = [], edges = [], corners = [], defects = [], limitations = [];

    const sideInfo = {}, sides = {};
    for (const side of SIDES) {
      const s = analyseSide(lab, g, scan, side, mask);
      sideInfo[side] = s;
      const why = blocked[`edges:${side}`];
      let assessable = true, reason = null;
      if (s.lightFrac > T.lightSide) {
        assessable = false;
        reason = s.measured ? "white border" : "light border, artwork or glare at the edge";
      } else if (why) { assessable = false; reason = why.join(", "); }
      sides[side] = {
        assessable, reason,
        border: { L: r1(s.border.L), a: r1(s.border.a), b: r1(s.border.b), C: r1(s.border.C) },
        frame_measured: !!s.measured, light_fraction: r2(s.lightFrac),
      };
      if (!assessable) {
        const [xa, ya] = sideXY(g, side, s.tA, 0), [xb, yb] = sideXY(g, side, s.tB, 12);
        overlays.push({ type: "rect", kind: "unassessable", x: Math.min(xa, xb), y: Math.min(ya, yb), w: Math.abs(xb - xa), h: Math.abs(yb - ya), label: `${side}: ${reason}` });
      }
      if (s.lightFrac > T.lightSide) continue;  // no candidates on a white border: it can't tell stock from ink

      const span = s.tB - s.tA;
      for (const run of s.runs) {
        const notes = [];
        let conf = 0.3 + 0.7 * clamp01((run.score - T.whiteScore) / 30);
        conf *= 0.6 + 0.4 * run.coherence;
        if (run.outsideLight > 0.3) { conf *= 1 - 0.6 * run.outsideLight; notes.push("the photo just outside the edge is as light (glare, sleeve or background)"); }
        if (run.crossing > 0.3) { conf *= 1 - 0.7 * run.crossing; notes.push("the light patch carries on into the card (reflection or printing)"); }
        if (run.clipped > 0.3) { conf *= 1 - 0.6 * run.clipped; notes.push("over-exposed (glare)"); }
        if (run.length > 0.5 * span) { conf *= 0.4; notes.push("runs along most of the edge: more likely the card's cut edge showing (tilt), a printed line or the sleeve than wear"); }
        if (why) { conf *= 0.4; notes.push(`this edge is flagged in photo quality (${why.join(", ")})`); }
        if (sleeve) { conf *= 0.8; notes.push("seen through a sleeve"); }
        if (!s.measured) {
          conf *= 0.6;
          notes.push("no plain border here: light artwork at the edge can look like this");
          if (run.depth >= s.band1 - 1) { conf *= 0.4; notes.push("reaches as deep as the check looks, more like artwork than wear"); }
        }
        if (run.length < 6) conf *= 0.7;
        const lengthMm = mm(run.length), depthMm = mm(run.depth);
        const severity = severityOf(lengthMm, depthMm);
        // Short and deep reads as a chip / nick rather than a line of whitening.
        const type = run.depth >= 7 && run.length <= 3 * run.depth ? "edge_chipping" : "edge_whitening";
        const item = {
          side, type, start: r3(run.t0 / s.len), end: r3(run.t1 / s.len), start_px: run.t0, end_px: run.t1,
          length_mm: lengthMm, depth: r1(run.depth), depth_mm: depthMm, contrast: r1(run.score),
          severity, confidence: r2(conf), likely: conf >= T.candidateConf,
          note: `${type === "edge_chipping" ? "Chip" : "Whitening"} ${lengthMm} mm long, ${depthMm} mm deep${notes.length ? `; ${notes.join("; ")}` : ""}.`,
        };
        edges.push(item);
        const [xa, ya] = sideXY(g, side, run.t0, run.e + T.band0), [xb, yb] = sideXY(g, side, run.t1, run.e + run.depth + 1);
        overlays.push({ type: "rect", kind: "edge", severity, confidence: item.confidence, likely: item.likely, x: Math.min(xa, xb), y: Math.min(ya, yb), w: Math.max(1, Math.abs(xb - xa)), h: Math.max(1, Math.abs(yb - ya)), label: `${side} ${severity}` });
      }
    }
    edges.sort((a, b) => b.confidence - a.confidence);

    for (let ci = 0; ci < 4; ci++) {
      const loc = CORNERS[ci];
      const c = analyseCorner(lab, g, ci, sideInfo, mask);
      const vs = ci === 0 || ci === 3 ? "left" : "right", hs = ci < 2 ? "top" : "bottom";
      const why = blocked[`corners:${loc}`];
      const notes = [];
      let assessable = true, reason = null;
      if (c.contrast < 12) { assessable = false; reason = "card and background too similar"; }
      else if (c.valid.length < 20 || c.selfCheck < 0.5) { assessable = false; reason = "outline unclear against the background"; }
      else if (why) { assessable = false; reason = why.join(", "); }

      // Softening / rounding
      let rounding = null;
      if (c.radius !== null) {
        const excessMm = (c.radius - g.R) / g.pxPerMm;
        const ex = T.roundExcess;
        const sev = excessMm >= ex[3] ? "major" : excessMm >= ex[2] ? "moderate" : excessMm >= ex[1] ? "minor" : excessMm >= ex[0] ? "micro" : null;
        let conf = clamp01((c.contrast - 12) / 30) * (0.3 + 0.7 * c.selfCheck);
        conf *= c.rough > T.roughPx ? 0.7 : 1;
        conf *= clamp01((0.45 - c.cutLook) / 0.25);
        if (sev && c.cutLook > 0.2) notes.push("the missing part of the corner doesn't look like the background (glare or sleeve haze?)");
        rounding = { radius_px: r1(c.radius), expected_px: r1(g.R), excess_mm: r2(excessMm), roughness_px: r1(c.rough), rough: c.rough > T.roughPx, severity: sev, confidence: r2(conf) };
      }
      // Whitening along the arc
      let whitening = null;
      if (!c.canWhiten) {
        notes.push(c.bgLight ? "background as light as bare stock: whitening can't be told apart" : "white/light border or artwork next to the corner: whitening can't be told apart");
      } else {
        const sev = c.white.length >= 2 ? severityOf(mm(c.wLen), mm(c.wDepth)) : null;
        let conf = 0.3 + 0.7 * clamp01((c.wScore - T.whiteScore) / 30);
        const clipFrac = c.white.length ? c.white.filter((r) => r.clipped).length / c.white.length : 0;
        if (clipFrac > 0.3) { conf *= 1 - 0.6 * clipFrac; notes.push("over-exposed (glare)"); }
        whitening = { fraction: r2(c.wFrac), length_mm: mm(c.wLen), depth_mm: mm(c.wDepth), contrast: r1(c.wScore), severity: sev, confidence: sev ? r2(conf) : 0 };
      }
      const parts = [whitening && whitening.severity ? whitening : null, rounding && rounding.severity ? rounding : null].filter(Boolean);
      let severity = null, conf = 0;
      for (const p of parts) if (!severity || SEV_RANK[p.severity] > SEV_RANK[severity]) severity = p.severity;
      if (parts.length) conf = Math.max(...parts.map((p) => p.confidence));
      if (why) { conf *= 0.4; notes.push(`flagged in photo quality (${why.join(", ")})`); }
      else if (!assessable) conf *= 0.5;
      if (sleeve) { conf *= 0.8; notes.push("seen through a sleeve"); }
      if (!sideInfo[vs].measured || !sideInfo[hs].measured) { conf *= 0.7; notes.push("no plain border here: artwork can look like wear"); }
      if (c.selfCheck < 0.6) notes.push("the outline here doesn't follow the card edge reliably");
      const desc = [];
      if (whitening && whitening.severity) desc.push(`whitening along ${Math.round(c.wFrac * 100)}% of the corner (${whitening.depth_mm} mm deep)`);
      if (rounding && rounding.severity) desc.push(`rounder than a new corner (radius ${mm(c.radius)} mm vs ${mm(g.R)} mm)${rounding.rough ? ", ragged outline" : ""}`);
      const item = {
        location: loc, assessable, reason, whitening, rounding, severity, confidence: r2(conf), likely: !!severity && conf >= T.candidateConf,
        note: (desc.length ? `${desc.join("; ")}` : "no wear above threshold") + (notes.length ? `; ${notes.join("; ")}` : "") + ".",
      };
      if (opts.debug) item.debug = { contrast: r1(c.contrast), selfCheck: r2(c.selfCheck), valid: c.valid.length, bg: [r1(c.bg.L), r1(c.bg.C)], card: [r1(c.card.L), r1(c.card.C)], cutLook: r2(c.cutLook) };
      corners.push(item);
      if (severity) {
        const pts = (c.white.length >= 2 && whitening && whitening.severity && !(rounding && rounding.severity) ? c.white : c.valid).map((r) => [r1(r.x), r1(r.y)]);
        overlays.push({ type: "polyline", kind: "corner", severity, confidence: item.confidence, likely: item.likely, points: pts, label: `${pretty(loc)} ${severity}` });
      }
    }

    // DING-shaped candidates (the likely ones), in the app's defect model; each is also linked from its item.
    const ding = (location, type, severity, note) => ({ side: face, location, type, severity, note: `Photo check: ${note}` });
    for (const e of edges) {
      if (!e.likely) continue;
      e.ding = ding(e.side, e.type, e.severity, e.note);
      defects.push(e.ding);
    }
    for (const c of corners) {
      c.dings = [];
      if (!c.likely) continue;
      for (const [part, type] of [[c.whitening, "corner_whitening"], [c.rounding, "corner_softening"]]) {
        if (part && part.severity && part.confidence >= T.candidateConf) c.dings.push(ding(c.location, type, part.severity, c.note));
      }
      defects.push(...c.dings);
    }

    // Summary and limitations: never claim the card is clean.
    const okSides = SIDES.filter((s) => sides[s].assessable), badSides = SIDES.filter((s) => !sides[s].assessable);
    const okCorners = corners.filter((c) => c.assessable).map((c) => c.location), badCorners = corners.filter((c) => !c.assessable);
    const likelyEdges = edges.filter((e) => e.likely), likelyCorners = corners.filter((c) => c.likely);
    const parts = [];
    if (likelyEdges.length) {
      const bySide = SIDES.map((s) => [s, likelyEdges.filter((e) => e.side === s)]).filter(([, l]) => l.length);
      parts.push(`Possible edge whitening or chipping: ${bySide.map(([s, l]) => `${s} (${l.length} spot${l.length > 1 ? "s" : ""}, worst ${l.reduce((w, e) => (SEV_RANK[e.severity] > SEV_RANK[w] ? e.severity : w), "micro")})`).join(", ")}.`);
    } else {
      parts.push(`No edge whitening detected above threshold on assessable edges${okSides.length ? ` (${okSides.join(", ")})` : " (none were assessable)"}.`);
    }
    if (likelyCorners.length) parts.push(`Possible corner wear: ${likelyCorners.map((c) => `${pretty(c.location)} (${c.severity})`).join(", ")}.`);
    else parts.push(`No corner wear detected above threshold on assessable corners${okCorners.length ? ` (${okCorners.map(pretty).join(", ")})` : " (none were assessable)"}.`);
    if (badSides.length) parts.push(`Not assessable: ${badSides.map((s) => `${s} edge (${sides[s].reason})`).join(", ")}.`);
    if (badCorners.length) parts.push(`Corners not assessable: ${badCorners.map((c) => `${pretty(c.location)} (${c.reason})`).join(", ")}.`);
    const weak = edges.filter((e) => !e.likely).length + corners.filter((c) => c.severity && !c.likely).length;
    if (weak) parts.push(`${weak} weaker candidate${weak > 1 ? "s" : ""} (probably glare, sleeve or printing) shown greyed out.`);
    if (likelyEdges.length || likelyCorners.length) parts.push("Check each one by eye before adding it as a DING.");

    for (const s of badSides) limitations.push(`${s} edge not assessed: ${sides[s].reason}.`);
    for (const c of badCorners) limitations.push(`${pretty(c.location)} corner not assessed: ${c.reason}.`);
    if (sleeve) limitations.push("Sleeve present: edges and corners are only seen through plastic; its reflections can look like whitening and it can hide fine wear.");
    if (!mask) limitations.push("No reference image: white or light printing that touches the edge can be mistaken for whitening.");
    const [tl, tr, br, bl] = uprightCorners(scan.corners);
    const srcPx = Math.min(Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), Math.hypot(br[0] - bl[0], br[1] - bl[1]));
    limitations.push(`Wear smaller than about ${r2(Math.max(2 * CARD_MM[0] / srcPx, 2 / g.pxPerMm))} mm can't be resolved in this photo.`);
    limitations.push("Only this face's edges are checked; the other face and the card's thickness need their own photos.");
    limitations.push("Scratches, print lines, dents, creases and gloss loss are not assessed: they need angled lighting.");
    limitations.push("Severity levels and confidence are rough proposals tuned on a few photos, not measured against graded cards.");

    return { edges, corners, sides, overlays, defects, summary: parts.join(" "), limitations };
  }

  return { quality, edgesAndCorners, detectSleeve, THRESHOLDS: T };
});
