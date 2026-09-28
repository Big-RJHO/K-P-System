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
  const MARGIN = 48;                  // px of surrounding photo kept around the card (room to drag the edge guides)
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

  /* ---------------------------------------------------------------- find the card: straight edges */

  /**
   * Find the card as the best card-shaped rectangle formed by four straight edges.
   * This is how document scanners work, and it copes with cluttered photos (a card in a sleeve on
   * a desk or keyboard) where the card doesn't stand out from one plain background colour.
   *
   * 1. Colour gradients on a ~640 px copy, with Hough line voting guided by each pixel's gradient direction.
   * 2. The strongest near-vertical and near-horizontal lines become candidate card sides.
   * 3. Every pair of verticals x pair of horizontals is scored by aspect ratio (63 x 88 mm, either way up)
   *    and by how strongly the image changes along all four sides. The weakest side counts most,
   *    so a faint sleeve edge or a keyboard line that runs past the card loses.
   * Returns null when nothing convincing is found.
   */
  function findCardEdges(img) {
    const { img: small, scale } = downscale(img, 640);
    const w = small.width, h = small.height, n = w * h;
    const lab = toLab(blur3(small));

    // Colour gradient: per pixel, the Sobel response of whichever Lab channel changes most.
    const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let bx = 0, by = 0, bm = -1;
        for (let c = 0; c < 3; c++) {
          const v = (dx, dy) => lab[((y + dy) * w + (x + dx)) * 3 + c];
          const sx = v(1, -1) + 2 * v(1, 0) + v(1, 1) - v(-1, -1) - 2 * v(-1, 0) - v(-1, 1);
          const sy = v(-1, 1) + 2 * v(0, 1) + v(1, 1) - v(-1, -1) - 2 * v(0, -1) - v(1, -1);
          const m = sx * sx + sy * sy;
          if (m > bm) { bm = m; bx = sx; by = sy; }
        }
        gx[i] = bx; gy[i] = by; mag[i] = Math.sqrt(bm) / 4;
      }
    }
    const sortedMag = Float32Array.from(mag).sort();
    // Edge pixels: the top 15% by strength, but never demanding more than a moderate step, so a
    // low-contrast card edge (dark blue on a dark desk) still counts in a busy photo.
    const edgeT = Math.max(8, Math.min(22, sortedMag[Math.floor(n * 0.85)]));

    // Hough voting, only near the direction of each pixel's gradient.
    const diag = Math.ceil(Math.hypot(w, h));
    const NT = 180, NR = 2 * diag + 1;
    const acc = new Float32Array(NT * NR);
    const cosT = new Float32Array(NT), sinT = new Float32Array(NT);
    for (let t = 0; t < NT; t++) { cosT[t] = Math.cos((t * Math.PI) / 180); sinT[t] = Math.sin((t * Math.PI) / 180); }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (mag[i] < edgeT) continue;
        let t0 = Math.round((Math.atan2(gy[i], gx[i]) * 180) / Math.PI);  // normal direction
        t0 = ((t0 % 180) + 180) % 180;
        const wgt = Math.min(mag[i], 80);
        for (let dt = -4; dt <= 4; dt++) {
          const t = (t0 + dt + 180) % 180;
          const r = Math.round(x * cosT[t] + y * sinT[t]) + diag;
          acc[t * NR + r] += wgt;
        }
      }
    }

    // Peak lines, with non-maximum suppression.
    const peaks = [];
    const minVotes = Math.min(w, h) * 0.12 * 20;
    for (let t = 0; t < NT; t++) {
      for (let r = 0; r < NR; r++) {
        const v = acc[t * NR + r];
        if (v < minVotes) continue;
        let isMax = true;
        for (let dt = -3; dt <= 3 && isMax; dt++) {
          const tt = (t + dt + NT) % NT;
          for (let dr = -6; dr <= 6; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= NR || (dt === 0 && dr === 0)) continue;
            const o = acc[tt * NR + rr];
            if (o > v || (o === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; }
          }
        }
        if (isMax) peaks.push({ t, rho: r - diag, v });
      }
    }
    peaks.sort((a, b) => b.v - a.v);

    // Split into near-vertical (normal ~0 deg) and near-horizontal (normal ~90 deg) lines.
    const vert = [], horz = [];
    for (const p of peaks.slice(0, 90)) {
      let t = p.t, rho = p.rho;
      if (t > 90) { t -= 180; rho = -rho; }  // normal angle in (-90, 90]
      if (Math.abs(t) <= 30) { if (vert.length < 24) vert.push({ t, rho }); }
      else if (Math.abs(Math.abs(t) - 90) <= 30) {
        if (t < 0) { t += 180; rho = -rho; }
        if (horz.length < 24) horz.push({ t, rho });
      }
    }
    if (vert.length < 2 || horz.length < 2) return null;

    const lineIntersect = (a, b) => {
      const ca = Math.cos((a.t * Math.PI) / 180), sa = Math.sin((a.t * Math.PI) / 180);
      const cb = Math.cos((b.t * Math.PI) / 180), sb = Math.sin((b.t * Math.PI) / 180);
      const det = ca * sb - sa * cb;
      if (Math.abs(det) < 1e-6) return null;
      return [(a.rho * sb - b.rho * sa) / det, (ca * b.rho - cb * a.rho) / det];
    };

    const labAt = (x, y) => {
      const xi = Math.min(w - 1, Math.max(0, Math.round(x))), yi = Math.min(h - 1, Math.max(0, Math.round(y)));
      const i = (yi * w + xi) * 3;
      return [lab[i], lab[i + 1], lab[i + 2]];
    };
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
    const k = Math.max(4, Math.round(Math.min(w, h) * 0.012));
    // Colour step across a line at one point. A card edge is a step (different colours on each
    // side); a thin printed frame line has the same colour on both sides and scores low.
    const stepAt = (cx, cy, nx, ny) => {
      const a = labAt(cx + nx * k, cy + ny * k), b = labAt(cx - nx * k, cy - ny * k);
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };
    const sideScore = (p, q) => {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len;
      const at = (f) => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
      let total = 0, strong = 0;
      const samples = 32;
      for (let i = 0; i < samples; i++) {
        const [cx, cy] = at(0.12 + (0.76 * i) / (samples - 1));
        const d = stepAt(cx, cy, nx, ny);
        total += Math.min(d / 35, 1);
        if (d > 12) strong++;
      }
      // A card edge stops at the corners; a keyboard or desk line keeps going.
      let cont = 0, contN = 0;
      for (const f of [-0.24, -0.18, -0.12, 1.12, 1.18, 1.24]) {
        const [cx, cy] = at(f);
        if (!inside(cx, cy)) continue;
        cont += Math.min(stepAt(cx, cy, nx, ny) / 35, 1);
        contN++;
      }
      const contMean = contN ? cont / contN : 0;
      return { score: (total / samples) * (1 - 0.25 * contMean), frac: strong / samples };
    };

    const target = CARD_H / CARD_W;
    let best = null;
    const cands = [];
    for (let a = 0; a < vert.length; a++) {
      for (let b = a + 1; b < vert.length; b++) {
        const [L, R] = vert[a].rho <= vert[b].rho ? [vert[a], vert[b]] : [vert[b], vert[a]];
        if (Math.abs(L.t - R.t) > 5 || R.rho - L.rho < Math.min(w, h) * 0.15) continue;
        for (let c = 0; c < horz.length; c++) {
          for (let d = c + 1; d < horz.length; d++) {
            const [T, B] = horz[c].rho <= horz[d].rho ? [horz[c], horz[d]] : [horz[d], horz[c]];
            if (Math.abs(T.t - B.t) > 5 || B.rho - T.rho < Math.min(w, h) * 0.15) continue;
            // A card photographed roughly face-on: sides nearly parallel and square to each other.
            if (Math.abs((L.t + R.t) / 2 - ((T.t + B.t) / 2 - 90)) > 5) continue;
            const q = [lineIntersect(L, T), lineIntersect(R, T), lineIntersect(R, B), lineIntersect(L, B)];
            if (q.some((pt) => !pt || pt[0] < -0.05 * w || pt[0] > 1.05 * w || pt[1] < -0.05 * h || pt[1] > 1.05 * h)) continue;
            const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]);
            const qw = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, qh = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
            const aspect = Math.max(qw, qh) / Math.min(qw, qh);
            const aspectErr = Math.abs(aspect - target) / target;
            if (aspectErr > 0.1) continue;
            const area = (qw * qh) / (w * h);
            if (area < 0.06 || area > 0.97) continue;
            const sides = [sideScore(q[0], q[1]), sideScore(q[1], q[2]), sideScore(q[2], q[3]), sideScore(q[3], q[0])];
            const minFrac = Math.min(...sides.map((x) => x.frac));
            if (minFrac < 0.4) continue;
            const scores = sides.map((x) => x.score);
            const support = 0.6 * Math.min(...scores) + 0.4 * (scores.reduce((x, y) => x + y, 0) / 4);
            // Priors: cards are usually photographed upright (same orientation as the photo) and near the middle.
            const landscape = qw > qh, photoLandscape = w > h;
            const orient = landscape === photoLandscape ? 1 : 0.75;
            const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
            const off = Math.hypot((cx - w / 2) / w, (cy - h / 2) / h);
            const score = support * (1 - 4 * aspectErr) * (0.85 + 0.15 * Math.sqrt(area)) * orient * (1 - 0.6 * off);
            cands.push({ score, q, minFrac, support, area });
            if (!best || score > best.score) best = { score, q, minFrac, support };
          }
        }
      }
    }
    if (!best || best.support < 0.2) return null;

    // Refine the few best rough outlines and keep the one that ends up most card-shaped with the
    // strongest edges. A wrong rough pick (desk line, sleeve) usually refines into a worse shape.
    const refine = (Q) => {
      // Exact edges: the rough lines are already close, so snap each side to the strongest colour
      // step within a narrow band. The step is measured a few pixels either side of the line, so thin
      // printed lines (same colour on both sides) don't win.
      const qcx = (Q[0][0] + Q[1][0] + Q[2][0] + Q[3][0]) / 4, qcy = (Q[0][1] + Q[1][1] + Q[2][1] + Q[3][1]) / 4;
      const dist2 = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]);
      const shortSide = Math.min((dist2(Q[0], Q[1]) + dist2(Q[3], Q[2])) / 2, (dist2(Q[0], Q[3]) + dist2(Q[1], Q[2])) / 2);
      const band = Math.max(4, Math.round(shortSide * 0.03));
      const kk = Math.max(3, Math.round(shortSide * 0.012));
      // Median colour of a short strip running away from the line (kk..3kk pixels out on one side).
      // Using the median over a wide strip means a thin printed line barely moves it.
      const stripColor = (cx, cy, nx, ny, sign) => {
        const vals = [[], [], []];
        for (let j = 0; j < 5; j++) {
          const dd = sign * (kk + (2 * kk * j) / 4);
          const x = cx + nx * dd, y = cy + ny * dd;
          if (!inside(x, y)) return null;
          const c = labAt(x, y);
          vals[0].push(c[0]); vals[1].push(c[1]); vals[2].push(c[2]);
        }
        return vals.map((v) => v.sort((a, b) => a - b)[2]);
      };
      const stepAlong = (p, q, nx, ny) => {
        let total = 0, n2 = 0;
        for (let i = 0; i < 30; i++) {
          const f = 0.12 + (0.76 * i) / 29;
          const cx = p[0] + (q[0] - p[0]) * f, cy = p[1] + (q[1] - p[1]) * f;
          const a = stripColor(cx, cy, nx, ny, 1), b = stripColor(cx, cy, nx, ny, -1);
          if (!a || !b) continue;
          total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          n2++;
        }
        return n2 ? total / n2 : 0;
      };
      const outward = (p, q) => {
        const len = dist2(p, q);
        let nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len;
        const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
        if ((mx - qcx) * nx + (my - qcy) * ny < 0) { nx = -nx; ny = -ny; }
        return [nx, ny];
      };
      // Snap one side (p->q) to the straight line with the strongest colour step within +-range pixels
      // (both ends may move independently, so the side can tilt slightly).
      const snap = (p, q, range) => {
        const [nx, ny] = outward(p, q);
        let bestS = { s: -1, pair: [p, q] };
        for (let d = -range; d <= range; d++) {
          for (let t = -2; t <= 2; t++) {
            const pp = [p[0] + nx * (d - t), p[1] + ny * (d - t)], qq = [q[0] + nx * (d + t), q[1] + ny * (d + t)];
            const v = stepAlong(pp, qq, nx, ny);
            if (v > bestS.s) bestS = { s: v, pair: [pp, qq] };
          }
        }
        return bestS;
      };
      let sides = [0, 1, 2, 3].map((i) => snap(Q[i], Q[(i + 1) % 4], band));
      const meet = (s1, s2) => {
        const [a, b] = s1, [c, d] = s2;
        const d1x = b[0] - a[0], d1y = b[1] - a[1], d2x = d[0] - c[0], d2y = d[1] - c[1];
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-9) return a;
        const t = ((c[0] - a[0]) * d2y - (c[1] - a[1]) * d2x) / den;
        return [a[0] + d1x * t, a[1] + d1y * t];
      };
      const quadOf = (sd) => {
        const r = sd.map((x) => x.pair);
        return [meet(r[3], r[0]), meet(r[0], r[1]), meet(r[1], r[2]), meet(r[2], r[3])];
      };
      const aspectErrOf = (q) => {
        const qw = (dist2(q[0], q[1]) + dist2(q[3], q[2])) / 2, qh = (dist2(q[0], q[3]) + dist2(q[1], q[2])) / 2;
        return Math.abs(Math.max(qw, qh) / Math.min(qw, qh) - target) / target;
      };
      // A side in shadow can be too faint to be found as a line, and a neighbouring line (sleeve, desk)
      // gets used instead. If the outline isn't card-shaped, re-place each side in turn where the
      // other three and the 63 x 88 shape say it should be, snap it, and keep the most card-like result.
      let quad = quadOf(sides);
      let bestFit = { err: aspectErrOf(quad), quad, total: sides.reduce((x, y) => x + y.s, 0) };
      if (bestFit.err > 0.03) {
        for (let i = 0; i < 4; i++) {
          const opp = (i + 2) % 4;
          const [p, q] = sides[i].pair;
          const [op, oq] = sides[opp].pair;
          const [nx, ny] = outward(p, q);
          const sideLen = (dist2(sides[(i + 1) % 4].pair[0], sides[(i + 1) % 4].pair[1]) + dist2(sides[(i + 3) % 4].pair[0], sides[(i + 3) % 4].pair[1])) / 2;
          const across = (dist2(p, q) + dist2(op, oq)) / 2;  // length of this side ~ the other dimension
          const long = sideLen > across;
          const wanted = long ? across * target : across / target;  // expected distance between side i and its opposite
          const midOpp = [(op[0] + oq[0]) / 2, (op[1] + oq[1]) / 2], mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          const current = Math.abs((mid[0] - midOpp[0]) * nx + (mid[1] - midOpp[1]) * ny);
          const shift = wanted - current;
          const moved = snap([p[0] + nx * shift, p[1] + ny * shift], [q[0] + nx * shift, q[1] + ny * shift], band);
          const trial = sides.slice();
          trial[i] = moved;
          const tq = quadOf(trial);
          const err = aspectErrOf(tq);
          if (err < bestFit.err - 0.01 && moved.s > 8) bestFit = { err, quad: tq };
        }
      }
      return { quad: bestFit.quad, err: bestFit.err, strength: sides.reduce((x, y) => x + y.s, 0) / 4 };

    };
    cands.sort((x, y) => y.score - x.score);
    // Nested rectangles (sleeve > card edge > printed frame) often score alike. Prefer the outermost
    // one whose edges are about as strong as the best's: that is the card's physical edge, while a faint
    // sleeve edge falls short of the strength bar.
    const insideQuad = (pt, q) => {
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const a = q[i], b = q[(i + 1) % 4];
        const cr = (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]);
        if (cr !== 0) { if (sign && Math.sign(cr) !== sign) return false; sign = Math.sign(cr); }
      }
      return true;
    };
    const top0 = cands[0];
    let outer = top0;
    for (const c of cands.slice(0, 40)) {
      if (c === top0 || c.support < 0.8 * top0.support || c.score < 0.7 * top0.score) continue;
      if (outer.q.every((pt) => insideQuad(pt, c.q)) && c.area > outer.area && c.area < outer.area * 1.35) outer = c;
    }
    if (outer !== top0) cands.unshift(outer);
    let chosen = null;
    for (const c of cands.slice(0, 6)) {
      const r = refine(c.q);
      const value = r.strength * Math.max(0, 1 - 5 * r.err) * (0.5 + 0.5 * c.score / cands[0].score);
      if (!chosen || value > chosen.value) chosen = { value, quad: r.quad };
    }
    best.q = chosen.quad;
    const corners = best.q.map(([x, y]) => [(x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5]);
    return { corners, confidence: Math.min(1, 0.45 + best.support * 0.6), method: "edges" };
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
      return { corners: fullImage(w, h), confidence: 0.6, method: "full" };
    }

    // Plain, even background: the card is the big region that differs from it (precise and fast).
    // Anything else (a desk, keyboard, sleeve): find the card from its straight edges instead.
    const blob = findCardBlob(img);
    // A clean, card-shaped region (within ~12% of 63 x 88, allowing for an off-angle photo) is trusted.
    if (blob && blob.aspectScore >= 0.5) return blob;
    const edges = findCardEdges(img);
    if (edges) return edges;
    return blob || { corners: fullImage(w, h), confidence: 0.3, method: "full" };
  }

  /** The card as the largest region that differs from a plain background, or null. */
  function findCardBlob(img) {
    const w = img.width, h = img.height;
    const target = CARD_H / CARD_W;
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
    if (!bestLabel || areaRatio < 0.15 || areaRatio > 0.995) return null;

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
    if (!left || !right || !topL || !bottom) return null;

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
    if (corners.some(([x, y]) => !isFinite(x) || !isFinite(y))) return null;
    // back to full-resolution pixel coordinates
    corners = corners.map(([x, y]) => [(x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5]);

    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const width = (d(corners[1], corners[0]) + d(corners[2], corners[3])) / 2;
    const height = (d(corners[3], corners[0]) + d(corners[2], corners[1])) / 2;
    const quadAspect = Math.max(width, height) / Math.min(width, height);
    const aspectScore = Math.max(0, 1 - Math.abs(quadAspect - target) / 0.25);
    if (aspectScore < 0.2) return null;
    return { corners, confidence: Math.min(1, aspectScore * Math.pow(areaRatio, 0.25) + 0.1), aspectScore, method: "blob" };
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

  /** Output-pixel -> source-pixel homography for warping `corners` upright with `margin` px around. */
  function warpMatrix(corners, margin) {
    let [tl, tr, br, bl] = corners;
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const width = (d(tr, tl) + d(br, bl)) / 2, height = (d(bl, tl) + d(br, tr)) / 2;
    if (width > height) [tl, tr, br, bl] = [bl, tl, tr, br];  // landscape photo of a portrait card
    const m = margin;
    const dst = [[m, m], [m + CARD_W - 1, m], [m + CARD_W - 1, m + CARD_H - 1], [m, m + CARD_H - 1]];
    return homography(dst, [tl, tr, br, bl]);
  }

  const applyH = (H, u, v) => {
    const den = H[6] * u + H[7] * v + H[8];
    return [(H[0] * u + H[1] * v + H[2]) / den, (H[3] * u + H[4] * v + H[5]) / den];
  };

  /** Perspective-warp the card upright to CARD_W x CARD_H with `margin` px of context on every side. */
  function warpCard(img, corners, margin = MARGIN) {
    const H = warpMatrix(corners, margin);
    const W = CARD_W + 2 * margin, Ht = CARD_H + 2 * margin;
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

  /**
   * Second pass on the physical card edge. After a first flattening (with a wide margin) each edge is a
   * nearly straight vertical or horizontal line near the margin. For each side, measure the colour step
   * (median colour of a short strip inside vs outside) at every offset across ~150 rows or columns, take
   * the MEDIAN across them, and use the offset with the biggest median step. Reflections, printed text or a
   * sleeve line only affect some rows, so they can't win. The refined edges are mapped back to photo corners.
   */
  function refineCorners(img, corners) {
    const M = 64;
    const warped = warpCard(img, corners, M);
    const W = warped.width, H = warped.height;
    const lab = toLab(blur3(warped));
    const k = 3;
    const STRIP = [1, 2, 3, 4, 5, 6, 7];
    const at = (x, y, c) => lab[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 3 + c];
    const edgeFrom = (side) => {
      const vertical = side === "left" || side === "right";
      const along = vertical ? H : W;
      const lines = [];
      for (let i = Math.floor(along * 0.2); i < along * 0.8; i += 8) lines.push(i);
      const maxP = 2 * M;
      const prof = new Float32Array(maxP + 1);
      const vals = new Float32Array(lines.length);
      for (let p = k * 7; p <= maxP; p++) {
        lines.forEach((ln, j) => {
          const pt = (dist) => {
            if (side === "left") return [dist, ln];
            if (side === "right") return [W - 1 - dist, ln];
            if (side === "top") return [ln, dist];
            return [ln, H - 1 - dist];
          };
          let dsq = 0;
          for (let c = 0; c < 3; c++) {
            // median of 7 samples spread over ~21 px each side, so printed lines up to ~9 px wide can't sway it
            const o = STRIP.map((m) => at(...pt(p - m * k), c)).sort((x, y) => x - y)[3];
            const i2 = STRIP.map((m) => at(...pt(p + m * k), c)).sort((x, y) => x - y)[3];
            dsq += (i2 - o) * (i2 - o);
          }
          vals[j] = Math.sqrt(dsq);
        });
        prof[p] = Array.from(vals).sort((x, y) => x - y)[Math.floor(vals.length / 2)];
      }
      // Candidate edges: the strongest local peaks of the median-step profile.
      let maxV = 0;
      for (let p = k * 7; p <= maxP; p++) maxV = Math.max(maxV, prof[p]);
      const peaks = [];
      for (let p = k * 7 + 1; p < maxP; p++) {
        if (prof[p] >= prof[p - 1] && prof[p] > prof[p + 1] && prof[p] >= Math.max(8, 0.3 * maxV)) peaks.push({ p, v: prof[p] / maxV });
      }
      peaks.sort((x, y) => y.v - x.v);
      return peaks.slice(0, 4);
    };
    const cand = { left: edgeFrom("left"), right: edgeFrom("right"), top: edgeFrom("top"), bottom: edgeFrom("bottom") };
    // Pick one edge per side: strong, and together card-shaped (the flattened card should be about 750 x 1048).
    const opt = (list) => (list.length ? list : [{ p: M, v: 0 }]);
    let bestCombo = null;
    for (const l of opt(cand.left)) for (const r of opt(cand.right)) for (const t of opt(cand.top)) for (const b of opt(cand.bottom)) {
      const width = (W - 1 - r.p) - l.p, height = (H - 1 - b.p) - t.p;
      if (width <= 0 || height <= 0) continue;
      const err = Math.abs(height / width / (CARD_H / CARD_W) - 1);
      const score = (l.v + r.v + t.v + b.v) / 4 - 12 * err;
      if (!bestCombo || score > bestCombo.score) bestCombo = { score, l, r, t, b };
    }
    const L = bestCombo ? bestCombo.l.p : M, R = bestCombo ? W - 1 - bestCombo.r.p : W - 1 - M;
    const T = bestCombo ? bestCombo.t.p : M, B = bestCombo ? H - 1 - bestCombo.b.p : H - 1 - M;
    const Hm = warpMatrix(corners, M);
    return [applyH(Hm, L, T), applyH(Hm, R, T), applyH(Hm, R, B), applyH(Hm, L, B)];
  }

  /**
   * Straighten: photos taken slightly off-angle leave each card side a little sloped after flattening.
   * Trace each side at many points (strongest colour step within a narrow window, measured with wide
   * median strips so printed lines and sleeve edges don't count), fit a straight line through the points
   * with outliers dropped, and rebuild the corners from those lines. Two rounds settle the perspective.
   */
  function straightenCorners(img, corners, rounds = 2) {
    const M = MARGIN, WIN = 16, k = 3, STRIP = [1, 2, 3, 4, 5, 6, 7];
    let cur = corners;
    for (let round = 0; round < rounds; round++) {
      const warped = warpCard(img, cur, M);
      const W = warped.width, H = warped.height;
      const lab = toLab(blur3(warped));
      const at = (x, y, c) => lab[(Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 3 + c];
      const fitSide = (side) => {
        const vertical = side === "left" || side === "right";
        const along = vertical ? H : W;
        const pt = (ln, dist) => {
          if (side === "left") return [dist, ln];
          if (side === "right") return [W - 1 - dist, ln];
          if (side === "top") return [ln, dist];
          return [ln, H - 1 - dist];
        };
        const pts = [];
        for (let ln = Math.round(along * 0.1); ln < along * 0.9; ln += 9) {
          let bestD = -1, bestV = 0;
          for (let d = M - WIN; d <= M + WIN; d++) {
            let dsq = 0;
            for (let c = 0; c < 3; c++) {
              const o = STRIP.map((m) => at(...pt(ln, d - m * k), c)).sort((x, y) => x - y)[3];
              const i2 = STRIP.map((m) => at(...pt(ln, d + m * k), c)).sort((x, y) => x - y)[3];
              dsq += (i2 - o) * (i2 - o);
            }
            if (dsq > bestV) { bestV = dsq; bestD = d; }
          }
          if (bestD >= 0 && Math.sqrt(bestV) > 10) pts.push([ln / along - 0.5, bestD]);
        }
        if (pts.length < 12) return { a: M, b: 0 };
        // Robust fit d = a + b * s, dropping points far from the line.
        let use = pts, a = M, b = 0;
        for (let it = 0; it < 4; it++) {
          const n = use.length;
          const ms = use.reduce((x, y) => x + y[0], 0) / n, md = use.reduce((x, y) => x + y[1], 0) / n;
          let sss = 0, ssd = 0;
          for (const [t, d] of use) { sss += (t - ms) ** 2; ssd += (t - ms) * (d - md); }
          b = sss ? ssd / sss : 0;
          a = md - b * ms;
          const res = pts.map(([t, d]) => Math.abs(d - (a + b * t)));
          const tol = Math.max(1.5, 2.5 * res.slice().sort((x, y) => x - y)[Math.floor(res.length / 2)]);
          const next = pts.filter((_, j) => res[j] <= tol);
          if (next.length < 10) break;
          use = next;
        }
        // Don't let a few stray points tilt the side wildly.
        if (Math.abs(b) > 40) b = 0;
        return { a, b };
      };
      const L = fitSide("left"), R = fitSide("right"), T = fitSide("top"), B = fitSide("bottom");
      const xL = (y) => L.a + L.b * (y / H - 0.5);
      const xR = (y) => W - 1 - (R.a + R.b * (y / H - 0.5));
      const yT = (x) => T.a + T.b * (x / W - 0.5);
      const yB = (x) => H - 1 - (B.a + B.b * (x / W - 0.5));
      const meet = (xf, yf) => {
        let x = xf(H / 2), y = yf(W / 2);
        for (let i = 0; i < 5; i++) { y = yf(x); x = xf(y); }
        return [x, y];
      };
      const Hm = warpMatrix(cur, M);
      cur = [meet(xL, yT), meet(xR, yT), meet(xR, yB), meet(xL, yB)].map(([x, y]) => applyH(Hm, x, y));
    }
    return cur;
  }

  /**
   * Re-check which line is the card's edge on each side, once the card is straight. A real card edge
   * stops at the card's corners, but a sleeve lip, laptop edge or desk line keeps going past the card's
   * sides. For the top and bottom, candidates are the peaks of the median colour-step profile; any that continue
   * beyond the neighbouring edges are rejected, and of the rest the one nearest the current edge wins.
   */
  function recheckEdges(img, corners) {
    const M = 80, k = 3, STRIP = [1, 2, 3, 4, 5, 6, 7];
    const warped = warpCard(img, corners, M);
    const W = warped.width, H = warped.height;
    const lab = toLab(blur3(warped));
    const at = (x, y, c) => lab[(Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 3 + c];
    // colour step across a side at (line position ln along the side, distance d from the image edge)
    const stepAt = (side, ln, d, narrow = false) => {
      const kk = narrow ? 2 : k, strip = narrow ? [1, 2, 3] : STRIP, mid = narrow ? 1 : 3;
      const pt = (dist) => {
        if (side === "left") return [dist, ln];
        if (side === "right") return [W - 1 - dist, ln];
        if (side === "top") return [ln, dist];
        return [ln, H - 1 - dist];
      };
      let dsq = 0;
      for (let c = 0; c < 3; c++) {
        const o = strip.map((m) => at(...pt(d - m * kk), c)).sort((x, y) => x - y)[mid];
        const i2 = strip.map((m) => at(...pt(d + m * kk), c)).sort((x, y) => x - y)[mid];
        dsq += (i2 - o) * (i2 - o);
      }
      return Math.sqrt(dsq);
    };
    const median = (arr) => arr.slice().sort((x, y) => x - y)[Math.floor(arr.length / 2)];
    const pick = (side) => {
      const vertical = side === "left" || side === "right";
      const along = vertical ? H : W;
      const inLines = [], outLines = [];
      for (let ln = Math.round(along * 0.25); ln < along * 0.75; ln += 9) inLines.push(ln);
      // just beyond the card's neighbouring edges (which sit at M from the image edges)
      for (let o = 10; o <= 34; o += 4) outLines.push(M - o, along - 1 - M + o);
      const prof = [];
      for (let d = 22; d <= 2 * M - 22; d++) prof[d] = median(inLines.map((ln) => stepAt(side, ln, d)));
      let maxV = 0;
      for (let d = 22; d <= 2 * M - 22; d++) maxV = Math.max(maxV, prof[d]);
      const cands = [];
      for (let d = 23; d < 2 * M - 22; d++) {
        if (!(prof[d] >= prof[d - 1] && prof[d] > prof[d + 1] && prof[d] >= Math.max(10, 0.35 * maxV))) continue;
        // Does this line carry on past the card's corners?
        const cont = median(outLines.map((ln) => stepAt(side, ln, d)));
        cands.push({ d, v: prof[d], cont });
      }
      const edges = cands.filter((c) => c.cont < 0.4 * c.v);
      if (!edges.length) return M;
      const strongest = Math.max(...edges.map((c) => c.v));
      const good = edges.filter((c) => c.v >= 0.5 * strongest);
      good.sort((x, y) => Math.abs(x.d - M) - Math.abs(y.d - M));
      return good[0].d;
    };
    // Only the top and bottom: in an upright photo that's where a sleeve's open end and desk or laptop
    // edges run. (A sleeve's side edge a few mm outside the card would make the card's own left/right
    // edges look like they continue.)
    const L = M, R = W - 1 - M, T = pick("top"), B = H - 1 - pick("bottom");
    const Hm = warpMatrix(corners, M);
    return [applyH(Hm, L, T), applyH(Hm, R, T), applyH(Hm, R, B), applyH(Hm, L, B)];
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
  function scan(img, mode = "auto", manualCorners = null) {
    let corners, cardConf;
    if (manualCorners) {
      corners = manualCorners;
      cardConf = 1;
    } else {
      const found = findCard(img, mode);
      ({ corners, confidence: cardConf } = found);
      if (found.method === "edges") corners = refineCorners(img, corners);
      if (found.method !== "full") {
        corners = straightenCorners(img, corners);
        if (found.method === "edges") corners = straightenCorners(img, recheckEdges(img, corners), 1);
      }
    }
    const warped = warpCard(img, corners, MARGIN);
    const m = measureBorders(warped, MARGIN);
    const W = warped.width, H = warped.height, e = m.edges;
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      warped,
      corners,
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

  return { scan, findCard, findCardEdges, refineCorners, straightenCorners, recheckEdges, warpCard, warpMatrix, applyH, measureBorders, CARD_W, CARD_H, MARGIN };
});
