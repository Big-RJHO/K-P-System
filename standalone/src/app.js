/* Card Grading Lab: standalone app. Two screens: scan, then report. Everything runs in the browser. */
"use strict";

const CRITERIA = window.GRADING_CRITERIA;
const ENV = window.GRADING_LAB_ENV || "file";  // "artifact" | "site" | "file"
const SIDES = ["front", "back"];
const COMPONENTS = ["corners", "edges", "surface"];
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

// Per-game photo tips, placeholders, hints and example card. Grading rules are the same:
// PSA, BGS, CGC and TAG grade all 63 x 88 mm TCG cards against the same standards.
const GAMES = {
  pokemon: {
    label: "Pokémon",
    tips: ["Dark, plain background", "Phone parallel to the card", "No glare on holo"],
    placeholders: { name: "Name this card", set: "Set", number: "No." },
    hint: "Tap where you see wear. Check under a bright light, tilting the card. Whitening shows most on the blue back border.",
    rarities: ["Common", "Uncommon", "Rare", "Holo Rare", "Double Rare", "Ultra Rare", "Illustration Rare", "Special Illustration Rare", "Hyper Rare", "Promo"],
    example: {
      name: "Charizard ex", set: "Obsidian Flames", number: "223/197",
      details: { subtitle: "", card_type: "Pokémon ex", set_code: "OBF", rarity: "Special Illustration Rare", finish: "Holo", language: "EN", year: "2023" },
      defects: [
        { side: "back", location: "top_right", type: "corner_whitening", severity: "minor", note: null },
        { side: "front", location: "surface", type: "holo_scratch", severity: "micro", note: "Only under a lamp" },
      ],
    },
  },
  riftbound: {
    label: "Riftbound",
    tips: ["Light, plain background for black borders and black backs", "Dark background for white Rune backs", "Phone parallel, no glare on foils"],
    placeholders: { name: "Name this card", set: "Set, e.g. Origins", number: "No." },
    hint: "Tap where you see wear. Many Origins cards left the factory with burred edges: log those as Rough factory cut / burred edge, not chipping. Whitening shows most on black borders and black backs.",
    rarities: ["Common", "Uncommon", "Rare", "Epic", "Showcase / Alt Art", "Overnumbered", "Signature", "Metal", "Ultimate", "Promo"],
    example: {
      name: "Example Riftbound card", set: "Origins", number: "001/298",
      details: { subtitle: "", card_type: "Champion Unit", set_code: "OGN", rarity: "Showcase / Alt Art", finish: "Foil", language: "EN", year: "2025" },
      defects: [
        { side: "front", location: "top", type: "rough_cut", severity: "minor", note: "Factory burr" },
        { side: "back", location: "bottom_left", type: "corner_whitening", severity: "micro", note: null },
      ],
    },
  },
};
const gameInfo = (g) => GAMES[g] || GAMES.pokemon;

const FINISHES = ["", "Non-foil", "Holo", "Reverse holo", "Foil", "Etched / textured", "Metal"];
const LANGUAGES = { EN: "English", JP: "Japanese", ZH: "Chinese", KO: "Korean", FR: "French", DE: "German", IT: "Italian", ES: "Spanish", PT: "Portuguese" };
// Input id -> key on assessment.card
const DETAIL_FIELDS = {
  "card-subtitle": "subtitle", "card-type": "card_type", "card-set": "set_name", "card-set-code": "set_code",
  "card-number": "number", "card-rarity": "rarity", "card-finish": "finish", "card-language": "language", "card-year": "year",
};

/** Read the collector line printed on the card, e.g. "VEN · SP3/006 · EN" or "OGN-001/298 EN". */
function parseCollectorLine(text) {
  const out = {};
  const tokens = text.toUpperCase().replace(/[•·|,]/g, " ").split(/\s+/).filter(Boolean);
  const slashed = tokens.find((t) => t.includes("/"));  // "223/197" beats "SV3" for the number
  if (slashed) {
    const dash = slashed.match(/^([A-Z]{2,5})-(\S+)$/);
    out.number = dash ? dash[2] : slashed;
    if (dash) out.set_code = dash[1];
  }
  for (let tok of tokens) {
    if (tok === slashed) continue;
    const lang = { JA: "JP", CN: "ZH", KR: "KO" }[tok] || tok;
    if (!out.language && LANGUAGES[lang] && tok.length === 2) { out.language = lang; continue; }
    const dash = tok.match(/^([A-Z]{2,5})-(\S+)$/);
    if (dash) { out.set_code = out.set_code || dash[1]; tok = dash[2]; }
    if (!out.number && (/\//.test(tok) || /^[A-Z]{0,3}\d{1,4}[A-Z]?$/.test(tok))) { out.number = tok; continue; }
    if (!out.set_code && /^[A-Z][A-Z0-9]{1,4}$/.test(tok)) out.set_code = tok;
  }
  return out;
}

const state = {
  game: "pokemon",
  view: "scan",
  scans: { front: null, back: null },  // {img: canvas, lines, width, height, confidence}
  thumbs: { front: null, back: null },
  centering: { front: { lr: 50, tb: 50 }, back: { lr: 50, tb: 50 } },
  defects: [],
  // Assessment evidence (see grading.js): which components were looked at, and where each centering
  // share came from. Nothing counts as flawless or centered until there's evidence for it.
  inspected: { front: [], back: [] },
  evidence: { front: { lr: "unread", tb: "unread" }, back: { lr: "unread", tb: "unread" } },
  activeSide: "front",
  reference: null,  // {image_url|image, source, source_url, name, rgba, mask}: only set once the user confirms the card
  showSuspects: true,
  sheet: { side: null, location: null, type: null, severity: null },
  example: false,
  report: null,
  savedId: null,
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

// Drafts v3 add the inspection record (inspected, centering_evidence). A v2 draft still resumes, but under
// the current rules its uninspected areas leave the grade incomplete.
const KEYS = { cards: "cardGradingLab.cards.v1", draft: "cardGradingLab.draft.v3", draftV2: "cardGradingLab.draft.v2", game: "cardGradingLab.game" };

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
  draft() { return this.read(KEYS.draft, null) || this.read(KEYS.draftV2, null); },
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

/** A sample "photo" of a slightly off-center card, used for the example. */
function samplePhoto(side, game = "pokemon") {
  if (game === "riftbound") return riftboundSample(side);
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

/** Riftbound-style sample: black-bordered front and blue back, photographed on a light mat. */
function riftboundSample(side) {
  const W = 1200, H = 1500;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#d7dadf";
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.rotate(((side === "front" ? -2.2 : 1.6) * Math.PI) / 180);
  const cw = 750, ch = 1048;
  ctx.translate(-cw / 2, -ch / 2);
  const border = side === "front" ? { l: 38, r: 30, t: 36, b: 37 } : { l: 39, r: 37, t: 40, b: 42 };
  ctx.fillStyle = side === "front" ? "#141417" : "#1b3f86";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, cw, ch, 26);
  else ctx.rect(0, 0, cw, ch);
  ctx.fill();
  const iw = cw - border.l - border.r, ih = ch - border.t - border.b;
  const grad = ctx.createLinearGradient(0, 0, 0, ih);
  if (side === "front") {
    grad.addColorStop(0, "#5b3fb8");
    grad.addColorStop(0.55, "#2b8fb0");
    grad.addColorStop(1, "#e2c46a");
  } else {
    grad.addColorStop(0, "#3a6fd8");
    grad.addColorStop(1, "#122a66");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(border.l, border.t, iw, ih);
  if (side === "front") {
    ctx.fillStyle = "rgba(245,240,228,.9)";
    ctx.fillRect(border.l + 24, border.t + ih * 0.62, iw - 48, ih * 0.3);
  } else {
    ctx.strokeStyle = "#e8c35a";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(cw / 2, ch / 2, 190, 0, Math.PI * 2);
    ctx.stroke();
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

/**
 * Where a border couldn't be read (full-art card, glare), don't trust the guessed frame line: put that
 * guide at the same inset as the opposite side (or both at 5% if neither side reads), so the axis starts
 * neutral (50/50) and is flagged for the user to line up by hand.
 */
function neutralizeUnreadSides(scan) {
  const per = scan.confidence.per_side;
  const { outer, inner } = scan.lines;
  const ok = (sd) => per[sd] >= 0.3;
  const unmeasured = { lr: false, tb: false };
  const axes = [["left", "right", "lr", scan.width - 2 * scan.margin], ["top", "bottom", "tb", scan.height - 2 * scan.margin]];
  for (const [a, b, axis, extent] of axes) {
    const inset = (sd) => (sd === "left" || sd === "top" ? inner[sd] - outer[sd] : outer[sd] - inner[sd]);
    const setInset = (sd, v) => { inner[sd] = sd === "left" || sd === "top" ? outer[sd] + v : outer[sd] - v; };
    if (ok(a) && ok(b)) continue;
    unmeasured[axis] = true;
    const v = ok(a) ? inset(a) : ok(b) ? inset(b) : extent * 0.05;
    setInset(a, v);
    setInset(b, v);
  }
  return unmeasured;
}

function applyScan(side, scan, photo = null) {
  const img = canvasFromRGBA(scan.warped);
  const unmeasured = neutralizeUnreadSides(scan);
  state.scans[side] = {
    img, lines: scan.lines, width: scan.width, height: scan.height, margin: scan.margin,
    confidence: scan.confidence.borders,
    photo, corners: scan.corners,  // kept for this session so the outline can be adjusted by hand
    result: scan, quality: null, check: null,  // full scan, photo-quality gate, edge/corner candidates
  };
  state.evidence[side] = { lr: unmeasured.lr ? "unread" : "measured", tb: unmeasured.tb ? "unread" : "measured" };
  state.thumbs[side] = thumbnail(img, scan.margin);
  state.centering[side] = centeringFromLines(scan.lines);
  runInspection(side);
}

async function scanFile(side, file) {
  leaveExample();
  const slot = $(`.slot[data-side="${side}"]`);
  slot.classList.add("busy");
  $("#guide-wrap").classList.toggle("busy", state.view === "report");
  try {
    const pixels = await readImage(file);
    await new Promise((r) => setTimeout(r, 30));  // let the busy overlay paint
    applyScan(side, Vision.scan(pixels, "auto"), pixels);
    const ev = state.evidence[side];
    const um = { lr: ev.lr === "unread", tb: ev.tb === "unread" };
    const q = state.scans[side].quality;
    const failed = q && q.verdict === "rescan" ? Object.values(q.checks).find((c) => c.status === "fail") : null;
    if (failed) toast(`${cap(side)}: this photo can't support a reliable check. ${failed.note}`);
    else if (um.lr || um.tb) toast(`${cap(side)}: couldn't read the ${um.lr && um.tb ? "border" : um.lr ? "left/right border" : "top/bottom border"} (full-art card or glare). In the report, line up the pink guides with the printed frame.`);
    else if (state.scans[side].confidence < 0.6) toast(`${cap(side)}: the border was hard to read. Check the guide lines in the report.`);
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
  outline: null,  // [[x, y] x4] corner handles (TL, TR, BR, BL) while adjusting the outline

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
    if (this.outline) {
      let bestC = null;
      this.outline.forEach(([x, y], i) => {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= tol * 1.6 && (!bestC || d < bestC.d)) bestC = { corner: i, d };
      });
      return bestC;
    }
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
    if (this.drag && this.drag.corner != null) {
      this.outline[this.drag.corner] = [Math.max(0, Math.min(this.canvas.width, p.x)), Math.max(0, Math.min(this.canvas.height, p.y))];
    } else if (this.drag) {
      const { kind, edge } = this.drag;
      const vertical = edge === "left" || edge === "right";
      const max = vertical ? this.canvas.width : this.canvas.height;
      s.lines[kind][edge] = Math.max(0, Math.min(max, vertical ? p.x : p.y));
      state.evidence[state.activeSide][vertical ? "lr" : "tb"] = "measured";  // lined up by hand
      state.centering[state.activeSide] = centeringFromLines(s.lines);
      renderRatioInputs();
      scheduleGrade();
    } else {
      const h = this.hit(p);
      this.canvas.style.cursor = !h ? "default" : h.corner != null ? "move" : h.edge === "left" || h.edge === "right" ? "ew-resize" : "ns-resize";
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
    if (this.outline) this.drawOutline(ctx, 3);
    else this.drawLines(ctx, s.lines, canvas.width, canvas.height, 2.5);
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

  drawOutline(ctx, width) {
    const q = this.outline;
    ctx.strokeStyle = "#f2b53a";
    ctx.lineWidth = width;
    ctx.beginPath();
    q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    for (const [x, y] of q) {
      ctx.beginPath();
      ctx.arc(x, y, width * 6, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(242, 181, 58, 0.35)";
      ctx.fill();
      ctx.stroke();
    }
  },

  startOutline() {
    const s = this.scan();
    if (!s || !s.photo) return;
    const o = s.lines.outer;
    this.outline = [[o.left, o.top], [o.right, o.top], [o.right, o.bottom], [o.left, o.bottom]];
    this.draw();
  },

  stopOutline() {
    this.outline = null;
    this.draw();
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
    if (this.outline) this.drawOutline(ctx, 0.8);
    else this.drawLines(ctx, s.lines, canvas.width, canvas.height, 0.6);
    ctx.restore();
    ctx.strokeStyle = "#f2b53a";
    ctx.lineWidth = 3;
    ctx.strokeRect(dx, dy, size, size);
  },
};

function setOutlineMode(on) {
  $("#outline-bar").hidden = !on;
  $("#guide-actions").hidden = on;
  if (on) guide.startOutline();
  else guide.stopOutline();
}

async function applyOutline() {
  const side = state.activeSide;
  const s = state.scans[side];
  if (!s || !s.photo || !guide.outline) return setOutlineMode(false);
  const H = Vision.warpMatrix(s.corners, s.margin);
  const corners = guide.outline.map(([x, y]) => Vision.applyH(H, x, y));
  $("#guide-wrap").classList.add("busy");
  await new Promise((r) => setTimeout(r, 30));
  try {
    leaveExample();
    applyScan(side, Vision.scan(s.photo, "auto", corners), s.photo);
    renderSlots();
    toast("Outline applied. The card was re-flattened and re-graded.");
  } finally {
    $("#guide-wrap").classList.remove("busy");
    setOutlineMode(false);
    renderCentering();
    runGrade();
  }
}

function renderRatioInputs() {
  const c = state.centering[state.activeSide];
  const lr = $("#ratio-lr"), tb = $("#ratio-tb");
  if (document.activeElement !== lr) lr.value = fmtShare(c.lr);
  if (document.activeElement !== tb) tb.value = fmtShare(c.tb);
  $("#lr-other").textContent = fmtShare(100 - c.lr);
  $("#tb-other").textContent = fmtShare(100 - c.tb);
  const s = state.scans[state.activeSide];
  const ev = state.evidence[state.activeSide];
  const conf = $("#conf");
  const um = [ev.lr === "unread" && "left/right", ev.tb === "unread" && "top/bottom"].filter(Boolean).join(" and ");
  const share = `${Grading.UNREAD_SHARE}/${100 - Grading.UNREAD_SHARE}`;
  conf.textContent = !s
    ? (um ? `Not measured, so it counts as ${share}. Add a photo or type the ratios.` : ev.lr === "typed" || ev.tb === "typed" ? "Typed in" : "Measured from the photo")
    : um ? `Couldn't read the ${um} border: drag the pink guides onto the printed frame`
    : `Border detection ${Math.round(s.confidence * 100)}%`;
  conf.classList.toggle("low", !!um || (!!s && s.confidence < 0.6));
}

function renderCentering() {
  const s = state.scans[state.activeSide];
  $("#adjust-outline").hidden = !(s && s.photo);
  $$("#centering-section .segmented button, #scancheck-section .segmented button, .viewer-side button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.side === state.activeSide)));
  viewer.render();
  guide.show();
  renderRatioInputs();
  renderScanCheck();
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
  markInspected(side, COMPONENT_OF[location]);  // logging a DING there means you looked there
  closeSheet();
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
    list.innerHTML = '<li class="empty">No DINGS logged. Areas ticked as checked above count as flawless; unchecked areas leave the grade incomplete. Tap the card above where you see wear.</li>';
  }
  const areas = state.report && state.report.grades.TAG.subgrades;
  state.defects.forEach((d, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="ding-no ${d.severity}" aria-hidden="true">${i + 1}</span>
      <span class="d-text"><span class="d-label"></span><br><span class="where"></span></span>
      <span class="d-impact"></span>
      <button type="button" class="remove" aria-label="Remove DING ${i + 1}">✕</button>`;
    $(".d-label", li).textContent = CRITERIA.defects.types[d.type].label;
    $(".where", li).textContent = `${cap(d.severity)} · ${whereText(d)}${d.note ? ` · ${d.note}` : ""}`;
    const area = `${d.side} ${COMPONENT_OF[d.location]}`;
    if (areas && areas[area] != null) $(".d-impact", li).textContent = `${cap(area)} ${areas[area]}`;
    $(".remove", li).addEventListener("click", () => {
      leaveExample();
      state.defects.splice(i, 1);
      runGrade();
    });
    list.append(li);
  });
  const n = state.defects.length;
  const checked = SIDES.reduce((k, side) => k + COMPONENTS.filter((c) => isInspected(side, c)).length, 0);
  $("#defect-summary").textContent = `${n ? `${n} logged` : "None logged"} · ${checked}/6 checked`;
  paintZones();
  renderInspect();
}

/* ---------------------------------------------------------------- inspection checklist */

// Same rule as the engine: a component with a DING logged on that side has been looked at.
const hasDefect = (side, comp) => state.defects.some((d) => d.side === side && COMPONENT_OF[d.location] === comp);
const isInspected = (side, comp) => state.inspected[side].includes(comp) || hasDefect(side, comp);

function markInspected(side, comp) {
  if (!state.inspected[side].includes(comp)) state.inspected[side] = COMPONENTS.filter((c) => c === comp || state.inspected[side].includes(c));
}

function setInspected(side, comp, on) {
  leaveExample();
  if (on) markInspected(side, comp);
  else state.inspected[side] = state.inspected[side].filter((c) => c !== comp);
  runGrade();
}

function renderInspect() {
  let all = true;
  for (const box of $$("#inspect input[type=checkbox]")) {
    const { side, comp } = box.dataset;
    const locked = hasDefect(side, comp);  // can't be unchecked while a DING is logged there
    box.checked = isInspected(side, comp);
    box.disabled = locked;
    box.closest(".check").classList.toggle("locked", locked);
    all = all && box.checked;
  }
  $("#inspect").classList.toggle("incomplete", !all);
}

/* ---------------------------------------------------------------- card viewer */

// Where each DING marker sits on the card, as fractions of width/height.
const MARKER_POS = {
  top_left: [0.08, 0.06], top_right: [0.92, 0.06], bottom_left: [0.08, 0.94], bottom_right: [0.92, 0.94],
  top: [0.5, 0.035], bottom: [0.5, 0.965], left: [0.045, 0.5], right: [0.955, 0.5], surface: [0.5, 0.5],
};

function zoneAt(px, py) {
  const cx = px < 0.16 ? "left" : px > 0.84 ? "right" : null;
  const cy = py < 0.12 ? "top" : py > 0.88 ? "bottom" : null;
  if (cx && cy) return `${cy}_${cx}`;
  if (px < 0.07) return "left";
  if (px > 0.93) return "right";
  if (py < 0.05) return "top";
  if (py > 0.95) return "bottom";
  return "surface";
}

const viewer = {
  W: 750, H: 1048, thumbImgs: { front: null, back: null },

  init() {
    this.canvas = $("#viewer-canvas");
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext("2d");
    this.canvas.addEventListener("click", (e) => {
      const r = this.canvas.getBoundingClientRect();
      openSheet(state.activeSide, zoneAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height));
    });
    $("#overlay").addEventListener("input", () => this.render());
  },

  thumbImage(side) {
    const src = state.thumbs[side];
    if (!src) return null;
    const cached = this.thumbImgs[side];
    if (cached && cached.src === src) return cached.complete ? cached : null;
    const img = new Image();
    img.onload = () => this.render();
    img.src = src;
    this.thumbImgs[side] = img;
    return null;
  },

  render() {
    const { ctx, W, H } = this;
    const side = state.activeSide;
    const css = getComputedStyle(document.documentElement);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    ctx.clearRect(0, 0, W, H);
    const scan = state.scans[side];
    let map = null;  // scan pixel -> viewer pixel, for the centering lines
    if (scan) {
      const m = scan.margin, sw = scan.width - 2 * m, sh = scan.height - 2 * m;
      ctx.drawImage(scan.img, m, m, sw, sh, 0, 0, W, H);
      map = { m, kx: W / sw, ky: H / sh };
    } else {
      const img = this.thumbImage(side);
      if (img) ctx.drawImage(img, 0, 0, W, H);
      else {
        ctx.fillStyle = color("--surface-3", "#e4e7ec");
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = color("--muted", "#5d6572");
        ctx.font = "600 36px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`No ${side} photo`, W / 2, H / 2);
      }
    }
    const alpha = Number($("#overlay").value) / 100;
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(8, 10, 14, 0.22)";
    ctx.fillRect(0, 0, W, H);
    if (map) {
      const L = scan.lines;
      const X = (v) => (v - map.m) * map.kx, Y = (v) => (v - map.m) * map.ky;
      for (const kind of ["outer", "inner"]) {
        ctx.strokeStyle = kind === "outer" ? color("--outer", "#38bdf8") : color("--inner", "#f472b6");
        ctx.lineWidth = 3;
        ctx.setLineDash(kind === "outer" ? [12, 8] : []);
        ctx.beginPath();
        ctx.moveTo(X(L[kind].left), 0); ctx.lineTo(X(L[kind].left), H);
        ctx.moveTo(X(L[kind].right), 0); ctx.lineTo(X(L[kind].right), H);
        ctx.moveTo(0, Y(L[kind].top)); ctx.lineTo(W, Y(L[kind].top));
        ctx.moveTo(0, Y(L[kind].bottom)); ctx.lineTo(W, Y(L[kind].bottom));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    drawSuspects(ctx, scan, map ? (v) => (v - map.m) * map.kx : null, map ? (v) => (v - map.m) * map.ky : null, color);
    const sevColor = { micro: color("--good", "#178a5d"), minor: color("--warn", "#b26b00"), moderate: color("--bad", "#c2362f"), major: color("--bad", "#c2362f") };
    const seen = {};
    state.defects.forEach((d, i) => {
      if (d.side !== side) return;
      const k = (seen[d.location] = (seen[d.location] || 0) + 1) - 1;
      let [fx, fy] = MARKER_POS[d.location];
      if (d.location === "surface" && k) {
        fx += 0.2 * Math.cos(k * 2.2);
        fy += 0.18 * Math.sin(k * 2.2);
      } else if (k) {
        fy += (fy > 0.5 ? -1 : 1) * 0.06 * k;
      }
      const x = fx * W, y = fy * H, r = 28;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = sevColor[d.severity];
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.fillStyle = d.severity === "minor" ? "#1d1400" : "#ffffff";
      ctx.font = "700 30px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), x, y + 1);
    });
    ctx.restore();
  },
};

/* ---------------------------------------------------------------- scan check (photo quality + edge/corner candidates) */

const httpsUrl = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : "");  // reference URLs are untrusted data
const QUALITY_TEXT = { ok: "Photo OK", warn: "Usable, with limits", rescan: "Retake this photo" };

function runInspection(side) {
  const s = state.scans[side];
  if (!s || !s.photo || !s.result) return;
  try {
    s.quality = Inspect.quality(s.photo, s.result);
    const opts = { quality: s.quality, face: side };
    if (side === "front" && state.reference && state.reference.rgba && state.reference.usable) {
      opts.printedMask = Identify.printedMask(state.reference.rgba, s.result.warped, s.margin);
    }
    s.check = Inspect.edgesAndCorners(s.result, opts);
  } catch (err) {
    s.quality = null;
    s.check = null;
  }
}

const blockedText = (item) => {
  const [comp, where] = item.split(":");
  return where ? `${pretty(where)} ${comp === "corners" ? "corner" : "edge"}` : comp;
};

function scanCheckLine(text, cls = "") {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.textContent = text;
  return li;
}

function renderScanCheck() {
  const body = $("#scancheck-body");
  const parts = SIDES.map((side) => {
    const q = state.scans[side] && state.scans[side].quality;
    return q ? `${cap(side)}: ${QUALITY_TEXT[q.verdict].toLowerCase()}` : null;
  }).filter(Boolean);
  $("#scancheck-summary").textContent = parts.join(" · ") || "No photos";
  if (!body) return;
  body.innerHTML = "";
  const side = state.activeSide, s = state.scans[side];
  if (!s || !s.photo) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = s ? "The photo isn't kept after you reload the page, so it can't be checked again. Rescan it to check the photo." : `No ${side} photo, so nothing can be checked here. Photos of both sides are needed for a full assessment.`;
    body.append(p);
    return;
  }
  const q = s.quality, c = s.check;
  if (!q || !c) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "The checks couldn't run on this photo. Try scanning it again.";
    body.append(p);
    return;
  }
  const head = document.createElement("div");
  head.className = "sc-verdict";
  head.innerHTML = `<span class="chip ${q.verdict}"></span>`;
  $(".chip", head).textContent = QUALITY_TEXT[q.verdict];
  body.append(head);

  const problems = Object.entries(q.checks).filter(([, v]) => v.status !== "ok");
  const ul = document.createElement("ul");
  ul.className = "sc-list";
  if (problems.length) for (const [, v] of problems) ul.append(scanCheckLine(v.note, v.status));
  else ul.append(scanCheckLine("Sharpness, glare, resolution and framing look fine."));
  if (q.blocked.length) ul.append(scanCheckLine(`This photo can't show: ${q.blocked.map(blockedText).join(", ")}. Rescan with better light, or check those by eye and log them in DINGS.`, "warn"));
  body.append(ul);

  const toggle = document.createElement("label");
  toggle.className = "sc-toggle";
  toggle.innerHTML = '<input type="checkbox"><span>Show suspected damage on the card</span>';
  const box = $("input", toggle);
  box.checked = state.showSuspects;
  box.addEventListener("change", () => { state.showSuspects = box.checked; viewer.render(); });
  body.append(toggle);

  const sub = document.createElement("p");
  sub.className = "sc-sub";
  sub.textContent = "Edges and corners";
  body.append(sub);
  const sum = document.createElement("p");
  sum.className = "sc-summary";
  sum.textContent = c.summary;
  body.append(sum);

  for (const d of c.defects) {
    const row = document.createElement("div");
    row.className = "sc-cand";
    const label = CRITERIA.defects.types[d.type] ? CRITERIA.defects.types[d.type].label : pretty(d.type);
    row.innerHTML = "<div><b></b><small></small></div><button type=\"button\" class=\"btn small\">Add to DINGS</button>";
    $("b", row).textContent = `${label} · ${cap(d.severity)} · ${whereText(d)}`;
    $("small", row).textContent = d.note || "";
    $("button", row).addEventListener("click", () => {
      leaveExample();
      state.defects.push({ side: d.side || side, location: d.location, type: d.type, severity: d.severity, note: `Auto-detected: ${d.note || label}`.slice(0, 200) });
      markInspected(d.side || side, COMPONENT_OF[d.location]);
      runGrade();
    });
    body.append(row);
  }
  const det = document.createElement("details");
  det.innerHTML = "<summary class=\"link-btn\">What this can't tell you</summary><ul class=\"sc-limits\"></ul>";
  for (const l of c.limitations) { const li = document.createElement("li"); li.textContent = l; $("ul", det).append(li); }
  body.append(det);
}

// Draw the photo-check overlays on the card viewer (coordinates are in the flattened scan, margin included).
function drawSuspects(ctx, scan, X, Y, color) {
  if (!state.showSuspects || !scan || !X) return;
  const sev = { micro: color("--good", "#178a5d"), minor: color("--warn", "#b26b00"), moderate: color("--bad", "#c2362f"), major: color("--bad", "#c2362f") };
  const shapes = [...((scan.quality && scan.quality.overlays) || []), ...((scan.check && scan.check.overlays) || [])];
  ctx.save();
  ctx.lineWidth = 3;
  for (const o of shapes) {
    const likely = o.kind === "edge" || o.kind === "corner" ? o.likely : false;
    if (o.kind === "glare") { ctx.fillStyle = "rgba(255, 214, 10, 0.35)"; ctx.strokeStyle = "transparent"; }
    else if (o.kind === "unassessable") { ctx.fillStyle = "rgba(150, 156, 168, 0.28)"; ctx.strokeStyle = "transparent"; }
    else { ctx.fillStyle = "transparent"; ctx.strokeStyle = likely ? sev[o.severity] || sev.minor : "rgba(190, 196, 208, 0.9)"; ctx.setLineDash(likely ? [] : [6, 5]); }
    if (o.type === "rect") {
      const x = X(o.x), y = Y(o.y), w = o.w * (X(1) - X(0)), h = o.h * (Y(1) - Y(0));
      const pad = o.kind === "edge" || o.kind === "corner" ? 4 : 0;
      ctx.fillRect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
      if (o.kind === "edge" || o.kind === "corner") ctx.strokeRect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
    } else if (o.type === "polyline" && o.points && o.points.length) {
      ctx.beginPath();
      o.points.forEach(([px, py], i) => (i ? ctx.lineTo(X(px), Y(py)) : ctx.moveTo(X(px), Y(py))));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- identify the card + reference image */

function clearReference() {
  if (state.reference && state.reference.objectUrl) URL.revokeObjectURL(state.reference.objectUrl);
  const had = !!state.reference;
  state.reference = null;
  $("#reference-panel").hidden = true;
  if (had && state.scans.front) { runInspection("front"); renderScanCheck(); viewer.render(); }
}

function showReference() {
  const r = state.reference;
  $("#reference-panel").hidden = !r;
  if (!r) return;
  $("#reference-img").src = httpsUrl(r.thumb_url) || httpsUrl(r.image_url) || r.objectUrl || "";
  $("#reference-name").textContent = r.name || "Your reference image";
  const src = $("#reference-source");
  src.textContent = r.source === "user" ? "Source: an image you supplied." : `Source: ${r.source}, matched by set and number and confirmed by you. `;
  if (httpsUrl(r.source_url)) {
    const a = document.createElement("a");
    a.href = r.source_url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Open the source";
    src.append(a);
  }
  const notes = [];
  if (r.problems && r.problems.length) notes.push(`Not used for comparison: ${r.problems.join(" ")}`);
  else if (r.usable) notes.push(`Printed white/light areas on the front are ignored when looking for whitening (${r.coverage}% of the edge band marked).`);
  else if (r.image_readable === false) notes.push("This image host doesn't allow reading its pixels, so it is shown for you to compare by eye only. Save the image and add it as a file to use it for printed-white masking.");
  else notes.push("Loading the image for comparison…");
  $("#reference-checks").textContent = notes.join(" ");
}

async function prepareReference(ref) {
  // Decode the reference and judge whether it can be used; never throws.
  if (ref.image_readable === false && !ref.image) return;
  try {
    ref.rgba = await Identify.loadReferenceRGBA(ref);
    const chk = Identify.checkReference(ref.rgba);
    ref.usable = chk.usable;
    ref.problems = chk.usable ? [] : chk.reasons;
    if (chk.usable && state.scans.front) {
      const mask = Identify.printedMask(ref.rgba, state.scans.front.result.warped, state.scans.front.margin);
      ref.coverage = Math.round(Identify.maskCoverage(mask, state.scans.front.width, state.scans.front.height, state.scans.front.margin) * 100);
    }
  } catch (err) {
    ref.usable = false;
    ref.problems = ["The image couldn't be loaded for comparison."];
  }
}

async function setReference(ref) {
  if (state.reference && state.reference.objectUrl) URL.revokeObjectURL(state.reference.objectUrl);
  state.reference = ref;
  showReference();
  await prepareReference(ref);
  if (state.reference !== ref) return;  // replaced meanwhile
  showReference();
  runInspection("front");
  renderScanCheck();
  viewer.render();
}

function setStatus(text) { $("#id-status").textContent = text; }

function confirmCandidate(c) {
  leaveExample();
  const set = (id, v) => { if (v) $(`#${id}`).value = v; };
  set("card-name", c.name);
  set("card-set", c.set_name);
  set("card-set-code", c.set_code);
  set("card-number", c.number);
  set("card-year", c.year);
  if (c.rarity) {
    const sel = $("#card-rarity");
    if (![...sel.options].some((o) => o.value === c.rarity)) {  // the database's wording may differ from our list
      const o = document.createElement("option");
      o.value = o.textContent = c.rarity;
      sel.append(o);
    }
    sel.value = c.rarity;
  }
  renderDetails();
  saveDraft();
  $("#id-results").hidden = true;
  setStatus(`Confirmed: ${c.name}. Finish and language are left for you to set.`);
  setReference({ image_url: c.image_url, thumb_url: c.thumb_url, source: c.source, source_url: c.source_url, name: `${c.name}${c.variant ? ` · ${c.variant}` : ""}`, image_readable: c.image_readable });
}

function idNote(box, text) {
  const p = document.createElement("p");
  p.className = "id-note";
  p.textContent = text;
  box.append(p);
}

function renderManualReference(box) {
  const wrap = document.createElement("div");
  wrap.className = "id-manual";
  wrap.innerHTML = '<label>Use your own reference image (link or file)<input type="url" placeholder="https://… image link" autocomplete="off"></label><input type="file" accept="image/png,image/jpeg,image/webp"><button type="button" class="btn small">Use this reference</button>';
  $("button", wrap).addEventListener("click", async () => {
    const file = $("input[type=file]", wrap).files[0];
    const url = $("input[type=url]", wrap).value.trim();
    const res = Identify.manualReference(file ? { file } : { url });
    if (!res.ok) { setStatus(res.error); return; }
    const ref = { source: "user", name: file ? file.name : "Your reference image", image_readable: true };
    if (file) { ref.image = file; ref.objectUrl = URL.createObjectURL(file); } else ref.image_url = res.image_url;
    box.hidden = true;
    setStatus("Reference added. Nothing is inferred from it beyond ignoring printed white near the edges.");
    setReference(ref);
  });
  box.append(wrap);
}

function renderCandidates(res) {
  const box = $("#id-results");
  box.innerHTML = "";
  box.hidden = false;
  if (res.error || !res.candidates.length) {
    idNote(box, res.error || "No matching card found.");
    idNote(box, "Nothing is being used as a reference. You can fill in the details by hand, or supply a reference image yourself.");
    renderManualReference(box);
    setStatus("Not identified.");
    return;
  }
  setStatus(res.needs_confirmation ? "Several cards could match. Pick yours, or none." : "Check this is your exact card, including the variant.");
  idNote(box, "Look closely at the artwork, frame and any foil pattern: alternate versions of the same number look alike. Nothing is used until you confirm.");
  for (const c of res.candidates.slice(0, 6)) {
    const row = document.createElement("div");
    row.className = "id-cand";
    const img = document.createElement("img");
    img.alt = "";
    img.src = httpsUrl(c.thumb_url) || httpsUrl(c.image_url);
    const info = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = c.name;
    const line = document.createElement("span");
    line.textContent = [c.set_name, c.number, c.rarity, c.variant].filter(Boolean).join(" · ");
    const ev = document.createElement("span");
    ev.textContent = ` ${Math.round(c.confidence * 100)}% match: ${(c.evidence || []).join("; ")}`;
    info.append(b, line, document.createElement("br"), ev);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small";
    btn.textContent = "This is my card";
    btn.addEventListener("click", () => confirmCandidate(c));
    row.append(img, info, btn);
    box.append(row);
  }
  renderManualReference(box);
}

async function findCard() {
  const btn = $("#find-card");
  const c = assessment().card;
  if (!c.set_code && !c.number && !c.name) { setStatus("Enter a set code and number (or a name) first."); return; }
  btn.disabled = true;
  setStatus("Looking it up…");
  let res;
  try {
    res = await Identify.candidates({ game: state.game, set_code: c.set_code, number: c.number, name: c.name, language: c.language }, { fetch: (...a) => window.fetch(...a) });
  } catch (err) {
    res = { candidates: [], error: "The lookup failed (offline, or this page can't reach the card database)." };
  }
  btn.disabled = false;
  renderCandidates(res);
}

/* ---------------------------------------------------------------- grading + report */

function assessment() {
  return {
    card: {
      game: state.game,
      name: $("#card-name").value.trim(),
      ...Object.fromEntries(Object.entries(DETAIL_FIELDS).map(([id, key]) => [key, $(`#${id}`).value.trim()])),
      holo: ["Holo", "Reverse holo", "Foil", "Etched / textured", "Metal"].includes($("#card-finish").value),
      notes: "",
    },
    // Raw shares plus where they came from: the engine counts an unread axis as 55/45.
    centering: { front: { ...state.centering.front }, back: { ...state.centering.back } },
    centering_evidence: { front: { ...state.evidence.front }, back: { ...state.evidence.back } },
    defects: state.defects,
    inspected: { front: [...state.inspected.front], back: [...state.inspected.back] },
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

const gradeText = (g) => (g.grade % 1 === 0 ? g.grade.toFixed(0) : g.grade.toFixed(1));
// An incomplete grade is a ceiling (this app's convention): shown as "≤ 10", never as a plain 10.
const bigGrade = (g) => (g.tier >= 99 ? "—" : g.complete === false ? `≤ ${gradeText(g)}` : gradeText(g));
const bigGradeHTML = (g) => (g.tier >= 99 ? "—" : g.complete === false ? `<span class="ceil">≤</span>${gradeText(g)}` : gradeText(g) + (isPristine(g) ? "<small>P</small>" : ""));
const isPristine = (g) => g.label.startsWith("Pristine");
// Label without the "Up to … · incomplete" wrapper, for the short tile/score labels.
const baseLabel = (g) => g.label.replace(/^Up to /, "").replace(/ · incomplete$/, "");
const conditionWord = (v) => CONDITION_WORDS.find(([min]) => v >= min)[1];
const status = (v) => (v >= 10 ? "good" : v >= 8.5 ? "warn" : "bad");

// Rank for the "Best shot" badge: the highest grade wins, with Pristine and Black Label above a plain 10.
const gradeRank = (g) => (g.tier >= 99 ? -1 : g.label.includes("Black Label") ? 11 : isPristine(g) ? 10.5 : g.grade);

function bestCompany(report) {
  if (report.complete === false) return null;  // a ceiling isn't a grade, so there's no best shot yet
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
    const incomplete = g.complete === false;
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile" + (best ? " best" : "") + (incomplete ? " incomplete" : "");
    tile.dataset.co = g.company;
    tile.innerHTML = `<span class="tile-co">${g.company}${best ? '<span class="tile-badge">Best shot</span>' : ""}</span>
      ${incomplete ? '<span class="tile-flag">Incomplete</span>' : ""}
      <span class="tile-grade"></span><span class="tile-label"></span><span class="tile-sub"></span>`;
    $(".tile-grade", tile).innerHTML = bigGradeHTML(g);
    $(".tile-label", tile).textContent = (incomplete ? "Up to " : "") +
      baseLabel(g).replace(/\s*\d+(\.\d)?$/, "").replace(/ 10 \(Black Label\)$/, " · Black Label");
    $(".tile-sub", tile).textContent = g.company === "TAG" && g.score != null ? `${incomplete ? "≤ " : ""}${g.score} / 1000` : g.qualifiers.length ? g.qualifiers.join(" · ") : " ";
    tile.addEventListener("click", () => {
      const d = $(`.company[data-co="${g.company}"]`);
      d.open = true;
      d.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    box.append(tile);
  }
  const line = $("#best-line");
  line.classList.toggle("incomplete", !top);
  line.textContent = !top
    ? `Incomplete: not checked yet: ${report.unassessed.join(", ")}. These are ceilings, not grades.`
    : top.tier >= 99
      ? "This card looks altered, so no company would give it a number."
      : `Your best shot is ${top.company} ${top.label}. Tap a grade for the breakdown.`;
}

function renderScore(report) {
  const g = report.grades.TAG;
  const altered = g.tier >= 99;
  const incomplete = report.complete === false;
  $(".score-block").classList.toggle("incomplete", incomplete);
  $("#score-incomplete").hidden = !incomplete;
  $("#score-missing").hidden = !incomplete;
  $("#score-missing-list").textContent = incomplete ? report.unassessed.join(", ") : "";
  $("#score-grade").innerHTML = bigGradeHTML(g);
  $("#score-label").textContent = altered ? g.label : (incomplete ? "Up to " : "") + baseLabel(g).replace(/\s*\d+(\.\d)?$/, "");
  $("#score-num").textContent = altered ? "—" : incomplete ? `≤ ${g.score}` : g.score;
  $("#score-bar").style.width = altered ? "0%" : `${Math.max(0, ((g.score - 100) / 900) * 100)}%`;
  const f = state.centering.front, b = state.centering.back;
  $("#centering-summary").textContent = `${splitText(Math.max(f.lr, f.tb))} · ${splitText(Math.max(b.lr, b.tb))}`;
}

function renderMetrics(report) {
  // Rank only complete grades (re-graded with the current rules): a ceiling can't be ranked.
  const score = report.complete === false ? null : report.grades.TAG.score;
  const others = localStore.cards().map((c) => ({ c, r: currentReport(c) }))
    .filter(({ c, r }) => c.id !== state.savedId && r && r.complete !== false && r.grades.TAG.score != null);
  const rank = score == null ? null : 1 + others.filter(({ r }) => r.grades.TAG.score > score).length;
  const f = state.centering.front, ev = state.evidence.front;
  const items = [
    [String(state.defects.length), "DINGS"],
    [rank == null ? "—" : `#${rank}/${others.length + 1}`, "Rank in History"],
    [ev.lr === "unread" || ev.tb === "unread" ? (state.scans.front ? "Check guides" : "Not measured") : splitText(Math.max(f.lr, f.tb)), "Front centering"],
  ];
  const box = $("#metrics");
  box.innerHTML = "";
  for (const [value, label] of items) {
    const div = document.createElement("div");
    div.className = "metric";
    div.innerHTML = "<b></b><span></span>";
    $("b", div).textContent = value;
    $("span", div).textContent = label;
    box.append(div);
  }
}

function renderSubgrades(report) {
  const box = $("#subgrades");
  const areas = report.grades.TAG.subgrades;
  box.innerHTML = "";
  if (report.grades.TAG.tier >= 99) {
    box.innerHTML = '<p class="hint" style="grid-column: 1 / -1">No subgrades: the card is logged as altered.</p>';
    return;
  }
  box.insertAdjacentHTML("beforeend", '<span></span><span class="col-head">Front</span><span class="col-head">Back</span>');
  for (const comp of ["centering", "corners", "edges", "surface"]) {
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = cap(comp);
    box.append(name);
    for (const side of SIDES) {
      const v = areas[`${side} ${comp}`];
      const cell = document.createElement("div");
      if (v == null) {  // not inspected: no score, only a ceiling
        cell.className = "sub-cell unchecked";
        cell.innerHTML = '<b>Not checked</b><span class="sbar"></span>';
        cell.setAttribute("aria-label", `${side} ${comp} not checked`);
        box.append(cell);
        continue;
      }
      cell.className = `sub-cell ${v >= 950 ? "good" : v >= 850 ? "warn" : "bad"}`;
      cell.innerHTML = '<b></b><span class="sbar"><span></span></span>';
      $("b", cell).textContent = v;
      $(".sbar span", cell).style.width = `${Math.max(2, ((v - 100) / 900) * 100)}%`;
      cell.setAttribute("aria-label", `${side} ${comp} ${v} out of 1000`);
      box.append(cell);
    }
  }
}

function subLabel(company, v) {
  if (v == null) return "not checked";
  if (typeof v !== "number" || company === "TAG") return String(v);
  return v >= 10.5 ? "10P" : String(v);
}

function renderCompanies(report) {
  const box = $("#companies");
  const open = new Set($$(".company[open]", box).map((d) => d.dataset.co));
  box.innerHTML = "";
  for (const g of Object.values(report.grades)) {
    const d = document.createElement("details");
    d.className = "company" + (g.complete === false ? " incomplete" : "");
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

function renderReport() {
  const report = state.report;
  if (!report) return;
  renderScore(report);
  renderDetails();
  renderMetrics(report);
  renderSubgrades(report);
  renderTiles(report);
  renderDefects();
  renderScanCheck();
  renderCompanies(report);
  viewer.render();
  $("#disclaimer").textContent = report.disclaimer;
}

/* ---------------------------------------------------------------- card details */

function fillSelect(sel, options, labels = null) {
  const current = sel.value;
  sel.innerHTML = "";
  for (const v of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v === "" ? "—" : labels ? labels[v] : v;
    sel.append(o);
  }
  if (options.includes(current)) sel.value = current;
}

function renderDetails() {
  const c = assessment().card;
  const rows = [
    ["Game", gameInfo(state.game).label],
    ["Set", [c.set_name, c.set_code && `(${c.set_code})`].filter(Boolean).join(" ")],
    ["Number", c.number],
    ["Rarity", c.rarity],
    ["Finish", c.finish],
    ["Card type", c.card_type],
    ["Language", c.language ? LANGUAGES[c.language] || c.language : ""],
    ["Year", c.year],
  ];
  const dl = $("#details-view");
  dl.innerHTML = "";
  for (const [k, v] of rows) {
    const div = document.createElement("div");
    div.innerHTML = "<dt></dt><dd></dd>";
    $("dt", div).textContent = k;
    const dd = $("dd", div);
    dd.textContent = v || "Not set";
    dd.classList.toggle("empty", !v);
    dl.append(div);
  }
  $("#identity-sub").textContent = [c.subtitle, c.card_type].filter(Boolean).join(" · ");
}

function setDetailsEditing(on) {
  $("#details-form").hidden = !on;
  $("#details-view").hidden = on;
  $("#edit-details").textContent = on ? "Close" : "Edit";
  $("#edit-details").setAttribute("aria-expanded", String(on));
}

function clearDetails() {
  for (const id of Object.keys(DETAIL_FIELDS)) $(`#${id}`).value = "";
  $("#card-language").value = "EN";
  $("#collector-line").value = "";
}

function fillDetails(card) {
  for (const [id, key] of Object.entries(DETAIL_FIELDS)) {
    const el = $(`#${id}`);
    const v = card[key] == null ? "" : String(card[key]);
    if (el.tagName === "SELECT" && v && ![...el.options].some((o) => o.value === v)) {
      const o = document.createElement("option");  // keep values from older saves or other games
      o.value = v;
      o.textContent = v;
      el.append(o);
    }
    el.value = v;
  }
  if (!card.language) $("#card-language").value = "EN";
}

/* ---------------------------------------------------------------- game */

function renderGame() {
  const g = gameInfo(state.game);
  $$("#game-seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.game === state.game)));
  const tips = $("#tips");
  tips.innerHTML = "";
  for (const t of g.tips) {
    const li = document.createElement("li");
    li.textContent = t;
    tips.append(li);
  }
  $("#card-name").placeholder = g.placeholders.name;
  $("#card-set").placeholder = g.placeholders.set;
  $("#card-number").placeholder = g.placeholders.number;
  fillSelect($("#card-rarity"), ["", ...g.rarities]);
  $("#condition-hint").textContent = g.hint;
  $("#game-chip").textContent = g.label;
}

function setGame(game, { remember = true } = {}) {
  state.game = GAMES[game] ? game : "pokemon";
  if (remember) localStore.write(KEYS.game, state.game);
  renderGame();
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
  state.inspected = { front: [], back: [] };
  state.evidence = { front: { lr: "unread", tb: "unread" }, back: { lr: "unread", tb: "unread" } };
  state.activeSide = "front";
  state.example = false;
  state.report = null;
  state.savedId = null;
  clearReference();
  $("#id-results").hidden = true;
  $("#card-name").value = "";
  clearDetails();
  setDetailsEditing(false);
  $("#example-note").hidden = true;
}

function newScan() {
  resetCard();
  localStore.remove(KEYS.draft);
  localStore.remove(KEYS.draftV2);
  setView("scan");
}

/* ---------------------------------------------------------------- example + drafts */

function showExample() {
  resetCard();
  const ex = gameInfo(state.game).example;
  for (const side of SIDES) {
    const photo = samplePhoto(side, state.game);
    applyScan(side, Vision.scan(photo), photo);
  }
  state.defects = ex.defects.map((d) => ({ ...d }));
  // The example card was fully inspected, so it shows a complete grade.
  state.inspected = { front: [...COMPONENTS], back: [...COMPONENTS] };
  $("#card-name").value = ex.name;
  fillDetails({ ...ex.details, set_name: ex.set, number: ex.number });
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
  const draft = localStore.draft();
  const btn = $("#resume");
  btn.hidden = !(draft && draft.centering);
  if (!btn.hidden) btn.textContent = `Resume ${draft.card && draft.card.name ? draft.card.name : "last card"}`;
}

function loadAssessment(a, thumbs) {
  resetCard();
  setGame((a.card && a.card.game) || "pokemon", { remember: false });
  $("#card-name").value = a.card.name || "";
  fillDetails(a.card);
  state.centering = { front: { ...a.centering.front }, back: { ...a.centering.back } };
  state.defects = (a.defects || []).map((d) => ({ ...d }));
  // Older saves have no inspection record: their areas start unchecked. Their centering was typed or
  // measured before saving (the grading engine's default when evidence is missing).
  state.inspected = { front: [...((a.inspected || {}).front || [])], back: [...((a.inspected || {}).back || [])] };
  const ev = a.centering_evidence || {};
  state.evidence = {
    front: { lr: "typed", tb: "typed", ...(ev.front || {}) },
    back: { lr: "typed", tb: "typed", ...(ev.back || {}) },
  };
  state.thumbs = { front: (thumbs && thumbs.front) || null, back: (thumbs && thumbs.back) || null };
  setView("report");
}

/* ---------------------------------------------------------------- history */

// Saved reports are re-graded with the current rules (so older saves show as incomplete if nothing was
// marked as checked). Cached per saved card: the rules don't change while the page is open.
const regradeCache = new Map();
function currentReport(c) {
  const key = `${c.id}|${c.created_at}`;
  if (!regradeCache.has(key)) {
    let r = c.report || null;
    try { r = Grading.gradeAll(c.assessment, CRITERIA); } catch (_) { /* keep the saved report */ }
    regradeCache.set(key, r);
  }
  return regradeCache.get(key);
}

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
    $(".h-meta", li).textContent = [gameInfo(card.game).label, card.set_name, card.number, card.rarity, new Date(c.created_at).toLocaleDateString()].filter(Boolean).join(" · ");
    const report = currentReport(c);
    $(".h-grades", li).textContent = report ? Object.values(report.grades).map((g) => `${g.company} ${bigGrade(g)}`).join(" · ") : "";
    if (report && report.complete === false) $(".h-grades", li).insertAdjacentHTML("afterbegin", '<span class="h-flag">Incomplete</span> · ');
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
  const cards = localStore.cards().filter((c) => c.id !== state.savedId);  // saving again replaces the earlier save
  state.savedId = `${Date.now()}`;
  cards.unshift({
    id: state.savedId,
    created_at: new Date().toISOString(),
    assessment: assessment(),
    report: state.report,
    front_thumb: state.thumbs.front,
    back_thumb: state.thumbs.back,
  });
  if (localStore.saveCards(cards)) {
    toast(`Saved. ${cards.length} card${cards.length === 1 ? "" : "s"} in History.`);
    renderMetrics(state.report);
  }
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
  $$("#game-seg button").forEach((b) => b.addEventListener("click", () => setGame(b.dataset.game)));
  setGame(localStore.read(KEYS.game, "pokemon"), { remember: false });
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
    const draft = localStore.draft();
    if (draft) loadAssessment(draft, draft.thumbs);
  });

  // Report screen
  $("#back-to-scan").addEventListener("click", newScan);
  $("#new-scan").addEventListener("click", newScan);
  $("#scan-own").addEventListener("click", newScan);
  $("#save-card").addEventListener("click", saveCard);
  for (const id of ["#open-history", "#open-history-2"]) $(id).addEventListener("click", openHistory);
  viewer.init();
  $$("#centering-section .segmented button, #scancheck-section .segmented button, .viewer-side button").forEach((b) => b.addEventListener("click", () => {
    if (guide.outline) setOutlineMode(false);
    state.activeSide = b.dataset.side;
    renderCentering();
  }));
  for (const [id, key] of [["#ratio-lr", "lr"], ["#ratio-tb", "tb"]]) {
    $(id).addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (isNaN(v)) return;
      leaveExample();
      state.centering[state.activeSide][key] = Math.min(100, Math.max(50, v));
      state.evidence[state.activeSide][key] = "typed";  // typed in by hand: no longer unread
      renderRatioInputs();
      scheduleGrade();
    });
    $(id).addEventListener("blur", renderRatioInputs);
  }
  $("#adjust-outline").addEventListener("click", () => setOutlineMode(true));
  $("#outline-cancel").addEventListener("click", () => setOutlineMode(false));
  $("#outline-apply").addEventListener("click", applyOutline);
  $("#retake-file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) scanFile(state.activeSide, f);
  });
  fillSelect($("#card-finish"), FINISHES);
  fillSelect($("#card-language"), ["", ...Object.keys(LANGUAGES)], { "": "—", ...LANGUAGES });
  $("#card-language").value = "EN";
  for (const id of ["card-name", ...Object.keys(DETAIL_FIELDS)]) {
    $(`#${id}`).addEventListener("input", () => { leaveExample(); renderDetails(); saveDraft(); });
    $(`#${id}`).addEventListener("change", () => { leaveExample(); renderDetails(); saveDraft(); });
  }
  $("#collector-line").addEventListener("input", (e) => {
    const parsed = parseCollectorLine(e.target.value);
    if (parsed.set_code) $("#card-set-code").value = parsed.set_code;
    if (parsed.number) $("#card-number").value = parsed.number;
    if (parsed.language) $("#card-language").value = parsed.language;
    leaveExample();
    renderDetails();
    saveDraft();
  });
  $("#find-card").addEventListener("click", findCard);
  $("#clear-reference").addEventListener("click", () => { clearReference(); setStatus("Reference removed."); });
  // A reference only belongs to the card it was confirmed for: changing what identifies the card drops it.
  for (const id of ["card-set-code", "card-number", "card-language"]) {
    $(`#${id}`).addEventListener("input", () => { if (state.reference && state.reference.source !== "user") { clearReference(); setStatus("Details changed: find the card again to get its reference."); } });
  }
  $("#edit-details").addEventListener("click", () => setDetailsEditing($("#details-form").hidden));
  $("#done-details").addEventListener("click", () => setDetailsEditing(false));

  // Inspection checklist
  for (const box of $$("#inspect input[type=checkbox]")) {
    box.addEventListener("change", () => setInspected(box.dataset.side, box.dataset.comp, box.checked));
  }
  $("#go-checklist").addEventListener("click", () => {
    $("#condition-section").open = true;
    $("#inspect").scrollIntoView({ behavior: "smooth", block: "center" });
  });

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
