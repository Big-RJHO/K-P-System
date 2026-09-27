/* Card Grading Lab: standalone app. Everything runs in the browser, and history is kept in localStorage. */
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

const state = {
  centering: { front: { lr: 50, tb: 50 }, back: { lr: 50, tb: 50 } },
  defects: [],
  thumbs: { front: null, back: null },
  pick: { side: null, location: null, severity: null },
  example: false,
  report: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pretty = (s) => s.replace(/_/g, " ");
const fmtShare = (v) => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
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

const KEYS = { cards: "cardGradingLab.cards.v1", draft: "cardGradingLab.draft.v1" };

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

/**
 * Decode a photo, apply its EXIF rotation, downscale it, and return RGBA pixels.
 * Safari decodes iPhone HEIC photos here too.
 */
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

function thumbnail(warped, margin) {
  const w = warped.width - 2 * margin, h = warped.height - 2 * margin;
  const tw = 160, th = Math.round((h * tw) / w);
  const c = document.createElement("canvas");
  c.width = tw;
  c.height = th;
  c.getContext("2d").drawImage(canvasFromRGBA(warped), margin, margin, w, h, 0, 0, tw, th);
  return c.toDataURL("image/jpeg", 0.75);
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
  ctx.roundRect ? ctx.roundRect(0, 0, cw, ch, 26) : ctx.rect(0, 0, cw, ch);
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

/* ---------------------------------------------------------------- centering */

class SideScanner {
  constructor(root, side) {
    this.side = side;
    root.append($("#side-template").content.cloneNode(true));
    $("h3", root).textContent = side === "front" ? "Front" : "Back";
    this.zone = $(".dropzone", root);
    this.canvas = $("canvas", root);
    this.ctx = this.canvas.getContext("2d");
    this.lrInput = $(".lr", root);
    this.tbInput = $(".tb", root);
    this.lrInput.id = `${side}-lr`;
    this.tbInput.id = `${side}-tb`;
    this.lrOther = $(".lr-other", root);
    this.tbOther = $(".tb-other", root);
    this.confEl = $(".conf", root);
    this.cropped = $(".cropped", root);
    this.cropped.id = `${side}-cropped`;
    $$("input[type=file]", root).forEach((input, i) => (input.id = `${side}-file-${i}`));
    this.canvas.setAttribute("aria-label", `${side} scan with centering guides`);
    this.img = null;
    this.lines = null;
    this.drag = null;
    this.pointer = null;

    for (const input of $$("input[type=file]", root)) {
      input.addEventListener("change", (e) => {
        if (e.target.files[0]) this.upload(e.target.files[0]);
        e.target.value = "";
      });
    }
    this.zone.addEventListener("dragover", (e) => { e.preventDefault(); this.zone.classList.add("drag"); });
    this.zone.addEventListener("dragleave", () => this.zone.classList.remove("drag"));
    this.zone.addEventListener("drop", (e) => {
      e.preventDefault();
      this.zone.classList.remove("drag");
      if (e.dataTransfer.files[0]) this.upload(e.dataTransfer.files[0]);
    });
    for (const input of [this.lrInput, this.tbInput]) input.addEventListener("input", () => this.manualChange());
    this.canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.onUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this.onUp(e));
    this.canvas.addEventListener("pointerleave", () => { if (!this.drag) { this.pointer = null; this.draw(); } });
    // On touch screens, block page scrolling only when the finger lands on a guide.
    this.canvas.addEventListener("touchstart", (e) => {
      if (!this.lines || e.touches.length !== 1) return;
      if (this.hit(this.toNative(e.touches[0], "touch"))) e.preventDefault();
    }, { passive: false });
    this.canvas.addEventListener("touchmove", (e) => { if (this.drag) e.preventDefault(); }, { passive: false });
  }

  async upload(file) {
    leaveExample();
    this.zone.classList.add("busy");
    try {
      const pixels = await readImage(file);
      await new Promise((r) => setTimeout(r, 30));  // let the "Measuring…" overlay paint
      this.loadScan(Vision.scan(pixels, this.cropped.checked ? "cropped" : "auto"));
    } catch (err) {
      toast(err.message || "Couldn't measure this photo.");
    } finally {
      this.zone.classList.remove("busy");
    }
  }

  loadScan(scan, { quiet = false } = {}) {
    this.img = canvasFromRGBA(scan.warped);
    this.canvas.width = scan.width;
    this.canvas.height = scan.height;
    this.lines = scan.lines;
    state.thumbs[this.side] = thumbnail(scan.warped, scan.margin);
    this.zone.classList.add("has-image");
    const conf = scan.confidence.borders;
    this.confEl.textContent = `Auto-detect confidence ${Math.round(conf * 100)}%`;
    this.confEl.classList.toggle("low", conf < 0.6);
    if (conf < 0.6 && !quiet) toast(`${this.side === "front" ? "Front" : "Back"}: low confidence. Check the guides.`);
    this.fromLines();
  }

  clear() {
    this.img = null;
    this.lines = null;
    this.zone.classList.remove("has-image");
    this.confEl.textContent = "";
    this.confEl.classList.remove("low");
    this.setValues(50, 50);
  }

  setValues(lr, tb) {
    this.lrInput.value = fmtShare(lr);
    this.tbInput.value = fmtShare(tb);
    this.lrOther.textContent = fmtShare(100 - lr);
    this.tbOther.textContent = fmtShare(100 - tb);
    state.centering[this.side] = { lr: +lr.toFixed(2), tb: +tb.toFixed(2) };
  }

  manualChange() {
    leaveExample();
    const clamp = (v) => Math.min(100, Math.max(50, isNaN(v) ? 50 : v));
    const lr = clamp(parseFloat(this.lrInput.value));
    const tb = clamp(parseFloat(this.tbInput.value));
    this.lrOther.textContent = fmtShare(100 - lr);
    this.tbOther.textContent = fmtShare(100 - tb);
    state.centering[this.side] = { lr, tb };
    scheduleGrade();
  }

  fromLines() {
    const { outer, inner } = this.lines;
    const share = (a, b) => (a + b <= 0 ? 50 : (Math.max(a, b) / (a + b)) * 100);
    const L = inner.left - outer.left, R = outer.right - inner.right;
    const T = inner.top - outer.top, B = outer.bottom - inner.bottom;
    this.setValues(share(Math.max(0, L), Math.max(0, R)), share(Math.max(0, T), Math.max(0, B)));
    this.draw();
    scheduleGrade();
  }

  toNative(e, pointerType = e.pointerType) {
    const r = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k, touch: pointerType === "touch" || pointerType === "pen" };
  }

  hit(p) {
    const tol = (p.touch ? 22 : 10) * p.k;  // fingers need a bigger target
    let best = null;
    for (const kind of ["inner", "outer"]) {
      for (const edge of ["left", "right", "top", "bottom"]) {
        const v = this.lines[kind][edge];
        const d = edge === "left" || edge === "right" ? Math.abs(p.x - v) : Math.abs(p.y - v);
        if (d <= tol && (!best || d < best.d)) best = { kind, edge, d };
      }
    }
    return best;
  }

  onDown(e) {
    if (!this.lines) return;
    const p = this.toNative(e);
    const h = this.hit(p);
    if (!h) return;
    leaveExample();
    this.drag = h;
    this.pointer = p;
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    this.draw();
  }

  onMove(e) {
    if (!this.lines) return;
    const p = this.toNative(e);
    this.pointer = p;
    if (this.drag) {
      const { kind, edge } = this.drag;
      const vertical = edge === "left" || edge === "right";
      const max = vertical ? this.canvas.width : this.canvas.height;
      this.lines[kind][edge] = Math.max(0, Math.min(max, vertical ? p.x : p.y));
      this.fromLines();
    } else {
      const h = this.hit(p);
      this.canvas.style.cursor = h ? (h.edge === "left" || h.edge === "right" ? "ew-resize" : "ns-resize") : "crosshair";
      this.draw();
    }
  }

  onUp(e) {
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    this.draw();
  }

  draw() {
    if (!this.img) return;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.img, 0, 0);
    this.drawLines(ctx, canvas.width, canvas.height, 2);
    if (this.drag && this.pointer) this.drawLoupe();
  }

  drawLines(ctx, W, H, width) {
    const css = getComputedStyle(document.documentElement);
    const color = { outer: css.getPropertyValue("--outer").trim() || "#38bdf8", inner: css.getPropertyValue("--inner").trim() || "#f472b6" };
    for (const kind of ["outer", "inner"]) {
      ctx.strokeStyle = color[kind];
      ctx.lineWidth = width;
      ctx.setLineDash(kind === "outer" ? [10, 6] : []);
      for (const edge of ["left", "right", "top", "bottom"]) {
        const v = this.lines[kind][edge];
        ctx.beginPath();
        if (edge === "left" || edge === "right") { ctx.moveTo(v, 0); ctx.lineTo(v, H); }
        else { ctx.moveTo(0, v); ctx.lineTo(W, v); }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  drawLoupe() {
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
    ctx.drawImage(this.img, 0, 0);
    this.drawLines(ctx, canvas.width, canvas.height, 0.6);
    ctx.restore();
    ctx.strokeStyle = "#f2b53a";
    ctx.lineWidth = 3;
    ctx.strokeRect(dx, dy, size, size);
  }
}

const scanners = {};

/* ---------------------------------------------------------------- defect map */

function buildMap(fig, side) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 150 210");
  const el = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  svg.append(el("rect", { x: 1, y: 1, width: 148, height: 208, rx: 9, class: "card-body" }));
  const zones = {
    top_left: [0, 0, 30, 30], top_right: [120, 0, 30, 30],
    bottom_left: [0, 180, 30, 30], bottom_right: [120, 180, 30, 30],
    top: [32, 0, 86, 20], bottom: [32, 190, 86, 20], left: [0, 32, 20, 146], right: [130, 32, 20, 146],
    surface: [26, 26, 98, 158],
  };
  for (const [loc, [x, y, w, h]] of Object.entries(zones)) {
    const r = el("rect", { x, y, width: w, height: h, rx: 4, class: "zone", "data-loc": loc, "data-side": side, tabindex: 0, role: "button" });
    const title = el("title", {});
    title.textContent = `${side} ${pretty(loc)}`;
    r.append(title);
    r.addEventListener("click", () => pickZone(side, loc));
    r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickZone(side, loc); } });
    svg.append(r);
  }
  fig.append(svg);
}

function pickZone(side, location) {
  state.pick = { side, location, severity: state.pick.severity };
  const comp = COMPONENT_OF[location];
  const where = whereText({ side, location });
  $("#picked").textContent = where.charAt(0).toUpperCase() + where.slice(1);
  const select = $("#defect-type");
  select.innerHTML = "";
  for (const [key, spec] of Object.entries(CRITERIA.defects.types)) {
    if (!spec.applies_to.includes(comp)) continue;
    const o = document.createElement("option");
    o.value = key;
    o.textContent = spec.label;
    select.append(o);
  }
  select.disabled = false;
  updateAddButton();
  paintZones();
}

function updateAddButton() {
  $("#add-defect").disabled = !(state.pick.location && state.pick.severity);
  $$("#severity button").forEach((b) => b.classList.toggle("active", b.dataset.sev === state.pick.severity));
  const spec = CRITERIA.defects.types[$("#defect-type").value];
  const sev = state.pick.severity;
  if (sev) {
    const cap = spec ? spec.caps[sev] : null;
    const shown = cap == null ? "" : cap >= 10 ? " · still allows Gem Mint" : ` · caps this area at ${cap}`;
    $("#sev-hint").textContent = SEV_TEXT[sev] + shown;
  }
}

function paintZones() {
  $$(".zone").forEach((z) => {
    z.classList.remove("selected", "sev-micro", "sev-minor", "sev-moderate", "sev-major");
    const { side, loc } = z.dataset;
    const worst = state.defects
      .filter((d) => d.side === side && d.location === loc)
      .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])[0];
    if (worst) z.classList.add(`sev-${worst.severity}`);
    if (state.pick.side === side && state.pick.location === loc) z.classList.add("selected");
  });
}

function renderDefects() {
  const list = $("#defect-list");
  list.innerHTML = "";
  if (!state.defects.length) {
    list.innerHTML = '<li class="empty">No defects logged, so the card is treated as flawless.</li>';
  }
  state.defects.forEach((d, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="sev-pill ${d.severity}"></span>
      <span><span class="d-label"></span><br><span class="where"></span></span>
      <button type="button" aria-label="Remove defect">✕</button>`;
    $(".sev-pill", li).textContent = d.severity;
    $(".d-label", li).textContent = CRITERIA.defects.types[d.type].label;
    $(".where", li).textContent = whereText(d) + (d.note ? ` · ${d.note}` : "");
    $("button", li).addEventListener("click", () => {
      leaveExample();
      state.defects.splice(i, 1);
      renderDefects();
      scheduleGrade();
    });
    list.append(li);
  });
  paintZones();
}

/* ---------------------------------------------------------------- grading */

function assessment() {
  return {
    card: {
      name: $("#card-name").value.trim(),
      set_name: $("#card-set").value.trim(),
      number: $("#card-number").value.trim(),
      holo: $("#card-holo").checked,
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
    renderReport(state.report, a.card);
  } catch (err) {
    toast(`Grading failed: ${err.message}`);
  }
  if (!state.example) localStore.write(KEYS.draft, a);
}

const bigGrade = (g) => (g.tier >= 99 ? "—" : g.grade % 1 === 0 ? g.grade.toFixed(0) : g.grade.toFixed(1));
const isPristine = (g) => g.label.startsWith("Pristine");

function renderGradeBar(report) {
  const btn = $("#grade-bar-btn");
  btn.innerHTML = "";
  btn.setAttribute("aria-label", `${report.summary} Tap for details.`);
  for (const g of Object.values(report.grades)) {
    const item = document.createElement("span");
    item.className = "gb-item" + (g.company === report.best_fit ? " best" : "");
    item.dataset.co = g.company;
    item.innerHTML = `<span class="gb-co">${g.company}</span><span class="gb-grade">${bigGrade(g)}${isPristine(g) ? "<small>P</small>" : ""}</span>`;
    btn.append(item);
  }
}

function subLabel(company, v) {
  if (typeof v !== "number" || company === "TAG") return String(v);  // TAG areas are points
  return v >= 10.5 ? "10P" : String(v);
}

function renderReport(report, card = {}) {
  renderGradeBar(report);
  const box = $("#grades");
  box.innerHTML = "";
  $("#best-fit").textContent = report.summary.split(". ")[0] + ".";
  $("#disclaimer").textContent = report.disclaimer;
  const cardLine = [card.name || "Your card", card.number].filter(Boolean).join(" · ");
  for (const g of Object.values(report.grades)) {
    const slab = document.createElement("div");
    slab.className = "slab" + (g.company === report.best_fit ? " best" : "");
    slab.dataset.co = g.company;
    slab.innerHTML = `
      <div class="slab-label">
        <span class="slab-co">${g.company}</span>
        <div class="slab-grade"><div class="slab-num"></div><div class="slab-desc"></div></div>
        <span class="slab-card"></span>
      </div>
      <div class="slab-body">
        <div class="slab-sub"></div>
        <div class="chips"></div>
        <div class="slab-alt"></div>
        <details><summary>Why this grade</summary><ul></ul></details>
      </div>`;
    $(".slab-num", slab).innerHTML = `${bigGrade(g)}${isPristine(g) ? "<small>PRISTINE</small>" : ""}`;
    $(".slab-desc", slab).textContent = g.label.replace(/\s*\d+(\.\d)?$/, "").replace(/ 10 \(Black Label\)$/, " · Black Label");
    $(".slab-card", slab).textContent = cardLine;
    $(".slab-sub", slab).textContent =
      g.company === "TAG" && g.score != null ? `TAG Score ${g.score} / 1000`
      : g.company === "PSA" ? "One overall grade. The component values are estimates."
      : "Subgrades";
    const chips = $(".chips", slab);
    for (const q of g.qualifiers) {
      const c = document.createElement("span");
      c.className = "chip q";
      c.textContent = q;
      chips.append(c);
    }
    for (const [k, v] of Object.entries(g.subgrades)) {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = `${k} ${subLabel(g.company, v)}`;
      chips.append(c);
    }
    $(".slab-alt", slab).textContent = g.alternatives.join(" · ");
    const ul = $("ul", slab);
    const reasons = g.limiting_factors.length ? g.limiting_factors : ["Nothing is holding this card back at this company."];
    for (const r of [...reasons, ...g.notes]) {
      const li = document.createElement("li");
      li.textContent = r;
      ul.append(li);
    }
    box.append(slab);
  }
}

/* ---------------------------------------------------------------- example card */

function showExample() {
  state.example = true;
  $("#example-banner").hidden = false;
  $("#card-name").value = "Charizard ex (example)";
  $("#card-set").value = "Obsidian Flames";
  $("#card-number").value = "223/197";
  $("#card-holo").checked = true;
  for (const side of SIDES) scanners[side].loadScan(Vision.scan(samplePhoto(side)), { quiet: true });
  state.defects = [
    { side: "back", location: "top_right", type: "corner_whitening", severity: "minor", note: null },
    { side: "front", location: "surface", type: "holo_scratch", severity: "micro", note: "Only under a lamp" },
  ];
  renderDefects();
  runGrade();
}

function leaveExample() {
  if (!state.example) return;
  state.example = false;
  $("#example-banner").hidden = true;
  if ($("#card-name").value === "Charizard ex (example)") $("#card-name").value = "Charizard ex";
}

/* ---------------------------------------------------------------- history */

function renderHistory() {
  const list = $("#history-list");
  list.innerHTML = "";
  const cards = localStore.cards();
  if (!cards.length) {
    list.innerHTML = '<li class="empty">No saved cards yet. Grade a card and tap Save card.</li>';
    return;
  }
  for (const c of cards) {
    const li = document.createElement("li");
    li.innerHTML = `${c.front_thumb ? '<img alt="">' : '<div class="ph"></div>'}
      <div><div class="h-name"></div><div class="h-meta"></div><div class="h-grades"></div></div>
      <div class="h-actions"><button type="button" class="ghost del" aria-label="Delete saved card">✕</button></div>`;
    if (c.front_thumb) $("img", li).src = c.front_thumb;
    const card = c.assessment.card;
    $(".h-name", li).textContent = card.name || "(unnamed card)";
    $(".h-meta", li).textContent = [card.set_name, card.number, new Date(c.created_at).toLocaleDateString()].filter(Boolean).join(" · ");
    $(".h-grades", li).textContent = Object.values(c.report.grades).map((g) => `${g.company} ${bigGrade(g)}`).join(" · ");
    li.addEventListener("click", () => loadCard(c.id));
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

function loadCard(id) {
  const saved = localStore.cards().find((c) => c.id === id);
  if (!saved) return;
  resetForm();
  const a = saved.assessment;
  $("#card-name").value = a.card.name || "";
  $("#card-set").value = a.card.set_name || "";
  $("#card-number").value = a.card.number || "";
  $("#card-holo").checked = !!a.card.holo;
  for (const side of SIDES) scanners[side].setValues(a.centering[side].lr, a.centering[side].tb);
  state.defects = a.defects;
  state.thumbs = { front: saved.front_thumb, back: saved.back_thumb };
  renderDefects();
  runGrade();
  $("#history").hidden = true;
  toast("Loaded saved card");
}

function saveCard() {
  leaveExample();
  runGrade();
  const cards = localStore.cards();
  const a = assessment();
  cards.unshift({
    id: `${Date.now()}`,
    created_at: new Date().toISOString(),
    assessment: a,
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

/* ---------------------------------------------------------------- reset / init */

function resetForm() {
  leaveExample();
  for (const id of ["#card-name", "#card-set", "#card-number"]) $(id).value = "";
  $("#card-holo").checked = false;
  for (const side of SIDES) scanners[side].clear();
  state.defects = [];
  state.thumbs = { front: null, back: null };
  state.pick = { side: null, location: null, severity: null };
  $("#picked").textContent = "Select a spot on the card map";
  $("#defect-type").innerHTML = "";
  $("#defect-type").disabled = true;
  $("#defect-note").value = "";
  updateAddButton();
  renderDefects();
}

function restoreDraft(draft) {
  $("#card-name").value = draft.card.name || "";
  $("#card-set").value = draft.card.set_name || "";
  $("#card-number").value = draft.card.number || "";
  $("#card-holo").checked = !!draft.card.holo;
  for (const side of SIDES) scanners[side].setValues(draft.centering[side].lr, draft.centering[side].tb);
  state.defects = draft.defects || [];
  renderDefects();
  runGrade();
}

function init() {
  for (const root of $$(".side")) scanners[root.dataset.side] = new SideScanner(root, root.dataset.side);
  for (const fig of $$(".map")) buildMap(fig, fig.dataset.side);

  $$("#severity button").forEach((b) => b.addEventListener("click", () => {
    state.pick.severity = b.dataset.sev;
    updateAddButton();
  }));
  $("#defect-type").addEventListener("change", updateAddButton);
  $("#add-defect").addEventListener("click", () => {
    leaveExample();
    const { side, location, severity } = state.pick;
    const note = $("#defect-note").value.trim();
    state.defects.push({ side, location, type: $("#defect-type").value, severity, note: note || null });
    $("#defect-note").value = "";
    renderDefects();
    scheduleGrade();
  });
  for (const id of ["#card-name", "#card-set", "#card-number", "#card-holo"]) {
    $(id).addEventListener("input", () => { leaveExample(); scheduleGrade(); });
  }
  $("#save-card").addEventListener("click", saveCard);
  $("#new-card").addEventListener("click", () => { resetForm(); runGrade(); window.scrollTo({ top: 0 }); });
  $("#start-own").addEventListener("click", () => { resetForm(); runGrade(); });
  $("#open-history").addEventListener("click", openHistory);
  $("#close-history").addEventListener("click", () => ($("#history").hidden = true));
  $("#history").addEventListener("click", (e) => { if (e.target.id === "history") $("#history").hidden = true; });
  $("#grade-bar-btn").addEventListener("click", () => $("#results").scrollIntoView({ behavior: "smooth", block: "start" }));

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

  renderDefects();
  const draft = localStore.read(KEYS.draft, null);
  if (draft && draft.centering && draft.card) restoreDraft(draft);
  else showExample();
}

init();
