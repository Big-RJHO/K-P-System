/*
 * Centering measurement without OpenCV: a pure-JavaScript port of
 * cardgrader/vision/detect.py and cardgrader/vision/borders.py.
 *
 * Works on plain RGBA buffers ({width, height, data}) so it runs in any browser
 * (and in Node for tests). Steps: find the card, flatten it with a homography,
 * then measure the border between the card edge and the printed frame on each side.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Vision = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CARD_W = 750, CARD_H = 1048;  // 63 x 88 mm at ~300 dpi
  const MARGIN = 24;                  // px of surrounding photo kept around the card
  const SIDES = ["left", "right", "top", "bottom"];

  /* ---------------------------------------------------------------- colour */

  const SRGB_TO_LINEAR = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function labF(t) {
    return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  }

  /** RGBA -> Lab on OpenCV's 8-bit scale (L*2.55, a+128, b+128), as Float32Array [L,a,b,...]. */
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
      const L = y > 0.008856 ? 116 * fy - 16 : 903.3 * y;
      out[i * 3] = L * 2.55;
      out[i * 3 + 1] = 500 * (fx - fy) + 128;
      out[i * 3 + 2] = 200 * (fy - fz) + 128;
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

  // numpy.percentile with linear interpolation, on a sorted array
  function percentileSorted(s, p) {
    const pos = (s.length - 1) * (p / 100);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  /* ---------------------------------------------------------------- image ops */

  function downscale(img, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    if (scale === 1) return { img, scale };
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    const out = new Uint8ClampedArray(w * h * 4);
    const fx = img.width / w, fy = img.height / h;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          let p = (yy * img.width + x0) * 4;
          for (let xx = x0; xx < x1; xx++, p += 4) { r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++; }
        }
        const o = (y * w + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    return { img: { width: w, height: h, data: out }, scale: w / img.width };
  }

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

  function morph(mask, w, h, erode) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = erode ? 1 : 0;
        for (let dy = -1; dy <= 1 && v === (erode ? 1 : 0); dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) { if (erode) v = 0; continue; }
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const m = xx < 0 || xx >= w ? 0 : mask[yy * w + xx];
            if (erode && !m) { v = 0; break; }
            if (!erode && m) { v = 1; break; }
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- find the card */

  function fullImage(w, h) {
    return [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]];
  }

  function fitLine(points) {
    // least squares for u = a*v + b; points are [v, u]
    const n = points.length;
    if (n < 2) return null;
    let sv = 0, su = 0, svv = 0, svu = 0;
    for (const [v, u] of points) { sv += v; su += u; svv += v * v; svu += v * u; }
    const den = n * svv - sv * sv;
    if (Math.abs(den) < 1e-9) return null;
    const a = (n * svu - sv * su) / den;
    return { a, b: (su - a * sv) / n };
  }

  // Keep points close to the line (drops rounded-corner and noise points), then refit.
  function robustFit(points) {
    let line = fitLine(points);
    if (!line) return null;
    for (let iter = 0; iter < 2; iter++) {
      const res = points.map(([v, u]) => Math.abs(u - (line.a * v + line.b)));
      const tol = Math.max(1.5, 2.5 * median(res));
      const kept = points.filter((_, i) => res[i] <= tol);
      const next = fitLine(kept);
      if (!next) break;
      line = next;
    }
    return line;
  }

  /**
   * Return {corners: [[x,y] TL, TR, BR, BL], confidence}.
   * mode "cropped" (or an image already shaped like a card) uses the whole image.
   */
  function findCard(img, mode = "auto") {
    const w = img.width, h = img.height;
    const target = CARD_H / CARD_W;
    const aspect = Math.max(w, h) / Math.min(w, h);
    if (mode === "cropped" || (mode === "auto" && Math.abs(aspect - target) / target < 0.025)) {
      return { corners: fullImage(w, h), confidence: 0.6 };
    }

    const { img: small, scale } = downscale(img, 1000);
    const sw = small.width, sh = small.height;
    const lab = toLab(blur3(small));

    // Background: median colour of a thin ring around the photo.
    const ring = Math.max(2, Math.round(Math.min(sw, sh) * 0.02));
    const ringIdx = [];
    for (let y = 0; y < sh; y += 2) {
      for (let x = 0; x < sw; x += 2) {
        if (x < ring || y < ring || x >= sw - ring || y >= sh - ring) ringIdx.push(y * sw + x);
      }
    }
    const bg = [0, 1, 2].map((c) => median(ringIdx.map((i) => lab[i * 3 + c])));
    const dist = (i) => Math.hypot(lab[i * 3] - bg[0], lab[i * 3 + 1] - bg[1], lab[i * 3 + 2] - bg[2]);
    const spread = median(ringIdx.map(dist));
    const thresh = Math.max(25, 3 * spread);

    let mask = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) mask[i] = dist(i) > thresh ? 1 : 0;
    mask = morph(morph(mask, sw, sh, true), sw, sh, false);  // open: drop specks

    // Largest connected component (4-connected)
    const label = new Int32Array(sw * sh);
    const stack = new Int32Array(sw * sh);
    let bestLabel = 0, bestSize = 0, next = 0;
    for (let s = 0; s < sw * sh; s++) {
      if (!mask[s] || label[s]) continue;
      next++;
      let top = 0, size = 0;
      stack[top++] = s; label[s] = next;
      while (top) {
        const p = stack[--top];
        size++;
        const x = p % sw, y = (p - x) / sw;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[top++] = p - 1; }
        if (x < sw - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[top++] = p + 1; }
        if (y > 0 && mask[p - sw] && !label[p - sw]) { label[p - sw] = next; stack[top++] = p - sw; }
        if (y < sh - 1 && mask[p + sw] && !label[p + sw]) { label[p + sw] = next; stack[top++] = p + sw; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = next; }
    }
    const areaRatio = bestSize / (sw * sh);
    if (!bestLabel || areaRatio < 0.15 || areaRatio > 0.995) return { corners: fullImage(w, h), confidence: 0.3 };

    // Outer outline: extreme pixels per row/column, plus rough corners from x+y and x-y.
    const rowMin = new Int32Array(sh).fill(-1), rowMax = new Int32Array(sh).fill(-1);
    const colMin = new Int32Array(sw).fill(-1), colMax = new Int32Array(sw).fill(-1);
    let tl = null, tr = null, br = null, bl = null;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (label[y * sw + x] !== bestLabel) continue;
        if (rowMin[y] < 0) rowMin[y] = x;
        rowMax[y] = x;
        if (colMin[x] < 0) colMin[x] = y;
        colMax[x] = y;
        if (!tl || x + y < tl[0] + tl[1]) tl = [x, y];
        if (!br || x + y > br[0] + br[1]) br = [x, y];
        if (!tr || x - y > tr[0] - tr[1]) tr = [x, y];
        if (!bl || x - y < bl[0] - bl[1]) bl = [x, y];
      }
    }

    const span = (a, b, lo = 0.15, hi = 0.85) => {
      const [s, e] = a < b ? [a, b] : [b, a];
      return [Math.round(s + (e - s) * lo), Math.round(s + (e - s) * hi)];
    };
    const collect = (range, arr) => {
      const pts = [];
      for (let v = range[0]; v <= range[1]; v++) if (arr[v] >= 0) pts.push([v, arr[v]]);
      return pts;
    };
    const left = robustFit(collect(span(tl[1], bl[1]), rowMin));     // x = a*y + b
    const right = robustFit(collect(span(tr[1], br[1]), rowMax));
    const topL = robustFit(collect(span(tl[0], tr[0]), colMin));     // y = a*x + b
    const bottom = robustFit(collect(span(bl[0], br[0]), colMax));
    if (!left || !right || !topL || !bottom) return { corners: fullImage(w, h), confidence: 0.3 };

    // Intersect x = a1*y + b1 with y = a2*x + b2. The outline pixels sit half a pixel
    // inside the true edge, so push each line outward by 0.5 px.
    const meet = (vert, horiz, dx, dy) => {
      const b1 = vert.b + dx, b2 = horiz.b + dy;
      const x = (vert.a * b2 + b1) / (1 - vert.a * horiz.a);
      return [x, horiz.a * x + b2];
    };
    let corners = [
      meet(left, topL, -0.5, -0.5),
      meet(right, topL, 0.5, -0.5),
      meet(right, bottom, 0.5, 0.5),
      meet(left, bottom, -0.5, 0.5),
    ];
    if (corners.some(([x, y]) => !isFinite(x) || !isFinite(y))) return { corners: fullImage(w, h), confidence: 0.3 };
    // back to full-resolution pixel coordinates
    corners = corners.map(([x, y]) => [(x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5]);

    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const width = (d(corners[1], corners[0]) + d(corners[2], corners[3])) / 2;
    const height = (d(corners[3], corners[0]) + d(corners[2], corners[1])) / 2;
    const quadAspect = Math.max(width, height) / Math.min(width, height);
    const aspectScore = Math.max(0, 1 - Math.abs(quadAspect - target) / 0.25);
    if (aspectScore < 0.2) return { corners: fullImage(w, h), confidence: 0.3 };
    return { corners, confidence: Math.min(1, aspectScore * Math.pow(areaRatio, 0.25) + 0.1) };
  }

  /* ---------------------------------------------------------------- flatten */

  // Solve the 8x8 system for the homography mapping src[i] -> dst[i].
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    for (let c = 0; c < 8; c++) {  // Gaussian elimination with partial pivoting
      let piv = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const hvec = b.map((v, i) => v / A[i][i]);
    return [...hvec, 1];
  }

  /** Perspective-warp the card upright to CARD_W x CARD_H with `margin` px of context on every side. */
  function warpCard(img, corners, margin = MARGIN) {
    let [tl, tr, br, bl] = corners;
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const width = (d(tr, tl) + d(br, bl)) / 2, height = (d(bl, tl) + d(br, tr)) / 2;
    if (width > height) [tl, tr, br, bl] = [bl, tl, tr, br];  // landscape photo of a portrait card
    const m = margin;
    const dst = [[m, m], [m + CARD_W - 1, m], [m + CARD_W - 1, m + CARD_H - 1], [m, m + CARD_H - 1]];
    const H = homography(dst, [tl, tr, br, bl]);  // output pixel -> source pixel
    const W = CARD_W + 2 * m, Ht = CARD_H + 2 * m;
    const out = new Uint8ClampedArray(W * Ht * 4);
    const sw = img.width, sh = img.height, src = img.data;
    for (let v = 0; v < Ht; v++) {
      for (let u = 0; u < W; u++) {
        const den = H[6] * u + H[7] * v + H[8];
        let x = (H[0] * u + H[1] * v + H[2]) / den;
        let y = (H[3] * u + H[4] * v + H[5]) / den;
        x = Math.min(sw - 1, Math.max(0, x));  // replicate border
        y = Math.min(sh - 1, Math.max(0, y));
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const fx = x - x0, fy = y - y0;
        const o = (v * W + u) * 4;
        const p00 = (y0 * sw + x0) * 4, p01 = (y0 * sw + x1) * 4, p10 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
        for (let c = 0; c < 3; c++) {
          const top = src[p00 + c] + (src[p01 + c] - src[p00 + c]) * fx;
          const bot = src[p10 + c] + (src[p11 + c] - src[p10 + c]) * fx;
          out[o + c] = top + (bot - top) * fy;
        }
        out[o + 3] = 255;
      }
    }
    return { width: W, height: Ht, data: out };
  }

  /* ---------------------------------------------------------------- measure borders */

  // Distance from the image edge -> Lab index for profile `line`, sample `i` on one side.
  function profileIndexer(side, w, h) {
    const rows = [Math.floor(h * 0.2), Math.floor(h * 0.8)];
    const cols = [Math.floor(w * 0.2), Math.floor(w * 0.8)];
    switch (side) {
      case "left": return { lines: rows[1] - rows[0], at: (l, i) => (rows[0] + l) * w + i };
      case "right": return { lines: rows[1] - rows[0], at: (l, i) => (rows[0] + l) * w + (w - 1 - i) };
      case "top": return { lines: cols[1] - cols[0], at: (l, i) => i * w + cols[0] + l };
      default: return { lines: cols[1] - cols[0], at: (l, i) => (h - 1 - i) * w + cols[0] + l };
    }
  }

  function firstRun(mask, start, end, run) {
    let count = 0;
    for (let i = start; i < end; i++) {
      count = mask[i] ? count + 1 : 0;
      if (count === run) return i - run + 1 - start;
    }
    return -1;
  }

  function measureSide(lab, w, h, side, margin) {
    const extent = (side === "left" || side === "right" ? w : h) - 2 * margin;
    const depth = margin + Math.floor(extent * 0.22);
    const refStart = margin + Math.floor(extent * 0.012), refEnd = margin + Math.floor(extent * 0.03);
    const { lines, at } = profileIndexer(side, w, h);

    const refVals = [[], [], []];
    for (let l = 0; l < lines; l++) {
      for (let i = refStart; i < refEnd; i++) {
        const p = at(l, i) * 3;
        refVals[0].push(lab[p]); refVals[1].push(lab[p + 1]); refVals[2].push(lab[p + 2]);
      }
    }
    const ref = refVals.map(median);
    const dist = new Float32Array(lines * depth);
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < depth; i++) {
        const p = at(l, i) * 3;
        dist[l * depth + i] = Math.hypot(lab[p] - ref[0], lab[p + 1] - ref[1], lab[p + 2] - ref[2]);
      }
    }
    const refDists = [];
    for (let l = 0; l < lines; l++) for (let i = refStart; i < refEnd; i++) refDists.push(dist[l * depth + i]);
    const thresh = Math.max(18, 4 * median(refDists));

    const inner = [], outer = [];
    const over = new Uint8Array(depth);
    const back = new Uint8Array(refStart);
    let found = 0;
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < depth; i++) over[i] = dist[l * depth + i] > thresh ? 1 : 0;
      const rel = firstRun(over, refEnd, depth, 3);
      if (rel < 0) continue;
      found++;
      for (let i = 0; i < refStart; i++) back[i] = over[refStart - 1 - i];
      const orel = firstRun(back, 0, refStart, 2);
      inner.push(rel + refEnd);
      outer.push(orel < 0 ? margin : refStart - orel);
    }
    if (found < Math.max(5, lines * 0.2)) return { outer: margin, inner: NaN, confidence: 0 };
    const widths = inner.map((v, i) => v - outer[i]);
    const sorted = Float64Array.from(widths).sort();
    const med = median(widths);
    const iqr = percentileSorted(sorted, 75) - percentileSorted(sorted, 25);
    const consistency = Math.max(0, 1 - iqr / Math.max(4, med * 0.25));
    return { outer: median(outer), inner: median(inner), confidence: (found / lines) * consistency };
  }

  function measureBorders(card, margin = MARGIN) {
    const w = card.width, h = card.height;
    const lab = toLab(blur3(card));
    const edges = {};
    for (const side of SIDES) {
      let e = measureSide(lab, w, h, side, margin);
      if (isNaN(e.inner)) {  // full-art card or no clear frame: guess a typical border
        const extent = (side === "left" || side === "right" ? w : h) - 2 * margin;
        e = { outer: e.outer, inner: e.outer + extent * 0.05, confidence: 0 };
      }
      edges[side] = e;
    }
    const round1 = (v) => Math.round(v * 10) / 10;
    const borders = {};
    for (const s of SIDES) borders[s] = round1(edges[s].inner - edges[s].outer);
    return {
      borders,
      edges,
      confidence: Math.round(Math.min(...SIDES.map((s) => edges[s].confidence)) * 1000) / 1000,
    };
  }

  const share = (a, b) => (a + b <= 0 ? 50 : (Math.max(a, b) / (a + b)) * 100);

  /** Full pipeline, same result shape as the Python app's POST /api/scan. */
  function scan(img, mode = "auto") {
    const { corners, confidence: cardConf } = findCard(img, mode);
    const warped = warpCard(img, corners, MARGIN);
    const m = measureBorders(warped, MARGIN);
    const W = warped.width, H = warped.height, e = m.edges;
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      warped,
      width: W,
      height: H,
      margin: MARGIN,
      lines: {
        outer: { left: e.left.outer, right: W - e.right.outer, top: e.top.outer, bottom: H - e.bottom.outer },
        inner: { left: e.left.inner, right: W - e.right.inner, top: e.top.inner, bottom: H - e.bottom.inner },
      },
      borders: m.borders,
      centering: { lr: r2(share(m.borders.left, m.borders.right)), tb: r2(share(m.borders.top, m.borders.bottom)) },
      confidence: {
        card: Math.round(cardConf * 1000) / 1000,
        borders: m.confidence,
        per_side: Object.fromEntries(SIDES.map((s) => [s, Math.round(e[s].confidence * 1000) / 1000])),
      },
    };
  }

  return { scan, findCard, warpCard, measureBorders, CARD_W, CARD_H, MARGIN };
});
