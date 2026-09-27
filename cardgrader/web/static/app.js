"use strict";

const SIDES = ["front", "back"];
const COMPONENT_OF = {
  top_left: "corners", top_right: "corners", bottom_left: "corners", bottom_right: "corners",
  top: "edges", right: "edges", bottom: "edges", left: "edges", surface: "surface",
};
const SEV_RANK = { micro: 1, minor: 2, moderate: 3, major: 4 };

const state = {
  criteria: null,
  centering: { front: { lr: 50, tb: 50 }, back: { lr: 50, tb: 50 } },
  defects: [],
  thumbs: { front: null, back: null },
  pick: { side: null, location: null, severity: null },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pretty = (s) => s.replace(/_/g, " ");
const fmtShare = (v) => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* not JSON */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json();
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
    this.lrOther = $(".lr-other", root);
    this.tbOther = $(".tb-other", root);
    this.confEl = $(".conf", root);
    this.cropped = $(".cropped", root);
    this.img = null;
    this.lines = null;
    this.drag = null;
    this.pointer = null;

    $("input[type=file]", root).addEventListener("change", (e) => {
      if (e.target.files[0]) this.upload(e.target.files[0]);
      e.target.value = "";
    });
    this.zone.addEventListener("dragover", (e) => { e.preventDefault(); this.zone.classList.add("drag"); });
    this.zone.addEventListener("dragleave", () => this.zone.classList.remove("drag"));
    this.zone.addEventListener("drop", (e) => {
      e.preventDefault();
      this.zone.classList.remove("drag");
      if (e.dataTransfer.files[0]) this.upload(e.dataTransfer.files[0]);
    });
    for (const input of [this.lrInput, this.tbInput]) {
      input.addEventListener("input", () => this.manualChange());
    }
    this.canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.onUp(e));
    this.canvas.addEventListener("pointerleave", () => { if (!this.drag) { this.pointer = null; this.draw(); } });
  }

  async upload(file) {
    const form = new FormData();
    form.append("file", file);
    form.append("mode", this.cropped.checked ? "cropped" : "auto");
    this.zone.classList.add("busy");
    try {
      const scan = await api("/api/scan", { method: "POST", body: form });
      await this.loadScan(scan);
    } catch (err) {
      toast(`Scan failed: ${err.message}`);
    } finally {
      this.zone.classList.remove("busy");
    }
  }

  loadScan(scan) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.img = img;
        this.canvas.width = scan.width;
        this.canvas.height = scan.height;
        this.lines = scan.lines;
        state.thumbs[this.side] = scan.thumb;
        this.zone.classList.add("has-image");
        const conf = scan.confidence.borders;
        this.confEl.textContent = `auto-detect confidence ${Math.round(conf * 100)}%`;
        this.confEl.classList.toggle("low", conf < 0.6);
        if (conf < 0.6) toast(`${this.side}: low confidence, so check the guides`);
        this.fromLines();
        resolve();
      };
      img.src = scan.image;
    });
  }

  clear() {
    this.img = null;
    this.lines = null;
    this.zone.classList.remove("has-image");
    this.confEl.textContent = "";
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

  toNative(e) {
    const r = this.canvas.getBoundingClientRect();
    const k = this.canvas.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
  }

  hit(p) {
    const tol = 10 * p.k;
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
    this.drag = h;
    this.pointer = p;
    this.canvas.setPointerCapture(e.pointerId);
    this.draw();
  }

  onMove(e) {
    if (!this.lines) return;
    const p = this.toNative(e);
    this.pointer = p;
    if (this.drag) {
      const { kind, edge } = this.drag;
      const max = edge === "left" || edge === "right" ? this.canvas.width : this.canvas.height;
      this.lines[kind][edge] = Math.max(0, Math.min(max, edge === "left" || edge === "right" ? p.x : p.y));
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
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.img, 0, 0);
    this.drawLines(ctx, W, H, 2);
    if (this.drag && this.pointer) this.drawLoupe();
  }

  drawLines(ctx, W, H, width) {
    const style = { outer: getComputedStyle(document.body).getPropertyValue("--outer") || "#38bdf8",
                    inner: getComputedStyle(document.body).getPropertyValue("--inner") || "#f472b6" };
    for (const kind of ["outer", "inner"]) {
      ctx.strokeStyle = style[kind].trim();
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
    const dy = 12;
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
    ctx.strokeStyle = "#f5c542";
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
    const r = el("rect", { x, y, width: w, height: h, rx: 4, class: "zone", "data-loc": loc, "data-side": side });
    const title = el("title", {});
    title.textContent = `${side} ${pretty(loc)}`;
    r.append(title);
    r.addEventListener("click", () => pickZone(side, loc));
    svg.append(r);
  }
  fig.append(svg);
}

function pickZone(side, location) {
  state.pick = { side, location, severity: state.pick.severity };
  const comp = COMPONENT_OF[location];
  const where = location === "surface" ? `${side} surface` : `${side} ${pretty(location)} ${comp === "corners" ? "corner" : "edge"}`;
  $("#picked").textContent = where.charAt(0).toUpperCase() + where.slice(1);
  const select = $("#defect-type");
  select.innerHTML = "";
  for (const [key, spec] of Object.entries(state.criteria.defects)) {
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
  const caps = state.criteria && state.criteria.defects[$("#defect-type").value];
  $$("#severity button").forEach((b) => {
    b.title = b.title.split(" · ")[0] + (caps ? ` · caps component at ${caps.caps[b.dataset.sev]}` : "");
  });
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
    const comp = COMPONENT_OF[d.location];
    const where = d.location === "surface" ? `${d.side} surface` : `${d.side} ${pretty(d.location)} ${comp === "corners" ? "corner" : "edge"}`;
    li.innerHTML = `<span class="sev-pill ${d.severity}">${d.severity}</span>
      <span>${state.criteria.defects[d.type].label}<br><span class="where"></span></span>
      <button title="Remove">✕</button>`;
    $(".where", li).textContent = where + (d.note ? ` · ${d.note}` : "");
    $("button", li).addEventListener("click", () => {
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
    },
    centering: state.centering,
    defects: state.defects,
  };
}

let gradeTimer = null;
let gradeSeq = 0;
function scheduleGrade() {
  clearTimeout(gradeTimer);
  gradeTimer = setTimeout(runGrade, 120);
}

async function runGrade() {
  const seq = ++gradeSeq;
  try {
    const report = await api("/api/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(assessment()),
    });
    if (seq === gradeSeq) renderReport(report);
  } catch (err) {
    toast(`Grading failed: ${err.message}`);
  }
}

function subLabel(company, v) {
  if (typeof v !== "number" || company === "TAG") return String(v);  // TAG areas are points
  return v >= 10.5 ? "10P" : String(v);
}

function renderReport(report) {
  const box = $("#grades");
  box.innerHTML = "";
  $("#best-fit").textContent = report.summary.split(". ")[0] + ".";
  $("#disclaimer").textContent = report.disclaimer;
  for (const g of Object.values(report.grades)) {
    const card = document.createElement("div");
    card.className = "grade-card" + (g.company === report.best_fit ? " best" : "");
    card.dataset.co = g.company;
    const big = g.tier >= 99 ? "—" : (g.grade % 1 === 0 ? g.grade.toFixed(0) : g.grade.toFixed(1));
    card.innerHTML = `
      <div class="gc-top">
        <div class="gc-company">${g.company}</div>
        <div class="gc-grade">${big}</div>
        <div><div class="gc-label"></div><div class="gc-sub"></div></div>
      </div>
      <div class="chips"></div>
      <div class="gc-alt"></div>
      <details class="gc-details"><summary>Why this grade</summary><ul></ul></details>`;
    $(".gc-label", card).textContent = g.label;
    $(".gc-sub", card).textContent =
      g.company === "TAG" && g.score != null ? `TAG Score ${g.score} / 1000`
      : g.company === "PSA" ? "Single overall grade (component estimates below)"
      : "Subgrades";
    const chips = $(".chips", card);
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
      if (subLabel(g.company, v) === "10P") c.title = "10 Pristine";
      chips.append(c);
    }
    $(".gc-alt", card).textContent = g.alternatives.join(" · ");
    const ul = $("ul", card);
    const reasons = g.limiting_factors.length ? g.limiting_factors : ["Nothing is holding this card back at this company."];
    for (const r of [...reasons, ...g.notes]) {
      const li = document.createElement("li");
      li.textContent = r;
      ul.append(li);
    }
    box.append(card);
  }
}

/* ---------------------------------------------------------------- history */

async function openHistory() {
  const list = $("#history-list");
  list.innerHTML = "";
  $("#history").hidden = false;
  const cards = await api("/api/cards");
  if (!cards.length) {
    list.innerHTML = '<li class="empty">No saved cards yet.</li>';
    return;
  }
  for (const c of cards) {
    const li = document.createElement("li");
    li.innerHTML = `${c.front_thumb ? '<img alt="">' : '<div class="ph"></div>'}
      <div><div class="h-name"></div><div class="h-meta"></div><div class="h-grades"></div></div>
      <button class="ghost" title="Delete">✕</button>`;
    if (c.front_thumb) $("img", li).src = c.front_thumb;
    $(".h-name", li).textContent = c.name || "(unnamed card)";
    $(".h-meta", li).textContent = [c.set_name, c.number, new Date(c.created_at).toLocaleDateString()].filter(Boolean).join(" · ");
    $(".h-grades", li).textContent = Object.entries(c.grades).map(([k, v]) => `${k} ${v}`).join(" · ");
    li.addEventListener("click", () => loadCard(c.id));
    $("button", li).addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this saved card?")) return;
      await api(`/api/cards/${c.id}`, { method: "DELETE" });
      openHistory();
    });
    list.append(li);
  }
}

async function loadCard(id) {
  const saved = await api(`/api/cards/${id}`);
  const a = saved.assessment;
  resetForm();
  $("#card-name").value = a.card.name;
  $("#card-set").value = a.card.set_name;
  $("#card-number").value = a.card.number;
  $("#card-holo").checked = a.card.holo;
  for (const side of SIDES) scanners[side].setValues(a.centering[side].lr, a.centering[side].tb);
  state.defects = a.defects;
  state.thumbs = { front: saved.front_thumb, back: saved.back_thumb };
  renderDefects();
  renderReport(saved.report);
  $("#history").hidden = true;
  toast("Loaded saved card");
}

function resetForm() {
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

/* ---------------------------------------------------------------- init */

async function init() {
  state.criteria = await api("/api/criteria");
  for (const root of $$(".side")) scanners[root.dataset.side] = new SideScanner(root, root.dataset.side);
  for (const fig of $$(".map")) buildMap(fig, fig.dataset.side);

  $$("#severity button").forEach((b) => b.addEventListener("click", () => {
    state.pick.severity = b.dataset.sev;
    updateAddButton();
  }));
  $("#defect-type").addEventListener("change", updateAddButton);
  $("#add-defect").addEventListener("click", () => {
    const { side, location, severity } = state.pick;
    const note = $("#defect-note").value.trim();
    state.defects.push({ side, location, type: $("#defect-type").value, severity, note: note || null });
    $("#defect-note").value = "";
    renderDefects();
    scheduleGrade();
  });
  for (const id of ["#card-name", "#card-set", "#card-number", "#card-holo"]) {
    $(id).addEventListener("change", scheduleGrade);
  }
  $("#save-card").addEventListener("click", async () => {
    try {
      const res = await api("/api/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assessment: assessment(), front_thumb: state.thumbs.front, back_thumb: state.thumbs.back }),
      });
      renderReport(res.report);
      toast(`Saved card #${res.id}`);
    } catch (err) {
      toast(`Save failed: ${err.message}`);
    }
  });
  $("#open-history").addEventListener("click", openHistory);
  $("#close-history").addEventListener("click", () => ($("#history").hidden = true));
  $("#history").addEventListener("click", (e) => { if (e.target.id === "history") $("#history").hidden = true; });
  $("#new-card").addEventListener("click", () => { resetForm(); scheduleGrade(); });

  renderDefects();
  runGrade();
}

init().catch((err) => toast(`Failed to start: ${err.message}`));
