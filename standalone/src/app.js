/* Card Grading Lab: standalone app. Two screens: scan, then report. Everything runs in the browser. */
"use strict";

const CRITERIA = window.GRADING_CRITERIA;
const ENV = window.GRADING_LAB_ENV || "file";  // "artifact" | "site" | "file"
const SIDES = ["front", "back"];
const COMPONENT_OF = {
  top_left: "corners", top_right: "corners", bottom_left: "corners", bottom_right: "corners",
  top: "edges", right: "edges", bottom: "edges", left: "edges", surface: "surface",
};
const SEV_RANK = { micro: 1, minor: 2, moderate: 3, major: 4 };
const SEV_TEXT = {
  micro: "Only under magnification or angled light",
  minor: "Visible on close inspection",
  moderate: "Obvious at arm's length",
  major: "Heavy damage",
};
const CONDITION_WORDS = [
  [10.5, "Pristine"], [10, "Gem Mint"], [9, "Mint"], [8, "NM-MT"], [7, "Near Mint"],
  [6, "Excellent-MT"], [5, "Excellent"], [4, "VG-EX"], [3, "Very Good"], [2, "Good"], [0, "Poor"],
];

const state = {
  view: "scan",
  scans: { front: null, back: null },  // {img: canvas, lines, width, height, confidence}
  thumbs: { front: null, back: null },
  centering: { front: { lr: 50, tb: 50 }, back: { lr: 50, tb: 50 } },
  defects: [],
  activeSide: "front",
  sheet: { side: null, location: null, type: null, severity: null },
  example: false,
  report: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pretty = (s) => s.replace(/_/g, " ");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtShare = (v) => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const splitText = (v) => `${fmtShare(v)}/${fmtShare(100 - v)}`;
const whereText = (d) => {
  const comp = COMPONENT_OF[d.location];
  return d.location === "surface" ? `${d.side} surface` : `${d.side} ${pretty(d.location)} ${comp === "corners" ? "corner" : "edge"}`;
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2800);
}

/* ---------------------------------------------------------------- storage */

const KEYS = { cards: "cardGradingLab.cards.v1", draft: "cardGradingLab.draft.v2" };

const localStore = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
  },
  cards() { return this.read(KEYS.cards, []); },
  saveCards(cards) { return this.write(KEYS.cards, cards); },
};

/* ---------------------------------------------------------------- images */

function canvasFromRGBA(rgba) {
  const c = document.createElement("canvas");
  c.width = rgba.width;
  c.height = rgba.height;
  c.getContext("2d").putImageData(new ImageData(rgba.data, rgba.width, rgba.height), 0, 0);
  return c;
}

/** Decode a photo (EXIF rotation applied, HEIC decoded by Safari), downscale it, return RGBA pixels. */
function readImage(file, maxSide = 2400) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const data = ctx.getImageData(0, 0, c.width, c.height);
      resolve({ width: data.width, height: data.height, data: data.data });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This image can't be opened. Try a JPEG or PNG photo."));
    };
    img.src = url;
  });
}

function thumbnail(warpedCanvas, margin, width = 200) {
  const w = warpedCanvas.width - 2 * margin, h = warpedCanvas.height - 2 * margin;
  const th = Math.round((h * width) / w);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = th;
  c.getContext("2d").drawImage(warpedCanvas, margin, margin, w, h, 0, 0, width, th);
  return c.toDataURL("image/jpeg", 0.8);
}

/** A sample "photo" of a slightly off-center card on a dark mat, used for the example. */
function samplePhoto(side) {
  const W = 1200, H = 1500;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#1d2127";
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.rotate(((side === "front" ? 2.5 : -1.8) * Math.PI) / 180);
  const cw = 750, ch = 1048;
  ctx.translate(-cw / 2, -ch / 2);
  const border = side === "front" ? { l: 44, r: 33, t: 44, b: 46 } : { l: 40, r: 44, t: 41, b: 47 };
  ctx.fillStyle = side === "front" ? "#f4cf2e" : "#1d58b0";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, cw, ch, 26);
  else ctx.rect(0, 0, cw, ch);
  ctx.fill();
  const iw = cw - border.l - border.r, ih = ch - border.t - border.b;
  const grad = ctx.createLinearGradient(0, 0, iw, ih);
  if (side === "front") {
    grad.addColorStop(0, "#f6a23c");
    grad.addColorStop(0.5, "#d2452e");
    grad.addColorStop(1, "#6b2a6e");
  } else {
    grad.addColorStop(0, "#2c7be5");
    grad.addColorStop(1, "#0d2a63");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(border.l, border.t, iw, ih);
  ctx.strokeStyle = "rgba(0,0,0,.45)";
  ctx.lineWidth = 3;
  ctx.strokeRect(border.l + 1.5, border.t + 1.5, iw - 3, ih - 3);
  if (side === "front") {
    ctx.fillStyle = "rgba(255,245,210,.85)";
    ctx.fillRect(border.l + 30, border.t + 90, iw - 60, 420);
    ctx.fillStyle = "#2b1d10";
    ctx.font = "bold 44px Georgia, serif";
    ctx.fillText("Charizard ex", border.l + 30, border.t + 60);
  } else {
    ctx.fillStyle = "#e9c23a";
    ctx.beginPath();
    ctx.arc(cw / 2, ch / 2, 170, 0, Math.PI * 2);
    ctx.fill();
  }
  const data = c.getContext("2d").getImageData(0, 0, W, H);
  return { width: W, height: H, data: data.data };
}

/* ---------------------------------------------------------------- scanning */

const shareOf = (a, b) => (a + b <= 0 ? 50 : (Math.max(a, b) / (a + b)) * 100);

function centeringFromLines(lines) {
  const { outer, inner } = lines;
  return {
    lr: shareOf(Math.max(0, inner.left - outer.left), Math.max(0, outer.right - inner.right)),
    tb: shareOf(Math.max(0, inner.top - outer.top), Math.max(0, outer.bottom - inner.bottom)),
  };
}

function applyScan(side, scan) {
  const img = canvasFromRGBA(scan.warped);
  state.scans[side] = { img, lines: scan.lines, width: scan.width, height: scan.height, confidence: scan.confidence.borders };
  state.thumbs[side] = thumbnail(img, scan.margin);
  state.centering[side] = centeringFromLines(scan.lines);
}

async function scanFile(side, file) {
  leaveExample();
  const slot = $(`.slot[data-side="${side}"]`);
  slot.classList.add("busy");
  $("#guide-wrap").classList.toggle("busy", state.view === "report");
  try {
    const pixels = await readImage(file);
    await new Promise((r) => setTimeout(r, 30));  // let the busy overlay paint
    applyScan(side, Vision.scan(pixels, "auto"));
    if (state.scans[side].confidence < 0.6) toast(`${cap(side)}: the edges were hard to find. Check the guide lines in the report.`);
  } catch (err) {
    toast(err.message || "Couldn't measure this photo.");
  } finally {
    slot.classList.remove("busy");
    $("#guide-wrap").classList.remove("busy");
  }
  renderSlots();
  if (state.view === "report") {
    state.activeSide = side;
    renderCentering();
    runGrade();
  }
}

function renderSlots() {
  for (const side of SIDES) {
    const slot = $(`.slot[data-side="${side}"]`);
    const img = $(".slot-img", slot);
    const thumb = state.thumbs[side];
    const done = !!state.scans[side];
    slot.classList.toggle("done", done);
    img.hidden = !done;
    if (done) img.src = thumb;
    $(".slot-meta", slot).textContent = done
      ? `${splitText(state.centering[side].lr)} · ${splitText(state.centering[side].tb)}`
      : "Tap to add photo";
  }
  const front = !!state.scans.front, back = !!state.scans.back;
  $("#get-report").disabled = !(front && back);
  $("#front-only").hidden = !(front && !back);
}

/* ---------------------------------------------------------------- centering editor */

const guide = {
  canvas: null, ctx: null, drag: null, pointer: null,

  init() {
    this.canvas = $("#guide-canvas");
    this.ctx = this.canvas.getContext("2d");
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e));
    c.addEventListener("pointerleave", () => { if (!this.drag) { this.pointer = null; this.draw(); } });
    // On touch screens, block page scrolling only when the finger lands on a guide line.
    c.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1 && this.scan() && this.hit(this.toNative(e.touches[0], "touch"))) e.preventDefault();
    }, { passive: false });
    c.addEventListener("touchmove", (e) => { if (this.drag) e.preventDefault(); }, { passive: false });
  },

  scan() { return state.scans[state.activeSide]; },

  show() {
    const s = this.scan();
    $("#guide-wrap").classList.toggle("empty", !s);
    if (!s) {
      $("#guide-empty-text").textContent = state.thumbs[state.activeSide]
        ? "The photo isn't kept after saving. Retake it to adjust the guides, or type the ratios below."
        : `No ${state.activeSide} photo. Add one, or type the ratios below.`;
      return;
    }
    this.canvas.width = s.width;
    this.canvas.height = s.height;
    this.draw();
  },

  toNative(e, pointerType = e.pointerType) {
    const r = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k, touch: pointerType === "touch" || pointerType === "pen" };
  },

  hit(p) {
    const s = this.scan();
    const tol = (p.touch ? 22 : 10) * p.k;
    let best = null;
    for (const kind of ["inner", "outer"]) {
      for (const edge of ["left", "right", "top", "bottom"]) {
        const v = s.lines[kind][edge];
        const d = edge === "left" || edge === "right" ? Math.abs(p.x - v) : Math.abs(p.y - v);
        if (d <= tol && (!best || d < best.d)) best = { kind, edge, d };
      }
    }
    return best;
  },

  onDown(e) {
    if (!this.scan()) return;
    const p = this.toNative(e);
    const h = this.hit(p);
    if (!h) return;
    leaveExample();
    this.drag = h;
    this.pointer = p;
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    this.draw();
  },

  onMove(e) {
    const s = this.scan();
    if (!s) return;
    const p = this.toNative(e);
    this.pointer = p;
    if (this.drag) {
      const { kind, edge } = this.drag;
      const vertical = edge === "left" || edge === "right";
      const max = vertical ? this.canvas.width : this.canvas.height;
      s.lines[kind][edge] = Math.max(0, Math.min(max, vertical ? p.x : p.y));
      state.centering[state.activeSide] = centeringFromLines(s.lines);
      renderRatioInputs();
      scheduleGrade();
    } else {
      const h = this.hit(p);
      this.canvas.style.cursor = h ? (h.edge === "left" || h.edge === "right" ? "ew-resize" : "ns-resize") : "default";
    }
    this.draw();
  },

  onUp(e) {
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    this.draw();
  },

  draw() {
    const s = this.scan();
    if (!s) return;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(s.img, 0, 0);
    this.drawLines(ctx, s.lines, canvas.width, canvas.height, 2.5);
    if (this.drag && this.pointer) this.drawLoupe(s);
  },

  drawLines(ctx, lines, W, H, width) {
    const css = getComputedStyle(document.documentElement);
    const color = { outer: css.getPropertyValue("--outer").trim() || "#38bdf8", inner: css.getPropertyValue("--inner").trim() || "#f472b6" };
    for (const kind of ["outer", "inner"]) {
      ctx.strokeStyle = color[kind];
      ctx.lineWidth = width;
      ctx.setLineDash(kind === "outer" ? [10, 6] : []);
      for (const edge of ["left", "right", "top", "bottom"]) {
        const v = lines[kind][edge];
        ctx.beginPath();
        if (edge === "left" || edge === "right") { ctx.moveTo(v, 0); ctx.lineTo(v, H); }
        else { ctx.moveTo(0, v); ctx.lineTo(W, v); }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  },

  drawLoupe(s) {
    const { ctx, canvas } = this;
    const zoom = 4, src = 60, size = src * zoom;
    const p = this.pointer;
    const dx = p.x > canvas.width / 2 ? 12 : canvas.width - size - 12;
    const dy = p.y < size + 60 ? canvas.height - size - 12 : 12;  // stay clear of the finger
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, size, size);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(dx - (p.x - src / 2) * zoom, dy - (p.y - src / 2) * zoom);
    ctx.scale(zoom, zoom);
    ctx.drawImage(s.img, 0, 0);
    this.drawLines(ctx, s.lines, canvas.width, canvas.height, 0.6);
    ctx.restore();
    ctx.strokeStyle = "#f2b53a";
    ctx.lineWidth = 3;
    ctx.strokeRect(dx, dy, size, size);
  },
};

function renderRatioInputs() {
  const c = state.centering[state.activeSide];
  const lr = $("#ratio-lr"), tb = $("#ratio-tb");
  if (document.activeElement !== lr) lr.value = fmtShare(c.lr);
  if (document.activeElement !== tb) tb.value = fmtShare(c.tb);
  $("#lr-other").textContent = fmtShare(100 - c.lr);
  $("#tb-other").textContent = fmtShare(100 - c.tb);
  const s = state.scans[state.activeSide];
  const conf = $("#conf");
  conf.textContent = s ? `Edge detection ${Math.round(s.confidence * 100)}%` : "Typed in";
  conf.classList.toggle("low", !!s && s.confidence < 0.6);
}

function renderCentering() {
  $$("#centering-section .segmented button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.side === state.activeSide)));
  guide.show();
  renderRatioInputs();
}

/* ---------------------------------------------------------------- defects */

function buildMap(fig, side) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 150 210");
  const el = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  svg.append(el("rect", { x: 1, y: 1, width: 148, height: 208, rx: 10, class: "card-body" }));
  const zones = {
    top_left: [3, 3, 28, 28], top_right: [119, 3, 28, 28],
    bottom_left: [3, 179, 28, 28], bottom_right: [119, 179, 28, 28],
    top: [34, 3, 82, 18], bottom: [34, 189, 82, 18], left: [3, 34, 18, 142], right: [129, 34, 18, 142],
    surface: [27, 27, 96, 156],
  };
  for (const [loc, [x, y, w, h]] of Object.entries(zones)) {
    const r = el("rect", { x, y, width: w, height: h, rx: 5, class: "zone", "data-loc": loc, "data-side": side, tabindex: 0, role: "button", "aria-label": `${side} ${pretty(loc)}` });
    r.addEventListener("click", () => openSheet(side, loc));
    r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSheet(side, loc); } });
    svg.append(r);
  }
  fig.append(svg);
}

function openSheet(side, location) {
  const comp = COMPONENT_OF[location];
  state.sheet = { side, location, type: null, severity: null };
  $("#sheet-where").textContent = cap(whereText({ side, location }));
  const chips = $("#type-chips");
  chips.innerHTML = "";
  for (const [key, spec] of Object.entries(CRITERIA.defects.types)) {
    if (!spec.applies_to.includes(comp)) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.type = key;
    b.textContent = spec.label;
    b.addEventListener("click", () => { state.sheet.type = key; updateSheet(); });
    chips.append(b);
  }
  $("#defect-note").value = "";
  updateSheet();
  $("#defect-sheet").hidden = false;
}

function closeSheet() {
  $("#defect-sheet").hidden = true;
}

function updateSheet() {
  const { type, severity } = state.sheet;
  $$("#type-chips button").forEach((b) => b.classList.toggle("active", b.dataset.type === type));
  $$("#sev-seg button").forEach((b) => b.classList.toggle("active", b.dataset.sev === severity));
  $("#sheet-add").disabled = !(type && severity);
  if (severity) {
    const capValue = type ? CRITERIA.defects.types[type].caps[severity] : null;
    const effect = capValue == null ? "" : capValue >= 10 ? " · still allows Gem Mint" : ` · limits this area to ${capValue}`;
    $("#sev-hint").textContent = SEV_TEXT[severity] + effect;
  }
}

function addDefectFromSheet() {
  leaveExample();
  const { side, location, type, severity } = state.sheet;
  const note = $("#defect-note").value.trim();
  state.defects.push({ side, location, type, severity, note: note || null });
  closeSheet();
  renderDefects();
  runGrade();
}

function paintZones() {
  $$(".zone").forEach((z) => {
    z.classList.remove("sev-micro", "sev-minor", "sev-moderate", "sev-major");
    const worst = state.defects
      .filter((d) => d.side === z.dataset.side && d.location === z.dataset.loc)
      .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])[0];
    if (worst) z.classList.add(`sev-${worst.severity}`);
  });
}

function renderDefects() {
  const list = $("#defect-list");
  list.innerHTML = "";
  if (!state.defects.length) {
    list.innerHTML = '<li class="empty">Nothing logged yet, so corners, edges and surface count as flawless.</li>';
  }
  state.defects.forEach((d, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="sev-dot ${d.severity}" aria-hidden="true"></span>
      <span class="d-text"><span class="d-label"></span><br><span class="where"></span></span>
      <button type="button" class="remove" aria-label="Remove defect">✕</button>`;
    $(".d-label", li).textContent = CRITERIA.defects.types[d.type].label;
    $(".where", li).textContent = `${cap(d.severity)} · ${whereText(d)}${d.note ? ` · ${d.note}` : ""}`;
    $(".remove", li).addEventListener("click", () => {
      leaveExample();
      state.defects.splice(i, 1);
      renderDefects();
      runGrade();
    });
    list.append(li);
  });
  const n = state.defects.length;
  $("#defect-summary").textContent = n ? `${n} logged` : "None logged";
  paintZones();
}

/* ---------------------------------------------------------------- grading + report */

function assessment() {
  return {
    card: {
      name: $("#card-name").value.trim(),
      set_name: $("#card-set").value.trim(),
      number: $("#card-number").value.trim(),
      holo: false,
      notes: "",
    },
    centering: state.centering,
    defects: state.defects,
  };
}

let gradeTimer = null;
function scheduleGrade() {
  clearTimeout(gradeTimer);
  gradeTimer = setTimeout(runGrade, 60);
}

function runGrade() {
  const a = assessment();
  try {
    state.report = Grading.gradeAll(a, CRITERIA);
  } catch (err) {
    toast(`Grading failed: ${err.message}`);
    return;
  }
  renderReport();
  saveDraft();
}

const bigGrade = (g) => (g.tier >= 99 ? "—" : g.grade % 1 === 0 ? g.grade.toFixed(0) : g.grade.toFixed(1));
const isPristine = (g) => g.label.startsWith("Pristine");
const conditionWord = (v) => CONDITION_WORDS.find(([min]) => v >= min)[1];
const status = (v) => (v >= 10 ? "good" : v >= 8.5 ? "warn" : "bad");

// Rank for the "Best shot" badge: the highest grade wins, with Pristine and Black Label above a plain 10.
const gradeRank = (g) => (g.tier >= 99 ? -1 : g.label.includes("Black Label") ? 11 : isPristine(g) ? 10.5 : g.grade);

function bestCompany(report) {
  let best = null;
  for (const g of Object.values(report.grades)) if (!best || gradeRank(g) > gradeRank(best)) best = g;
  return best;
}

function renderTiles(report) {
  const box = $("#tiles");
  box.innerHTML = "";
  const top = bestCompany(report);
  for (const g of Object.values(report.grades)) {
    const best = g === top && g.tier < 99;
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile" + (best ? " best" : "");
    tile.dataset.co = g.company;
    tile.innerHTML = `<span class="tile-co">${g.company}${best ? '<span class="tile-badge">Best shot</span>' : ""}</span>
      <span class="tile-grade"></span><span class="tile-label"></span><span class="tile-sub"></span>`;
    $(".tile-grade", tile).innerHTML = bigGrade(g) + (isPristine(g) ? "<small>P</small>" : "");
    $(".tile-label", tile).textContent = g.label.replace(/\s*\d+(\.\d)?$/, "").replace(/ 10 \(Black Label\)$/, " · Black Label");
    $(".tile-sub", tile).textContent = g.company === "TAG" && g.score != null ? `${g.score} / 1000` : g.qualifiers.length ? g.qualifiers.join(" · ") : " ";
    tile.addEventListener("click", () => {
      const d = $(`.company[data-co="${g.company}"]`);
      d.open = true;
      d.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    box.append(tile);
  }
  $("#best-line").textContent = top.tier >= 99
    ? "This card looks altered, so no company would give it a number."
    : `Your best shot is ${top.company} ${top.label}. Tap a grade for the breakdown.`;
}

function renderOverview(report) {
  const psa = report.grades.PSA;
  const list = $("#overview");
  list.innerHTML = "";
  const rows = [];
  if (psa.tier >= 99) {
    rows.push({ name: "Authenticity", detail: "Logged as trimmed, recolored or altered", pill: "Altered", cls: "bad" });
  } else {
    const f = state.centering.front, b = state.centering.back;
    rows.push({
      name: "Centering",
      detail: `Front ${splitText(Math.max(f.lr, f.tb))} · Back ${splitText(Math.max(b.lr, b.tb))} (worst axis)`,
      mono: true, value: psa.subgrades.centering,
    });
    for (const comp of ["corners", "edges", "surface"]) {
      const ds = state.defects.filter((d) => COMPONENT_OF[d.location] === comp);
      const worst = ds.sort((x, y) => SEV_RANK[y.severity] - SEV_RANK[x.severity])[0];
      rows.push({
        name: cap(comp),
        detail: worst ? `${cap(worst.severity)} ${CRITERIA.defects.types[worst.type].label.toLowerCase()}${ds.length > 1 ? ` +${ds.length - 1} more` : ""}` : "No issues logged",
        value: psa.subgrades[comp],
      });
    }
  }
  for (const r of rows) {
    const li = document.createElement("li");
    const pill = r.pill || conditionWord(r.value);
    const cls = r.cls || status(r.value);
    li.innerHTML = `<span class="ov-name"></span><span class="pill ${cls}"></span><span class="ov-detail${r.mono ? " mono" : ""}"></span>`;
    $(".ov-name", li).textContent = r.name;
    $(".pill", li).textContent = pill;
    $(".ov-detail", li).textContent = r.detail;
    list.append(li);
  }
  const f = state.centering.front, b = state.centering.back;
  $("#centering-summary").textContent = `${splitText(Math.max(f.lr, f.tb))} · ${splitText(Math.max(b.lr, b.tb))}`;
}

function subLabel(company, v) {
  if (typeof v !== "number" || company === "TAG") return String(v);
  return v >= 10.5 ? "10P" : String(v);
}

function renderCompanies(report) {
  const box = $("#companies");
  const open = new Set($$(".company[open]", box).map((d) => d.dataset.co));
  box.innerHTML = "";
  for (const g of Object.values(report.grades)) {
    const d = document.createElement("details");
    d.className = "company";
    d.dataset.co = g.company;
    d.open = open.has(g.company);
    d.innerHTML = `<summary><span class="co-code">${g.company}</span><span class="co-label"></span><span class="co-grade"></span></summary>
      <div class="co-body"><div class="chips"></div><p class="co-alt"></p><ul class="why"></ul><ul class="notes"></ul></div>`;
    $(".co-label", d).textContent = g.label;
    $(".co-grade", d).textContent = bigGrade(g);
    const chips = $(".chips", d);
    if (g.score != null) chips.insertAdjacentHTML("beforeend", `<span class="chip">TAG Score <b>${g.score}</b></span>`);
    for (const q of g.qualifiers) {
      const c = document.createElement("span");
      c.className = "chip q";
      c.textContent = q;
      chips.append(c);
    }
    for (const [k, v] of Object.entries(g.subgrades)) {
      const c = document.createElement("span");
      c.className = "chip";
      c.innerHTML = `${k} <b></b>`;
      $("b", c).textContent = subLabel(g.company, v);
      chips.append(c);
    }
    const alt = $(".co-alt", d);
    alt.textContent = g.alternatives.join(" · ");
    alt.hidden = !g.alternatives.length;
    const why = $(".why", d);
    for (const r of g.limiting_factors.length ? g.limiting_factors : ["Nothing is holding this card back at this company."]) {
      const li = document.createElement("li");
      li.textContent = r;
      why.append(li);
    }
    const notes = $(".notes", d);
    for (const n of g.notes) {
      const li = document.createElement("li");
      li.textContent = n;
      notes.append(li);
    }
    box.append(d);
  }
}

function renderThumbs() {
  const box = $("#thumbs");
  box.innerHTML = "";
  for (const side of SIDES) {
    const src = state.thumbs[side];
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = `${side} of card`;
      box.append(img);
    } else {
      box.insertAdjacentHTML("beforeend", '<span class="ph" aria-hidden="true"></span>');
    }
  }
}

function renderReport() {
  const report = state.report;
  if (!report) return;
  renderTiles(report);
  renderOverview(report);
  renderCompanies(report);
  $("#disclaimer").textContent = report.disclaimer;
}

/* ---------------------------------------------------------------- views */

function setView(view, { animate = true } = {}) {
  state.view = view;
  $("#app").dataset.view = view;
  $("#scan-screen").hidden = view !== "scan";
  $("#report-screen").hidden = view !== "report";
  window.scrollTo({ top: 0 });
  if (view === "report") {
    const screen = $("#report-screen");
    screen.classList.remove("enter");
    if (animate) { void screen.offsetWidth; screen.classList.add("enter"); }
    renderThumbs();
    renderCentering();
    renderDefects();
    runGrade();
  } else {
    renderSlots();
    renderResume();
  }
}

function resetCard() {
  state.scans = { front: null, back: null };
  state.thumbs = { front: null, back: null };
  state.centering = { front: { lr: 50, tb: 50 }, back: { lr: 50, tb: 50 } };
  state.defects = [];
  state.activeSide = "front";
  state.example = false;
  state.report = null;
  for (const id of ["#card-name", "#card-set", "#card-number"]) $(id).value = "";
  $("#example-note").hidden = true;
}

function newScan() {
  resetCard();
  localStore.remove(KEYS.draft);
  setView("scan");
}

/* ---------------------------------------------------------------- example + drafts */

function showExample() {
  resetCard();
  for (const side of SIDES) applyScan(side, Vision.scan(samplePhoto(side)));
  state.defects = [
    { side: "back", location: "top_right", type: "corner_whitening", severity: "minor", note: null },
    { side: "front", location: "surface", type: "holo_scratch", severity: "micro", note: "Only under a lamp" },
  ];
  $("#card-name").value = "Charizard ex";
  $("#card-set").value = "Obsidian Flames";
  $("#card-number").value = "223/197";
  state.example = true;
  $("#example-note").hidden = false;
  setView("report");
}

function leaveExample() {
  if (!state.example) return;
  state.example = false;
  $("#example-note").hidden = true;
}

function saveDraft() {
  if (state.example || state.view !== "report") return;
  localStore.write(KEYS.draft, { ...assessment(), thumbs: state.thumbs, saved_at: new Date().toISOString() });
}

function renderResume() {
  const draft = localStore.read(KEYS.draft, null);
  const btn = $("#resume");
  btn.hidden = !(draft && draft.centering);
  if (!btn.hidden) btn.textContent = `Resume ${draft.card && draft.card.name ? draft.card.name : "last card"}`;
}

function loadAssessment(a, thumbs) {
  resetCard();
  $("#card-name").value = a.card.name || "";
  $("#card-set").value = a.card.set_name || "";
  $("#card-number").value = a.card.number || "";
  state.centering = { front: { ...a.centering.front }, back: { ...a.centering.back } };
  state.defects = (a.defects || []).map((d) => ({ ...d }));
  state.thumbs = { front: (thumbs && thumbs.front) || null, back: (thumbs && thumbs.back) || null };
  setView("report");
}

/* ---------------------------------------------------------------- history */

function renderHistory() {
  const list = $("#history-list");
  list.innerHTML = "";
  const cards = localStore.cards();
  if (!cards.length) {
    list.innerHTML = '<li class="empty">No saved cards yet. Scan a card and tap Save to History.</li>';
    return;
  }
  for (const c of cards) {
    const li = document.createElement("li");
    li.innerHTML = `${c.front_thumb ? '<img alt="">' : '<span class="ph"></span>'}
      <div><div class="h-name"></div><div class="h-meta"></div><div class="h-grades"></div></div>
      <button type="button" class="del" aria-label="Delete saved card">✕</button>`;
    if (c.front_thumb) $("img", li).src = c.front_thumb;
    const card = c.assessment.card;
    $(".h-name", li).textContent = card.name || "Unnamed card";
    $(".h-meta", li).textContent = [card.set_name, card.number, new Date(c.created_at).toLocaleDateString()].filter(Boolean).join(" · ");
    $(".h-grades", li).textContent = Object.values(c.report.grades).map((g) => `${g.company} ${bigGrade(g)}`).join(" · ");
    li.addEventListener("click", () => {
      $("#history").hidden = true;
      loadAssessment(c.assessment, { front: c.front_thumb, back: c.back_thumb });
      toast("Loaded from History");
    });
    const del = $(".del", li);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (del.dataset.armed) {  // second tap confirms
        localStore.saveCards(localStore.cards().filter((x) => x.id !== c.id));
        renderHistory();
        toast("Deleted");
        return;
      }
      del.dataset.armed = "1";
      del.textContent = "Delete";
      del.classList.add("danger");
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "✕"; del.classList.remove("danger"); } }, 3000);
    });
    list.append(li);
  }
}

function openHistory() {
  renderHistory();
  $("#history").hidden = false;
}

function saveCard() {
  leaveExample();
  runGrade();
  const cards = localStore.cards();
  cards.unshift({
    id: `${Date.now()}`,
    created_at: new Date().toISOString(),
    assessment: assessment(),
    report: state.report,
    front_thumb: state.thumbs.front,
    back_thumb: state.thumbs.back,
  });
  if (localStore.saveCards(cards)) toast(`Saved. ${cards.length} card${cards.length === 1 ? "" : "s"} in History.`);
  else toast("This browser isn't letting the app save. Copy a backup from History to keep your cards.");
}

function backupText() {
  return JSON.stringify({ app: "card-grading-lab", version: 1, exported_at: new Date().toISOString(), cards: localStore.cards() });
}

function restoreFrom(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    toast("That isn't a Card Grading Lab backup. Paste the whole backup text.");
    return;
  }
  const incoming = Array.isArray(data) ? data : data.cards;
  if (!Array.isArray(incoming)) {
    toast("That isn't a Card Grading Lab backup.");
    return;
  }
  const cards = localStore.cards();
  const ids = new Set(cards.map((c) => c.id));
  let added = 0;
  for (const c of incoming) {
    if (!c || !c.id || !c.assessment || ids.has(c.id)) continue;
    try {
      c.report = Grading.gradeAll(c.assessment, CRITERIA);  // re-grade with the current rules
    } catch (_) {
      continue;
    }
    cards.push(c);
    ids.add(c.id);
    added++;
  }
  cards.sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
  localStore.saveCards(cards);
  renderHistory();
  toast(added ? `Restored ${added} card${added === 1 ? "" : "s"}.` : "Those cards are already here.");
}

/* ---------------------------------------------------------------- init */

function init() {
  guide.init();
  for (const fig of $$(".map")) buildMap(fig, fig.dataset.side);

  // Scan screen
  for (const side of SIDES) {
    const input = $(`#file-${side}`);
    input.addEventListener("change", (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) scanFile(side, f);
    });
    const slot = $(`.slot[data-side="${side}"]`);
    slot.tabIndex = 0;
    slot.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  }
  $("#get-report").addEventListener("click", () => setView("report"));
  $("#front-only").addEventListener("click", () => setView("report"));
  $("#try-example").addEventListener("click", showExample);
  $("#resume").addEventListener("click", () => {
    const draft = localStore.read(KEYS.draft, null);
    if (draft) loadAssessment(draft, draft.thumbs);
  });

  // Report screen
  $("#back-to-scan").addEventListener("click", newScan);
  $("#new-scan").addEventListener("click", newScan);
  $("#scan-own").addEventListener("click", newScan);
  $("#save-card").addEventListener("click", saveCard);
  for (const id of ["#open-history", "#open-history-2"]) $(id).addEventListener("click", openHistory);
  $$("#centering-section .segmented button").forEach((b) => b.addEventListener("click", () => {
    state.activeSide = b.dataset.side;
    renderCentering();
  }));
  for (const [id, key] of [["#ratio-lr", "lr"], ["#ratio-tb", "tb"]]) {
    $(id).addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (isNaN(v)) return;
      leaveExample();
      state.centering[state.activeSide][key] = Math.min(100, Math.max(50, v));
      renderRatioInputs();
      scheduleGrade();
    });
    $(id).addEventListener("blur", renderRatioInputs);
  }
  $("#retake-file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) scanFile(state.activeSide, f);
  });
  for (const id of ["#card-name", "#card-set", "#card-number"]) {
    $(id).addEventListener("input", () => { leaveExample(); saveDraft(); });
  }

  // Defect sheet
  $$("#sev-seg button").forEach((b) => b.addEventListener("click", () => { state.sheet.severity = b.dataset.sev; updateSheet(); }));
  $("#sheet-add").addEventListener("click", addDefectFromSheet);
  $("#sheet-cancel").addEventListener("click", closeSheet);
  $("#defect-sheet").addEventListener("click", (e) => { if (e.target.id === "defect-sheet") closeSheet(); });

  // History sheet
  $("#close-history").addEventListener("click", () => ($("#history").hidden = true));
  $("#history").addEventListener("click", (e) => { if (e.target.id === "history") $("#history").hidden = true; });
  $("#copy-backup").addEventListener("click", () => {
    const text = backupText();
    const box = $("#backup-text");
    box.value = text;
    const fallback = () => { box.focus(); box.select(); toast("Backup is in the box below. Select all and copy it."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast("Backup copied. Paste it into Notes or an email to keep it."), fallback);
    } else {
      fallback();
    }
  });
  /*SITE_ONLY_START*/
  if (ENV === "site" || ENV === "file") {
    const dl = $("#download-backup");
    dl.hidden = false;
    dl.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([backupText()], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `card-grading-lab-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  /*SITE_ONLY_END*/
  $("#restore-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) restoreFrom(await f.text());
  });
  $("#restore-text").addEventListener("click", () => restoreFrom($("#backup-text").value));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeSheet();
    $("#history").hidden = true;
  });

  setView("scan", { animate: false });
}

init();
