/* Card Grading Lab: standalone app. Tabs: Scan (then Review and its detail screens), History, Settings.
   Everything runs in the browser. */
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

/* ---------------------------------------------------------------- optional modules (thin adapters) */

// The scan-confidence, surface-tool and background-worker modules are separate files. Until they are part of
// the build, these adapters keep the app working: the fallbacks below are deliberately minimal.
const CONF_LABEL = { high: "High", medium: "Medium", low: "Low", cannot_assess: "Cannot assess", not_scanned: "Not scanned", assessing: "Assessing scan…" };
const CONF_RANK = { cannot_assess: 0, low: 1, medium: 2, high: 3 };
const CONF_AREAS = [["outline", "Outline"], ["centering", "Centering"], ["corners_edges", "Corners & edges"], ["surface_visibility", "Surface visibility"]];

const FallbackConfidence = {
  notScanned: () => ({ level: "not_scanned", label: CONF_LABEL.not_scanned, areas: null, surfaceLimited: false, summary: "No photo of this side yet.", reasons: [], actions: [] }),
  assessing: () => ({ level: "assessing", label: CONF_LABEL.assessing, areas: null, surfaceLimited: false, summary: "", reasons: [], actions: [] }),
  // Minimal stand-in: rates what the scan and the photo check already report. The real rules live in confidence.js.
  assess({ scan, quality, evidence, outlineAdjusted }) {
    if (!scan) return this.notScanned();
    const area = (level, reason) => ({ level, reason });
    const cardConf = scan.confidence ? scan.confidence.card : 0, borders = scan.confidence ? scan.confidence.borders : 0;
    const unread = evidence && (evidence.lr === "unread" || evidence.tb === "unread");
    const blocked = (quality && quality.blocked) || [];
    const areas = {
      outline: outlineAdjusted ? area("high", "Outline set by hand.") : area(cardConf >= 0.8 ? "high" : cardConf >= 0.6 ? "medium" : "low", cardConf >= 0.8 ? "The card's outline was found clearly." : "The card's outline was hard to find."),
      centering: unread ? area("low", "A border couldn't be read; line up the guides by hand.") : area(borders >= 0.8 ? "high" : borders >= 0.6 ? "medium" : "low", borders >= 0.8 ? "The printed borders read clearly." : "The printed borders were hard to read."),
      corners_edges: !quality ? area("cannot_assess", "The photo check couldn't run.")
        : quality.verdict === "rescan" ? area("cannot_assess", "This photo can't support a reliable check.")
        : blocked.length ? area("low", "Part of the edges or corners can't be seen in this photo.")
        : area(quality.verdict === "ok" ? "high" : "medium", quality.verdict === "ok" ? "Sharpness, glare and framing look fine." : "Usable, with some limits."),
      surface_visibility: area("low", "A flat photo can't show surface wear."),
    };
    const levels = ["outline", "centering", "corners_edges"].map((k) => areas[k].level);
    const level = levels.reduce((a, b) => (CONF_RANK[b] < CONF_RANK[a] ? b : a), "high");
    const actions = [];
    if (quality && quality.verdict === "rescan") actions.push({ id: "retake", label: "Retake photo" });
    else if (areas.outline.level === "low") actions.push({ id: "adjust_outline", label: "Adjust outline" });
    actions.push({ id: "angled_light", label: "Add angled-light photo" });
    const summary = level === "high" ? "Outline, borders and corners read clearly." : level === "cannot_assess" ? "This photo can't support a reliable check." : "Some of this photo was hard to read.";
    return { level, label: CONF_LABEL[level], areas, surfaceLimited: true, summary, reasons: levels.filter((l) => l !== "high").length ? [summary] : [], actions };
  },
  combine(front, back) {
    const sides = { front, back };
    const missing = SIDES.filter((s) => !sides[s] || sides[s].level === "not_scanned");
    if (SIDES.some((s) => sides[s] && sides[s].level === "assessing")) return { level: "assessing", label: CONF_LABEL.assessing, reasons: [], missing };
    const scored = SIDES.map((s) => sides[s]).filter((c) => c && c.level in CONF_RANK);
    if (!scored.length) return { level: "not_scanned", label: CONF_LABEL.not_scanned, reasons: [], missing };
    const level = scored.map((c) => c.level).reduce((a, b) => (CONF_RANK[b] < CONF_RANK[a] ? b : a), "high");
    return { level, label: CONF_LABEL[level], reasons: scored.flatMap((c) => c.reasons || []), missing };
  },
};
const Confidence = () => (window.ScanConfidence && typeof window.ScanConfidence.assess === "function" ? window.ScanConfidence : FallbackConfidence);

const SURFACE_FILTERS = [
  ["original", "Original"], ["grayscale", "Grayscale"], ["contrast", "Contrast"], ["red", "Red"], ["green", "Green"],
  ["blue", "Blue"], ["invert", "Invert"], ["difference", "Color difference"],
];
const surfaceApi = () => (window.Surface && typeof window.Surface.filter === "function" ? window.Surface : null);

/** Same interface as ScanWorker (scanworker.js), on the main thread: used only if that module is missing. */
function mainThreadRunner(reason) {
  const jobs = new Map();  // coalesceKey -> job
  const work = {
    scan(p) {
      const scan = Vision.scan(p.pixels, p.mode || "auto", p.corners || null);
      let quality = null, check = null;
      try {
        quality = Inspect.quality(p.pixels, scan);
        check = Inspect.edgesAndCorners(scan, { quality, face: p.face, ...(p.printedMask ? { printedMask: p.printedMask } : {}) });
      } catch (_) { quality = null; check = null; }
      return { scan, quality, check, pixels: p.pixels };
    },
    marks(p) {
      const api = surfaceApi();
      if (!api || typeof api.findMarks !== "function") return { status: "unavailable", candidates: [], cannotAssess: [], note: "Mark finding isn't available in this build." };
      const { scan, ...opts } = p;
      return api.findMarks(scan, opts);
    },
    filter(p) {
      const api = surfaceApi();
      if (!api) throw new Error("Filters aren't available in this build.");
      return api.filter(p.src, { kind: p.kind, intensity: p.intensity, reference: p.reference });
    },
  };
  return {
    mode: "main-thread",
    unavailableReason: reason,
    run(kind, payload, { coalesceKey } = {}) {
      if (coalesceKey && jobs.has(coalesceKey)) this.cancel(coalesceKey);
      return new Promise((resolve, reject) => {
        const job = { reject, done: false };
        if (coalesceKey) jobs.set(coalesceKey, job);
        // A short delay lets the busy state paint first (and lets a newer request replace this one).
        setTimeout(() => {
          if (job.done) return;
          job.done = true;
          if (coalesceKey && jobs.get(coalesceKey) === job) jobs.delete(coalesceKey);
          try { resolve(work[kind](payload)); } catch (err) { reject(err); }
        }, kind === "filter" ? 30 : 40);
      });
    },
    cancel(key) {
      const job = jobs.get(key);
      if (!job) return;
      jobs.delete(key);
      if (!job.done) { job.done = true; job.reject({ stale: true }); }
    },
    dispose() { for (const key of [...jobs.keys()]) this.cancel(key); },
  };
}

let runnerInstance = null;
function runner() {
  if (runnerInstance) return runnerInstance;
  if (window.ScanWorker && typeof window.ScanWorker.create === "function") {
    try {
      runnerInstance = window.ScanWorker.create({ sources: window.SCAN_WORKER_SOURCES });
      // The worker can still fall back to the main thread (no answer within its start-up time): say so then.
      if (runnerInstance.ready) runnerInstance.ready.then(() => { renderConfidence(); sv.render(); }, () => {});
    } catch (_) { runnerInstance = null; }
  }
  if (!runnerInstance) runnerInstance = mainThreadRunner("Background processing isn't available here, so the page can pause briefly while a photo is measured.");
  return runnerInstance;
}
const isStale = (err) => !!(err && (err.stale || err.cancelled));

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
  // What each side's photo can't show (from the scan's quality check, plus the surface: a flat photo can't
  // show scratches, dents or print lines). The photo check wins over a tick in `inspected`; only a check on
  // the card in hand (`inHand`) counts for those areas.
  photoLimits: { front: [], back: [] },
  inHand: { front: [], back: [] },
  // Photo-check spots the user marked "Not wear" (keys from flagKey), per side; reset when that side is rescanned.
  dismissed: { front: [], back: [] },
  evidence: { front: { lr: "unread", tb: "unread" }, back: { lr: "unread", tb: "unread" } },
  activeSide: "front",
  reference: null,  // {image_url|image, source, source_url, name, rgba, mask}: only set once the user confirms the card
  market: null,     // ungraded market prices TCGdex returned for the confirmed card (Pokemon only)
  tcgplayerId: "",  // TCGplayer product id Riftcodex returned for the confirmed card
  price: { key: "", status: "idle" },  // PriceCharting lookup for the current card: see loadPrices()
  web: { key: "", status: "idle" },    // Gemini web price search for the current card (on screen only, never stored)
  cs: { key: "", status: "idle" },     // CardSight sales for the current card (Pokemon): see loadCardSight()
  rb: { key: "", status: "idle" },     // TCGplayer prices for the current card (Riftbound): see loadRiftPrices()
  autoRead: false,  // the card has been read from the photo once already (automatic runs only)
  showSuspects: true,
  sheet: { side: null, location: null, type: null, severity: null },
  example: false,
  report: null,
  savedId: null,
  tab: "scan",      // scan | history | settings
  pane: null,       // detail screen open over Review (element id), or null
  // Revision tokens: every async result carries the card revision and, for one side, the photo revision it
  // was started for; a result whose token no longer matches is dropped (see isCurrent()).
  cardRev: 0,
  pendingRev: { front: "", back: "" },   // latest photo/outline requested per side (the scan in flight)
  conf: { front: null, back: null },     // scan confidence per side (ScanConfidence result)
  confAnnounced: { front: "", back: "" },
  marks: { front: null, back: null },    // transient mark-finding results per side: never saved
  angled: { front: null, back: null },   // transient angled-light photos per side (view only): never saved
  lookup: { status: "idle", text: "" },  // card identification status for the Card details row
};

let revCounter = 0;
const newRev = () => `${Date.now().toString(36)}.${(++revCounter).toString(36)}`;
const cardToken = () => ({ card: state.cardRev });
const sideToken = (side) => ({ card: state.cardRev, side, rev: state.scans[side] ? state.scans[side].rev : "" });
function isCurrent(t) {
  if (!t || t.card !== state.cardRev) return false;
  if (t.pending) return state.pendingRev[t.side] === t.pending;
  if (t.side) return !!state.scans[t.side] && state.scans[t.side].rev === t.rev;
  return true;
}

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

// User-facing wording: what older text calls a "DING" is a defect. Stored data keeps its names.
const uiText = (s) => String(s == null ? "" : s).replace(/\bDING([Ss])?\b/g, (m, plural) => (plural ? "defects" : "defect"));

function toast(msg) {
  const t = $("#toast");
  t.textContent = uiText(msg);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

function announce(msg) {
  const live = $("#live");
  live.textContent = "";
  setTimeout(() => { live.textContent = msg; }, 30);
}

const svgIcon = (name, cls = "ic") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ---------------------------------------------------------------- storage */

// Drafts v3 add the inspection record (inspected, centering_evidence). A v2 draft still resumes, but under
// the current rules its uninspected areas leave the grade incomplete.
const KEYS = { cards: "cardGradingLab.cards.v1", draft: "cardGradingLab.draft.v3", draftV2: "cardGradingLab.draft.v2", game: "cardGradingLab.game", theme: "cardGradingLab.theme" };

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

/** Store a finished scan for one side. `out` is the scan job's result: {scan, quality, check}. */
function applyScanResult(side, out, photo, { rev, outlineAdjusted = false } = {}) {
  const scan = out.scan;
  const img = canvasFromRGBA(scan.warped);
  const unmeasured = neutralizeUnreadSides(scan);
  state.scans[side] = {
    img, lines: scan.lines, width: scan.width, height: scan.height, margin: scan.margin,
    confidence: scan.confidence.borders,
    photo, corners: scan.corners,  // kept for this session so the outline can be adjusted by hand
    result: scan, quality: out.quality || null, check: out.check || null,  // full scan, photo-quality gate, edge/corner candidates
    rev: rev || newRev(), outlineAdjusted,
  };
  state.pendingRev[side] = state.scans[side].rev;
  state.evidence[side] = { lr: unmeasured.lr ? "unread" : "measured", tb: unmeasured.tb ? "unread" : "measured" };
  // Whatever its quality, a flat photo can't show the surface; the quality check adds what else it can't show.
  state.photoLimits[side] = out.quality ? Grading.photoLimitComponents([...out.quality.blocked, ...FLAT_PHOTO_LIMITS]) : [...FLAT_PHOTO_LIMITS];
  state.dismissed[side] = [];
  state.thumbs[side] = thumbnail(img, scan.margin);
  state.centering[side] = centeringFromLines(scan.lines);
  // Mark candidates belong to the photo they were found in; an angled-light photo to the card it showed.
  state.marks[side] = null;
  if (!outlineAdjusted) state.angled[side] = null;
  // Defects marked at a spot on an earlier photo: the spot may have moved. Never dropped: the user re-checks.
  for (const d of state.defects) if (d.side === side && d.region && d.scan_revision !== state.scans[side].rev) d.recheck = true;
  assessConfidence(side);
  sv.invalidate(side);
}

function assessConfidence(side) {
  const s = state.scans[side];
  if (!s || !s.result) { state.conf[side] = s ? null : Confidence().notScanned(); return; }
  const angledLight = !!(state.angled[side] && state.angled[side].result);   // an angled-light photo was added
  const input = { scan: s.result, quality: s.quality, check: s.check, evidence: state.evidence[side], outlineAdjusted: !!s.outlineAdjusted, angledLight };
  try {
    state.conf[side] = Confidence().assess(input);
  } catch (_) {
    state.conf[side] = { level: "cannot_assess", label: CONF_LABEL.cannot_assess, areas: null, surfaceLimited: true, summary: "This scan couldn't be rated. Retake the photo.", reasons: [], actions: [{ id: "retake", label: "Retake photo" }] };
  }
}

// Front only: a confirmed, readable reference marks the card's printed white so it isn't taken for whitening.
// (Also run with force after the reference is removed, to drop the mask again.)
function refineWithReference(side, { force = false } = {}) {
  const s = state.scans[side];
  if (side !== "front" || !s || !s.photo || !s.result || !s.quality) return;
  const usable = !!(state.reference && state.reference.rgba && state.reference.usable);
  if (!usable && !force) return;
  const token = sideToken(side), ref = state.reference;
  setTimeout(() => {
    if (!isCurrent(token) || state.reference !== ref) return;
    try {
      const opts = { quality: s.quality, face: side };
      if (usable) opts.printedMask = Identify.printedMask(ref.rgba, s.result.warped, s.margin);
      s.check = Inspect.edgesAndCorners(s.result, opts);
    } catch (_) { /* keep the previous check */ }
    renderScanCheck();
    viewer.render();
    if (state.view === "report") runGrade();
  }, 20);
}

// The scan job takes ownership of the pixel buffer (it moves to the worker and comes back as result.pixels).
// keep: send a copy instead, when this photo must stay usable here even if the job is dropped (outline edits).
const scanPayload = (pixels, side, corners = null, { keep = false } = {}) => ({
  pixels: keep ? { width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(pixels.data) } : pixels,
  mode: "auto", corners, face: side,
});

function setSideBusy(side, on) {
  const slot = $(`.slot[data-side="${side}"]`);
  if (slot) {
    slot.classList.toggle("busy", on);
    $(".slot-busy", slot).textContent = on ? "Measuring…" : "";
  }
  if (state.activeSide === side) $("#guide-wrap").classList.toggle("busy", on);
}

function scanToasts(side) {
  const ev = state.evidence[side];
  const um = { lr: ev.lr === "unread", tb: ev.tb === "unread" };
  const q = state.scans[side].quality;
  const failed = q && q.verdict === "rescan" ? Object.values(q.checks).find((c) => c.status === "fail") : null;
  if (failed) toast(`${cap(side)}: this photo can't support a reliable check. ${failed.note}`);
  else if (um.lr || um.tb) toast(`${cap(side)}: couldn't read the ${um.lr && um.tb ? "border" : um.lr ? "left/right border" : "top/bottom border"} (full-art card or glare). In Centering, line up the pink guides with the printed frame.`);
  else if (state.scans[side].confidence < 0.6) toast(`${cap(side)}: the border was hard to read. Check the guide lines in Centering.`);
}

function announceConfidence(side) {
  const s = state.scans[side], c = state.conf[side];
  if (!s || !c || c.level === "assessing" || state.confAnnounced[side] === s.rev) return;
  state.confAnnounced[side] = s.rev;
  announce(`${cap(side)} scanned. Scan confidence: ${CONF_LABEL[c.level] || c.label}.${c.surfaceLimited ? " Limited: surface needs inspection." : ""}`);
}

/** Run a scan job for one side and apply it if it is still the latest request for that card and side. */
async function runScan(side, pixels, { corners = null, outlineAdjusted = false, keep = false } = {}) {
  const pending = newRev();
  state.pendingRev[side] = pending;
  const token = { card: state.cardRev, side, pending };
  setSideBusy(side, true);
  state.conf[side] = Confidence().assessing();
  state.marks[side] = null;   // candidates from the old photo no longer apply
  sv.invalidate(side);
  renderConfidence();
  let ok = false;
  try {
    // A newer photo for this side replaces a scan still running (supersede), not just one still waiting.
    const out = await runner().run("scan", scanPayload(pixels, side, corners, { keep }), { coalesceKey: `scan-${side}`, supersede: true });
    if (!isCurrent(token)) return false;
    // Keep the pixels the job handed back: the buffer sent with it may have been moved to the worker.
    applyScanResult(side, out, out.pixels || pixels, { rev: pending, outlineAdjusted });
    refineWithReference(side);
    ok = true;
    return true;
  } catch (err) {
    if (isStale(err) || !isCurrent(token)) return false;
    toast((err && err.timeout ? "Measuring this photo took too long. Try again, or try another photo." : err && err.message) || "Couldn't measure this photo.");
    return false;
  } finally {
    if (isCurrent(token)) {
      // This was the latest request for the side: it's finished either way.
      if (!ok) { state.pendingRev[side] = state.scans[side] ? state.scans[side].rev : ""; assessConfidence(side); }
      setSideBusy(side, false);
      renderConfidence();
    }
  }
}

async function scanFile(side, file) {
  leaveExample();
  const card = state.cardRev;
  setSideBusy(side, true);
  let pixels;
  try {
    pixels = await readImage(file);
  } catch (err) {
    if (card === state.cardRev) { setSideBusy(side, false); toast(err.message || "Couldn't open this photo."); }
    return;
  }
  if (card !== state.cardRev) return;
  const ok = await runScan(side, pixels);
  renderSlots();
  if (!ok) return;
  scanToasts(side);
  announceConfidence(side);
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
    const done = !!thumb;
    slot.classList.toggle("done", done);
    img.hidden = !done;
    if (done) img.src = thumb;
    $(".slot-meta", slot).textContent = done
      ? `${splitText(state.centering[side].lr)} · ${splitText(state.centering[side].tb)}`
      : "No photo";
  }
  const front = !!state.thumbs.front, back = !!state.thumbs.back;
  const busy = SIDES.some((s) => state.conf[s] && state.conf[s].level === "assessing");
  $("#review-card").disabled = !(front && back) || busy;
  $("#front-only").hidden = !(front && !back) || busy;
  $("#clear-card").hidden = !(front || back);
  renderConfidence();
}

/* ---------------------------------------------------------------- scan confidence */

function confState(side) {
  if (state.conf[side]) return state.conf[side];
  return state.scans[side] ? Confidence().assessing() : Confidence().notScanned();
}

const confWhyOpen = { front: false, back: false };

/** One side's confidence: segmented bar + label, the summary, an action, and "Why this rating?". */
function confidenceRow(side, { detail = true, compact = false } = {}) {
  const c = confState(side);
  const row = document.createElement("div");
  row.className = "conf-row";
  row.dataset.side = side;
  row.dataset.level = c.level;
  const label = CONF_LABEL[c.level] || c.label;
  row.innerHTML = `<div class="conf-head"><span class="conf-side"></span><span class="cbar" data-level="${c.level}" aria-hidden="true"><i></i><i></i><i></i></span><span class="conf-label" data-level="${c.level}"></span></div>`;
  $(".conf-side", row).textContent = cap(side);
  $(".conf-label", row).textContent = label;
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", `${cap(side)} scan confidence`);
  if (c.surfaceLimited && c.level !== "assessing" && c.level !== "not_scanned") {
    const lim = document.createElement("span");
    lim.className = "conf-limited";
    lim.innerHTML = `${svgIcon("warn")}<span>Limited — surface needs inspection</span>`;
    $(".conf-head", row).append(lim);
  }
  if (!detail) return row;
  // The badge above already says the surface needs inspection: don't repeat it in the sentence.
  const summary = c.surfaceLimited ? String(c.summary || "").replace(/\s*[;,—-]?\s*limited\s*[—-]\s*surface needs inspection\.?/i, ".").replace(/\.\.$/, ".") : c.summary;
  if (summary && summary !== ".") {
    const p = document.createElement("p");
    p.className = "conf-summary";
    p.textContent = summary;
    row.append(p);
  }
  // On the Scan screen only the actions that fix a weak scan are offered; Review offers all of them.
  const actions = (c.actions || []).filter((a) => ["retake", "adjust_outline", "angled_light"].includes(a.id) && (!compact || a.id !== "angled_light"));
  if (actions.length && c.level !== "assessing" && c.level !== "not_scanned") {
    const box = document.createElement("div");
    box.className = "conf-actions";
    for (const a of actions.slice(0, 2)) {
      if (a.id === "adjust_outline" && !(state.scans[side] && state.scans[side].photo)) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn tinted";
      b.dataset.confAction = a.id;
      b.dataset.side = side;
      b.textContent = a.label || { retake: "Retake photo", adjust_outline: "Adjust outline", angled_light: "Add angled-light photo" }[a.id];
      box.append(b);
    }
    if (box.children.length) row.append(box);
  }
  if (c.areas) {
    const det = document.createElement("details");
    det.className = "conf-why";
    det.open = !!confWhyOpen[side];
    det.addEventListener("toggle", () => { confWhyOpen[side] = det.open; });
    det.innerHTML = "<summary>Why this rating?</summary><dl></dl>";
    const dl = $("dl", det);
    for (const [key, name] of CONF_AREAS) {
      const a = c.areas[key];
      if (!a) continue;
      const dt = document.createElement("dt");
      dt.textContent = name;
      const dd = document.createElement("dd");
      const b = document.createElement("b");
      b.textContent = CONF_LABEL[a.level] || a.level;
      dd.append(b, ` · ${a.reason || ""}`);
      dl.append(dt, dd);
    }
    row.append(det);
  }
  return row;
}

function renderConfidence() {
  const scanBox = $("#scan-conf");
  scanBox.innerHTML = "";
  if (SIDES.some((s) => state.thumbs[s] || (state.conf[s] && state.conf[s].level === "assessing"))) {
    for (const side of SIDES) scanBox.append(confidenceRow(side, { compact: true }));
  }
  scanBox.previousElementSibling.hidden = !scanBox.children.length;
  const rv = $("#review-conf");
  rv.innerHTML = "";
  if (state.view === "report") {
    const other = state.activeSide === "front" ? "back" : "front";
    rv.append(confidenceRow(state.activeSide), confidenceRow(other, { detail: false }));
  }
  const r = runnerInstance;
  const note = $("#runner-note");
  note.hidden = !(r && r.mode === "main-thread" && SIDES.some((s) => state.scans[s]));
  note.textContent = r ? r.unavailableReason || "Scans run on the main thread here, so the page can pause briefly." : "";
}

function confAction(id, side) {
  if (id === "retake") { $(`#file-${side}`).click(); return; }
  if (id === "adjust_outline") {
    state.activeSide = side;
    if (state.view !== "report") setView("report");
    pushPane("pane-centering");
    if (state.scans[side] && state.scans[side].photo) setOutlineMode(true);
    return;
  }
  if (id === "angled_light") { state.activeSide = side; $("#angled-file").click(); }
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
  leaveExample();
  setOutlineMode(false);
  const card = state.cardRev;
  const ok = await runScan(side, s.photo, { corners, outlineAdjusted: true, keep: true });
  if (card !== state.cardRev) return;
  renderSlots();
  if (ok) {
    toast("Outline applied. The card was re-flattened and re-graded.");
    announceConfidence(side);
  }
  renderCentering();
  runGrade();
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
    : s.confidence >= 0.8 ? "Measured from the photo. The borders read clearly."
    : s.confidence >= 0.6 ? "Measured from the photo. Check the guide lines."
    : "The borders were hard to read: check the guide lines.";
  conf.classList.toggle("low", !!um || (!!s && s.confidence < 0.6));
}

function renderCentering() {
  const s = state.scans[state.activeSide];
  $("#adjust-outline").hidden = !(s && s.photo);
  $$(".side-seg button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.side === state.activeSide)));
  $("#guide-wrap").classList.toggle("busy", !!(state.conf[state.activeSide] && state.conf[state.activeSide].level === "assessing"));
  viewer.render();
  guide.show();
  renderRatioInputs();
  renderScanCheck();
  renderSurfacePane();
  renderConfidence();
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

function openSheet(side, location, opts = {}) {
  const comp = COMPONENT_OF[location];
  state.sheet = { side, location, type: null, severity: null, mark: opts.mark || null };
  $("#sheet-where").textContent = cap(whereText({ side, location }));
  const ev = $("#sheet-evidence");
  ev.hidden = !opts.mark;
  if (opts.mark) ev.textContent = `From a possible mark: ${opts.mark.reason || "found in the photo"}. Choose what it is and how bad it is: the detection confidence is not a severity.`;
  const chips = $("#type-chips");
  chips.innerHTML = "";
  const suggested = (opts.mark && opts.mark.suggestedTypes) || [];
  const types = Object.entries(CRITERIA.defects.types).filter(([, spec]) => spec.applies_to.includes(comp));
  types.sort(([a], [b]) => (suggested.includes(a) ? suggested.indexOf(a) : 99) - (suggested.includes(b) ? suggested.indexOf(b) : 99));
  for (const [key, spec] of types) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.type = key;
    b.textContent = spec.label;
    if (suggested.includes(key)) {
      const s = document.createElement("span");
      s.className = "sugg";
      s.textContent = "Suggested";
      b.append(s);
    }
    b.addEventListener("click", () => { state.sheet.type = key; updateSheet(); });
    chips.append(b);
  }
  $("#defect-note").value = "";
  updateSheet();
  openDialog("#defect-sheet", opts.opener || document.activeElement);
}

function closeSheet() {
  closeDialog("#defect-sheet");
}

function updateSheet() {
  const { type, severity } = state.sheet;
  $$("#type-chips button").forEach((b) => { b.classList.toggle("active", b.dataset.type === type); b.setAttribute("aria-pressed", String(b.dataset.type === type)); });
  $$("#sev-seg button").forEach((b) => { b.classList.toggle("active", b.dataset.sev === severity); b.setAttribute("aria-pressed", String(b.dataset.sev === severity)); });
  $("#sheet-add").disabled = !(type && severity);
  if (severity) {
    const capValue = type ? CRITERIA.defects.types[type].caps[severity] : null;
    const effect = capValue == null ? "" : capValue >= 10 ? " · still allows Gem Mint" : ` · limits this area to ${capValue}`;
    $("#sev-hint").textContent = SEV_TEXT[severity] + effect;
  }
}

function addDefectFromSheet() {
  leaveExample();
  const { side, location, type, severity, mark } = state.sheet;
  if (!(type && severity)) return;
  const note = $("#defect-note").value.trim();
  const d = { side, location, type, severity, note: note || null };
  if (mark) {
    // A possible mark the user confirmed: where it is on the card (normalized), on which photo, and why.
    d.confirmed = true;
    d.region = { x: mark.x, y: mark.y, w: mark.w, h: mark.h };
    d.scan_revision = mark.revision || (state.scans[side] && state.scans[side].rev) || "";
    d.method = mark.method || "marks";
    d.evidence = String(mark.reason || "").slice(0, 200);
    sv.setMarkStatus(side, mark.id, "added");
  }
  state.defects.push(d);
  markInspected(side, COMPONENT_OF[location]);  // logging a defect there means you looked there
  closeSheet();
  runGrade();
  if (mark) sv.render();
}

function removeDefect(d) {
  leaveExample();
  const i = state.defects.indexOf(d);
  if (i >= 0) state.defects.splice(i, 1);
  runGrade();
}

function keepDefect(d) {
  leaveExample();
  delete d.recheck;
  if (state.scans[d.side]) d.scan_revision = state.scans[d.side].rev;
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

function defectItem(d, i, areas) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="ding-no ${d.severity}" aria-hidden="true">${i + 1}</span>
    <span class="d-text"><span class="d-label"></span><br><span class="where"></span></span>
    <span class="d-impact"></span>
    <button type="button" class="icon-btn remove">${svgIcon("trash")}</button>`;
  $(".d-label", li).textContent = CRITERIA.defects.types[d.type].label;
  $(".where", li).textContent = uiText(`${cap(d.severity)} · ${whereText(d)}${d.note ? ` · ${d.note}` : ""}`);
  const area = `${d.side} ${COMPONENT_OF[d.location]}`;
  if (areas && areas[area] != null) $(".d-impact", li).textContent = `${cap(area)} ${areas[area]}`;
  const rm = $(".remove", li);
  rm.setAttribute("aria-label", `Remove defect ${i + 1}: ${CRITERIA.defects.types[d.type].label}, ${whereText(d)}`);
  rm.addEventListener("click", () => removeDefect(d));
  if (d.recheck) {
    const box = document.createElement("span");
    box.className = "recheck";
    box.innerHTML = `${svgIcon("warn", "ic small")} Re-check this defect: the photo changed since it was marked.<span class="recheck-btns"><button type="button" class="btn plain inline">Still there</button><button type="button" class="btn plain inline danger-text">Remove</button></span>`;
    const [keep, drop] = $$("button", box);
    keep.addEventListener("click", () => keepDefect(d));
    drop.addEventListener("click", () => removeDefect(d));
    $(".d-text", li).append(box);
  }
  return li;
}

function renderDefects() {
  const list = $("#defect-list");
  list.innerHTML = "";
  if (!state.defects.length) {
    list.innerHTML = '<li class="empty">No defects logged. Areas ticked as checked count as flawless; unchecked areas leave the grade incomplete.</li>';
  }
  const areas = state.report && state.report.grades.TAG.subgrades;
  state.defects.forEach((d, i) => list.append(defectItem(d, i, areas)));
  const surf = $("#surface-defects");
  surf.innerHTML = "";
  state.defects.forEach((d, i) => { if (d.location === "surface") surf.append(defectItem(d, i, areas)); });
  if (!surf.children.length) surf.innerHTML = '<li class="empty">No surface defects logged.</li>';
  const n = state.defects.length;
  const recheck = state.defects.filter((d) => d.recheck).length;
  const checked = SIDES.reduce((k, side) => k + COMPONENTS.filter((c) => isInspected(side, c)).length, 0);
  $("#defect-summary").textContent = recheck ? `${recheck} to re-check` : `${n ? `${n} logged` : "None"} · ${checked}/6 checked`;
  paintZones();
  renderInspect();
}

/* ---------------------------------------------------------------- inspection checklist */

// Same rules as the engine: a component with a defect logged on that side has been looked at, unless the
// photo can't show it; then only a check on the card in hand counts.
const hasDefect = (side, comp) => state.defects.some((d) => d.side === side && COMPONENT_OF[d.location] === comp);
const photoLimited = (side, comp) => state.photoLimits[side].includes(comp);
const isInspected = (side, comp) =>
  state.inHand[side].includes(comp) || (!photoLimited(side, comp) && (state.inspected[side].includes(comp) || hasDefect(side, comp)));

function markInspected(side, comp) {
  if (!state.inspected[side].includes(comp)) state.inspected[side] = COMPONENTS.filter((c) => c === comp || state.inspected[side].includes(c));
}

function setInspected(side, comp, on) {
  leaveExample();
  if (photoLimited(side, comp)) {
    // The photo can't show this area, so ticking it means "checked on the card in hand".
    state.inHand[side] = on ? COMPONENTS.filter((c) => c === comp || state.inHand[side].includes(c)) : state.inHand[side].filter((c) => c !== comp);
  } else if (on) markInspected(side, comp);
  else state.inspected[side] = state.inspected[side].filter((c) => c !== comp);
  runGrade();
}

function checkRow(side, comp, row = null) {
  const limited = photoLimited(side, comp);
  const locked = !limited && hasDefect(side, comp);  // can't be unchecked while a defect is logged there
  if (!row) {
    row = document.createElement("label");
    row.innerHTML = '<span class="row-main"><span class="row-title"></span><span class="row-sub"></span></span><input type="checkbox">';
  }
  row.className = "row check-row" + (locked ? " locked" : "") + (limited ? " limited" : "");
  const box = $("input", row);
  box.dataset.side = side;
  box.dataset.comp = comp;
  box.checked = isInspected(side, comp);
  box.disabled = locked;
  $(".row-title", row).textContent = `${cap(side)} ${comp} ${limited ? "checked in hand" : "checked"}`;
  $(".row-sub", row).textContent = locked ? "A defect is logged here, so it counts as looked at."
    : !limited ? "Looked at under good light; anything found is logged."
    : comp === "surface" ? "A flat photo can't show scratches, print lines, dents, creases or gloss loss. Tilt the card under a light, log what you find, then tick."
    : "The photo can't show these. Check the card in hand under good light, then tick.";
  return row;
}

function renderInspect() {
  const fill = (sel, combos) => {
    // Update rows in place so a checkbox keeps keyboard focus after it's toggled.
    const box = $(sel);
    if (box.children.length !== combos.length) {
      box.innerHTML = "";
      for (const [side, comp] of combos) box.append(checkRow(side, comp));
    } else combos.forEach(([side, comp], i) => checkRow(side, comp, box.children[i]));
  };
  fill("#all-checks", SIDES.flatMap((s) => COMPONENTS.map((c) => [s, c])));
  fill("#edges-checks", SIDES.flatMap((s) => ["corners", "edges"].map((c) => [s, c])));
  fill("#surface-checks", SIDES.map((s) => [s, "surface"]));
  const all = SIDES.every((s) => COMPONENTS.every((c) => isInspected(s, c)));
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
      if (d.region) {  // a confirmed mark: drawn where it was found
        fx = d.region.x + d.region.w / 2;
        fy = d.region.y + d.region.h / 2;
      } else if (d.location === "surface" && k) {
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
// Whatever its quality, a flat photo can't show surface wear (scratches, print lines, dents, creases, gloss
// loss): that needs the card tilted under a light, so the surface only counts once checked in hand.
const FLAT_PHOTO_LIMITS = ["surface"];

const blockedText = (item) => {
  const [comp, where] = item.split(":");
  return where ? `${pretty(where)} ${comp === "corners" ? "corner" : "edge"}` : comp;
};

function scanCheckLine(text, cls = "") {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.textContent = uiText(text);
  return li;
}

// A photo-check spot, and whether the user has dealt with it: added as a defect (same side, place and type) or
// dismissed as "Not wear". Spots left open count as unconfirmed possible wear.
const flagKey = (d) => [d.side, d.location, d.type, d.severity].join("|");
const flagAdded = (d) => state.defects.some((x) => x.side === d.side && x.location === d.location && x.type === d.type);
function pendingFlags() {
  if (state.example) return [];
  const out = [];
  for (const side of SIDES) {
    const c = state.scans[side] && state.scans[side].check;
    if (!c) continue;
    for (const d of c.defects) {
      const f = { side: d.side || side, location: d.location, type: d.type, severity: d.severity };
      if (!flagAdded(f) && !state.dismissed[f.side].includes(flagKey(f))) out.push({ ...f, note: "Photo check, not confirmed", confirmed: false });
    }
  }
  return out;
}

// In-hand surface check, in order of how much each costs a grade (TAG's reports: a crease means a median grade
// of 2, a dent 4, play wear 5). Each maps to a defect type from defects.yaml.
const SURFACE_CHECKS = [
  ["crease", "Crease or wrinkle", "crease"],
  ["dent", "Dent or indentation", "indentation"],
  ["stain", "Stain or water damage", "stain"],
  ["playwear", "Play wear (scuffs, dull gloss)", "gloss_loss"],
  ["ink", "Ink or print spot", "print_spot"],
  ["scratch", "Scratches", "surface_scratch"],
  ["printline", "Print line", "print_line"],
];

function surfaceChecklist(side) {
  const wrap = document.createElement("div");
  wrap.className = "sc-surface";
  const done = state.inHand[side].includes("surface");
  wrap.innerHTML = `<h2 class="group-title"></h2><p class="footnote"></p><div class="group sc-surface-rows"></div><button type="button" class="btn filled wide"></button>`;
  $("h2", wrap).textContent = `Check in hand · ${side}`;
  $("p", wrap).textContent = done
    ? `The ${side} surface is checked in hand. Saving again adds anything else you found.`
    : "Tilt the card under a light and look for each of these, worst first. Choose how bad anything you find is; leave the rest as “Not seen”.";
  const rows = $(".sc-surface-rows", wrap);
  for (const [id, label] of SURFACE_CHECKS) {
    const row = document.createElement("label");
    row.className = "row sc-surface-row";
    row.setAttribute("for", `surf-${side}-${id}`);
    row.innerHTML = `<span></span><select id="surf-${side}-${id}"><option value="">Not seen</option><option value="micro">Tiny</option><option value="minor">Minor</option><option value="moderate">Obvious</option><option value="major">Heavy</option></select>`;
    $("span", row).textContent = label;
    rows.append(row);
  }
  const btn = $("button", wrap);
  btn.textContent = done ? `Save ${side} surface check again` : `Save ${side} surface check`;
  btn.addEventListener("click", () => {
    leaveExample();
    for (const [id, label, type] of SURFACE_CHECKS) {
      const sev = $(`#surf-${side}-${id}`, wrap).value;
      if (sev) state.defects.push({ side, location: "surface", type, severity: sev, note: `In-hand surface check: ${label.toLowerCase()}` });
    }
    // Checked in hand: the surface counts as assessed for this side, with whatever was logged.
    if (!state.inHand[side].includes("surface")) state.inHand[side] = COMPONENTS.filter((c) => c === "surface" || state.inHand[side].includes(c));
    runGrade();
    toast(`${cap(side)} surface checked in hand.`);
  });
  return wrap;
}

function renderSurfacePane() {
  const side = state.activeSide;
  const box = $("#surface-check");
  // Keep anything already chosen in the in-hand checklist when it's redrawn.
  const kept = Object.fromEntries($$("select", box).map((s) => [s.id, s.value]));
  box.innerHTML = "";
  box.append(surfaceChecklist(side));
  for (const s of $$("select", box)) if (kept[s.id]) s.value = kept[s.id];
  const parts = SIDES.map((s) => (state.inHand[s].includes("surface") ? `${cap(s)} checked` : null)).filter(Boolean);
  $("#surface-summary").textContent = parts.length === 2 ? "Checked in hand" : parts.length ? parts[0] : "Check in hand";
  const m = state.marks[side];
  const open = m && m.candidates ? m.candidates.filter((c) => c.status === "pending").length : 0;
  $("#marks-summary").textContent = !m ? "Zoom, filter and find possible marks in your photo."
    : m.status === "running" ? "Looking for possible marks…"
    : m.candidates && m.candidates.length ? `${m.candidates.length} possible mark${m.candidates.length === 1 ? "" : "s"} · ${open} to review`
    : "No visible marks found in this photo.";
  const a = state.angled[side];
  $("#angled-status").textContent = a ? (a.status === "busy" ? "Measuring the angled-light photo…" : `Added for the ${side}. Switch to it in Inspect surface.`) : "Optional. Helps you spot marks; it doesn't change centering or grades.";
}

function renderScanCheck() {
  const body = $("#scancheck-body");
  const parts = SIDES.map((side) => {
    const q = state.scans[side] && state.scans[side].quality;
    if (!q) return null;
    const open = (state.scans[side].check ? state.scans[side].check.defects : []).filter((d) => { const f = { ...d, side: d.side || side }; return !flagAdded(f) && !state.dismissed[f.side].includes(flagKey(f)); }).length;
    return open ? `${open} to review` : null;
  }).filter(Boolean);
  const checked = SIDES.reduce((k, s) => k + ["corners", "edges"].filter((c) => isInspected(s, c)).length, 0);
  $("#scancheck-summary").textContent = parts.length ? parts.join(" · ") : `${checked}/4 checked`;
  body.innerHTML = "";
  const side = state.activeSide, s = state.scans[side];
  const group = document.createElement("div");
  group.className = "group pad";
  body.append(group);
  if (!s || !s.photo) {
    const p = document.createElement("p");
    p.className = "footnote tight";
    p.textContent = s ? "The photo isn't kept after you reload the page, so it can't be checked again. Rescan it to check the photo." : `No ${side} photo, so nothing can be checked here. Photos of both sides are needed for a full assessment.`;
    group.append(p);
    return;
  }
  const q = s.quality, c = s.check;
  if (!q || !c) {
    const p = document.createElement("p");
    p.className = "footnote tight";
    p.textContent = state.conf[side] && state.conf[side].level === "assessing" ? "Assessing scan…" : "The checks couldn't run on this photo. Try scanning it again.";
    group.append(p);
    return;
  }
  const head = document.createElement("div");
  head.className = "sc-verdict";
  head.innerHTML = `<span class="chip ${q.verdict}"></span>`;
  $(".chip", head).innerHTML = `${svgIcon(q.verdict === "ok" ? "check" : "warn", "ic small")}<span></span>`;
  $(".chip span", head).textContent = QUALITY_TEXT[q.verdict];
  group.append(head);

  const problems = Object.entries(q.checks).filter(([, v]) => v.status !== "ok");
  const ul = document.createElement("ul");
  ul.className = "sc-list";
  if (problems.length) for (const [, v] of problems) ul.append(scanCheckLine(v.note, v.status));
  else ul.append(scanCheckLine("Sharpness, glare, resolution and framing look fine."));
  if (q.blocked.length) ul.append(scanCheckLine(`This photo can't show: ${q.blocked.map(blockedText).join(", ")}. Rescan with better light, or check those by eye and log them in Defects.`, "warn"));
  group.append(ul);

  const toggle = document.createElement("label");
  toggle.className = "sc-toggle";
  toggle.innerHTML = '<input type="checkbox"><span>Show suspected damage on the card</span>';
  const box = $("input", toggle);
  box.checked = state.showSuspects;
  box.addEventListener("change", () => { state.showSuspects = box.checked; viewer.render(); });
  group.append(toggle);

  const title = document.createElement("h2");
  title.className = "group-title";
  title.textContent = "Edges and corners";
  body.append(title);
  const sum = document.createElement("p");
  sum.className = "footnote";
  sum.textContent = uiText(c.summary);
  body.append(sum);

  const open = c.defects.filter((d) => { const f = { ...d, side: d.side || side }; return !flagAdded(f) && !state.dismissed[f.side].includes(flagKey(f)); });
  if (open.length) {
    const why = document.createElement("p");
    why.className = "footnote";
    why.textContent = "Until you check these by eye, each counts as possible wear: that area's best case stays at 9 at most. Add the real ones to Defects and mark the rest “Not wear”.";
    body.append(why);
  }
  const cands = document.createElement("div");
  cands.className = "group";
  for (const d of open) {
    const row = document.createElement("div");
    row.className = "sc-cand";
    const label = CRITERIA.defects.types[d.type] ? CRITERIA.defects.types[d.type].label : pretty(d.type);
    row.innerHTML = "<div><b></b><small></small></div><span class=\"sc-cand-btns\"><button type=\"button\" class=\"btn tinted\">Add to Defects</button><button type=\"button\" class=\"btn tinted\">Not wear</button></span>";
    $("b", row).textContent = `${label} · ${cap(d.severity)} · ${whereText(d)}`;
    $("small", row).textContent = uiText(d.note || "");
    const [add, notWear] = $$("button", row);
    add.setAttribute("aria-label", `Add ${label}, ${whereText(d)} to Defects`);
    notWear.setAttribute("aria-label", `${label}, ${whereText(d)}: not wear`);
    add.addEventListener("click", () => {
      leaveExample();
      state.defects.push({ side: d.side || side, location: d.location, type: d.type, severity: d.severity, note: `Auto-detected: ${d.note || label}`.slice(0, 200) });
      markInspected(d.side || side, COMPONENT_OF[d.location]);
      runGrade();
    });
    notWear.addEventListener("click", () => {
      leaveExample();
      state.dismissed[d.side || side].push(flagKey({ ...d, side: d.side || side }));
      runGrade();
    });
    cands.append(row);
  }
  if (cands.children.length) body.append(cands);
  if (state.dismissed[side].length) {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "btn plain";
    undo.textContent = `Show the ${state.dismissed[side].length} spot${state.dismissed[side].length > 1 ? "s" : ""} marked “Not wear” again`;
    undo.addEventListener("click", () => { state.dismissed[side] = []; runGrade(); });
    body.append(undo);
  }
  const det = document.createElement("details");
  det.className = "group row-details";
  det.innerHTML = `<summary class="row row-btn"><span class="row-main"><span class="row-title">What this can't tell you</span></span>${svgIcon("chevron", "ic chev")}</summary><ul class="sc-limits"></ul>`;
  for (const l of c.limitations) { const li = document.createElement("li"); li.textContent = uiText(l); $("ul", det).append(li); }
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
  if (had && state.scans.front) refineWithReference("front", { force: true });
  if (had) sv.render();
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
  const token = cardToken();
  state.reference = ref;
  showReference();
  await prepareReference(ref);
  if (state.reference !== ref || !isCurrent(token)) return;  // replaced meanwhile, or another card now
  showReference();
  refineWithReference("front");
  sv.render();
}

/** Identification status: the full text in the details sheet, a short state on the Card details row. */
function setStatus(text, short = "") {
  $("#id-status").textContent = text;
  state.lookup = { status: short ? "busy" : "idle", text: short };
  $("#id-row-status").textContent = short;
}

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
  state.market = c.market || null;
  state.tcgplayerId = c.tcgplayer_id || "";
  loadPrices({ force: true });
  loadCardSight({ force: true });
  loadRiftPrices();
}

function idNote(box, text, cls = "") {
  const p = document.createElement("p");
  p.className = `id-note ${cls}`.trim();
  p.textContent = text;
  box.append(p);
}

function renderManualReference(box) {
  const wrap = document.createElement("div");
  wrap.className = "id-manual";
  wrap.innerHTML = '<label>Use your own reference image (link or file)<input type="url" placeholder="https://… image link" autocomplete="off"></label><input type="file" accept="image/png,image/jpeg,image/webp"><button type="button" class="btn tinted">Use this reference</button>';
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

function renderCandidates(res, reading = null) {
  const box = $("#id-results");
  box.innerHTML = "";
  box.hidden = false;
  if (reading) idNote(box, `Read from your photo${reading.source === "gemini" ? " by Gemini" : ""}: ${[reading.name && `"${reading.name}"`, reading.number, reading.set_code, reading.set_name].filter(Boolean).join(" · ")}. ${reading.source === "gemini" ? "AI reading" : "Text recognition"} can misread a letter or digit, so compare the pictures before you pick.`);
  if (res.timedOut) {
    idNote(box, `The lookup timed out after ${LOOKUP_DEADLINE_MS / 1000} seconds. Check the connection and try again, or fill in the details by hand.`, "warn");
    renderManualReference(box);
    setStatus("Lookup timed out.", "Timed out");
    return;
  }
  if (res.offline) {
    idNote(box, "You're offline. Card lookup needs a connection; you can fill in the details by hand, or supply a reference image file.", "warn");
    renderManualReference(box);
    setStatus("Offline: card lookup needs a connection.", "Offline");
    return;
  }
  if (res.error || !res.candidates.length) {
    idNote(box, res.error || "No matching card found.");
    idNote(box, "Nothing is being used as a reference. You can fill in the details by hand, or supply a reference image yourself.");
    renderManualReference(box);
    setStatus("Not identified.", "Not identified");
    return;
  }
  setStatus(res.needs_confirmation ? "Several cards could match. Pick yours, or none." : "Check this is your exact card, including the variant.", res.candidates.length > 1 ? `${Math.min(6, res.candidates.length)} possible matches` : "Confirm the match");
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
    const strength = c.confidence >= 0.8 ? "Strong match" : c.confidence >= 0.5 ? "Possible match" : "Weak match";
    ev.textContent = ` ${strength}: ${(c.evidence || []).join("; ")}`;
    info.append(b, line, document.createElement("br"), ev);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn tinted";
    btn.textContent = "This is my card";
    btn.setAttribute("aria-label", `This is my card: ${c.name}${line.textContent ? `, ${line.textContent}` : ""}`);
    btn.addEventListener("click", () => confirmCandidate(c));
    row.append(img, info, btn);
    box.append(row);
  }
  renderManualReference(box);
}

/* ---------------------------------------------------------------- card lookup: de-duplicated, with a deadline */

const LOOKUP_DEADLINE_MS = 30000;
const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const lookupKey = (q) => JSON.stringify(["game", "set_code", "number", "name", "language"].map((k) => String((q && q[k]) || "").trim().toLowerCase()));

/**
 * One identification attempt ("read"): the same query is looked up once, the same request is sent once
 * (Identify's own fallbacks repeat broader requests), and everything stops at one overall deadline.
 */
function lookupSession({ deadlineMs = LOOKUP_DEADLINE_MS, fetchImpl = (...a) => window.fetch(...a) } = {}) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const requests = new Map(), queries = new Map();
  let timedOut = false, timer = null;
  const expired = new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; if (ctrl) ctrl.abort(); resolve({ timedOut: true }); }, deadlineMs); });
  const fetchOnce = (url, init = {}) => {
    if (timedOut) return Promise.reject(new Error("The lookup timed out."));
    const key = `${(init && init.method) || "GET"} ${url} ${(init && typeof init.body === "string" && init.body) || ""}`;
    if (!requests.has(key)) requests.set(key, fetchImpl(url, ctrl ? { ...init, signal: ctrl.signal } : init));
    return requests.get(key).then((r) => (r && typeof r.clone === "function" ? r.clone() : r));
  };
  return {
    get timedOut() { return timedOut; },
    requests,
    candidates(q) {
      const key = lookupKey(q);
      if (!queries.has(key)) {
        const p = Identify.candidates(q, { fetch: fetchOnce }).catch(() => ({ candidates: [], error: "The lookup failed (offline, or this page can't reach the card database)." }));
        queries.set(key, Promise.race([p, expired]));
      }
      return queries.get(key);
    },
    /** Try each query in turn (skipping repeats) until one finds candidates; stops at the deadline. */
    async firstMatch(list) {
      let res = { candidates: [] };
      const seen = new Set();
      for (const q of list) {
        const key = lookupKey(q);
        if (seen.has(key)) continue;
        seen.add(key);
        res = await this.candidates(q);
        if (res.timedOut || timedOut) return { candidates: [], timedOut: true };
        if (res.candidates && res.candidates.length) break;
      }
      return res;
    },
    close() { clearTimeout(timer); },
  };
}

async function findCard() {
  const btn = $("#find-card");
  const c = assessment().card;
  if (!c.set_code && !c.number && !c.name) { setStatus("Enter a set code and number (or a name) first."); return; }
  const token = cardToken();
  if (offline()) { renderCandidates({ candidates: [], offline: true }); return; }
  btn.disabled = true;
  setStatus("Looking it up…", "Looking it up…");
  const session = lookupSession();
  let res;
  try {
    res = await session.firstMatch([{ game: state.game, set_code: c.set_code, number: c.number, name: c.name, language: c.language }]);
  } finally {
    session.close();
  }
  if (!isCurrent(token)) return;
  btn.disabled = false;
  renderCandidates(res);
}

/* ---------------------------------------------------------------- read the card from the photo */

let recognizer = null;

/** The front photo plus the card outline (full resolution), or the flattened card when the photo is gone. */
function ocrSource() {
  const s = state.scans.front;
  if (!s) return null;
  if (s.photo && s.corners) return { img: s.photo, H: Vision.warpMatrix(s.corners, 0) };
  return s.result ? CardOCR.fromWarped(s.result.warped, s.margin) : null;
}

/** The flattened front of the card as a JPEG (base64, no prefix), about 1000 px tall, for Gemini. */
function frontJpegBase64() {
  const s = state.scans.front;
  if (!s || !s.img) return "";
  const m = s.margin, w = s.width - 2 * m, h = s.height - 2 * m, k = Math.min(1, 1000 / h);
  const c = document.createElement("canvas");
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext("2d").drawImage(s.img, m, m, w, h, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1] || "";
}

async function readFromPhoto({ auto = false } = {}) {
  const src = ocrSource();
  if (!src) { if (!auto) setStatus("Add a front photo first."); return; }
  // Results belong to this card and this front photo: a new photo or another card drops them.
  const token = sideToken("front");
  if (offline()) {
    if (!auto) renderCandidates({ candidates: [], offline: true });
    else setStatus("Offline: card lookup needs a connection.", "Offline");
    return;
  }
  const btn = $("#read-card");
  btn.disabled = true;
  let reading = null, note = "";
  if (gmKey()) {
    // With a Gemini key the card is read by Gemini (the front photo goes to Google); far more accurate
    // than the on-phone reader. If it fails, fall back to the on-phone reader.
    setStatus("Reading the card with Gemini (sends the front photo to Google)…", "Reading card…");
    try {
      reading = await GeminiID.identify(frontJpegBase64(), { apiKey: gmKey(), fetch: (...a) => window.fetch(...a) });
      if (!reading.found) reading = null;
    } catch (err) {
      note = `${(err && err.message) || "Gemini couldn't read the card."} Using the on-device reader instead. `;
      reading = null;
    }
    if (!isCurrent(token)) return;
  }
  if (!reading) {
    if (!recognizer) recognizer = CardOCR.browserRecognizer((t) => { if (isCurrent(token)) setStatus(t, "Reading card…"); });
    setStatus(`${note}Reading the card…`, "Reading card…");
    try {
      reading = await CardOCR.read(src, state.game, recognizer);
    } catch (err) {
      if (!isCurrent(token)) return;
      btn.disabled = false;
      setStatus(`${note}${(err && err.message) || "Couldn't read the card."} Type the name and number, then tap Find online.`, "Couldn't read the card");
      return;
    }
    if (!isCurrent(token)) return;
  }
  btn.disabled = false;
  if (reading.game && reading.game !== state.game) toast(`This looks like a ${gameInfo(reading.game).label} card. Switch the game on the Scan screen if it is.`);
  if (!reading.found) {
    setStatus("Couldn't read the name or number from this photo (glare, a holo pattern, or a non-English card). Type them, then tap Find online.", "Couldn't read the card");
    return;
  }
  leaveExample();
  // A confirmed reference belongs to the card it was confirmed for; a new reading has to be confirmed again.
  if (state.reference && state.reference.source !== "user") clearReference();
  state.market = null;
  state.tcgplayerId = "";
  if (reading.name && (!auto || !$("#card-name").value.trim())) $("#card-name").value = reading.name;
  if (reading.number) {
    $("#collector-line").value = [reading.set_code, reading.number, reading.language].filter(Boolean).join(" · ");
    $("#card-number").value = reading.number;
    if (reading.set_code) $("#card-set-code").value = reading.set_code;
    if (reading.language) $("#card-language").value = reading.language === "JA" ? "JP" : reading.language;
  }
  renderDetails();
  saveDraft();
  setStatus("Looking it up…", "Looking it up…");
  const session = lookupSession();
  let res;
  try {
    res = await session.firstMatch(CardOCR.queries(reading, state.game));
  } finally {
    session.close();
  }
  if (!isCurrent(token)) return;
  renderCandidates(res, reading);
}


/* ---------------------------------------------------------------- prices */

const PC_TOKEN_KEY = "cardGradingLab.pricecharting.token";  // never part of backups, drafts or History
const pcStorage = () => { try { return window.localStorage; } catch (_) { return null; } };
const pcToken = () => { try { return (pcStorage() && pcStorage().getItem(PC_TOKEN_KEY)) || ""; } catch (_) { return ""; } };

function priceCard() {
  const c = assessment().card;
  return { game: c.game, name: $("#card-name").value.trim(), set_name: c.set_name, number: c.number, finish: c.finish };
}
// The card revision is part of the key: an answer for a card that has since been replaced is dropped.
const priceKey = (c) => [state.cardRev, c.game, c.name, c.set_name, c.number, c.finish].map((v) => String(v == null ? "" : v).toLowerCase()).join("|");

async function loadPrices({ force = false } = {}) {
  const card = priceCard();
  const key = priceKey(card);
  if (!card.name || !card.number) { state.price = { key, status: "idle" }; renderPrices(); return; }
  const token = pcToken();
  if (!token) { state.price = { key, status: "no-token" }; renderPrices(); return; }
  if (!force && state.price.key === key && ["loading", "ok"].includes(state.price.status)) return;
  state.price = { key, status: "loading" };
  renderPrices();
  const opts = { token, fetch: (...a) => window.fetch(...a), storage: pcStorage() };
  try {
    const search = await Prices.search(card, opts);
    if (state.price.key !== key) return;
    if (!search.matches.length) throw new Error(search.error || "PriceCharting has no product matching this card.");
    const chosen = search.best || search.matches[0];
    const product = await Prices.product(chosen.id, opts);
    if (state.price.key !== key) return;
    state.price = { key, status: "ok", search, chosenId: chosen.id, product };
  } catch (err) {
    if (state.price.key === key) state.price = { key, status: "error", error: (err && err.message) || "The price lookup failed." };
  }
  renderPrices();
}

async function choosePriceVersion(id) {
  const p = state.price;
  if (!p.search) return;
  const key = p.key;
  state.price = { ...p, status: "loading", chosenId: id };
  renderPrices();
  try {
    const product = await Prices.product(id, { token: pcToken(), fetch: (...a) => window.fetch(...a), storage: pcStorage() });
    if (state.price.key === key) state.price = { ...state.price, status: "ok", product };
  } catch (err) {
    if (state.price.key === key) state.price = { ...state.price, status: "error", error: (err && err.message) || "The price lookup failed." };
  }
  renderPrices();
}

function priceNote(box, text, cls = "") {
  const p = document.createElement("p");
  p.className = `pr-note ${cls}`.trim();
  p.textContent = text;
  box.append(p);
  return p;
}

function priceLink(box, href, text) {
  if (!httpsUrl(href)) return;
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  box.append(a);
}

function renderMarket(box) {
  // Free ungraded prices from the card database (TCGdex), when there's no PriceCharting access.
  const m = state.game === "pokemon" ? Prices.fromTcgdex(state.market) : null;
  if (!m) return;
  const parts = [];
  if (m.tcgplayer) {
    const v = m.tcgplayer.versions[0];
    parts.push(`TCGplayer market $${v.market.toFixed(2)}${m.tcgplayer.versions.length > 1 ? ` (${v.version})` : ""}`);
  }
  if (m.cardmarket) parts.push(`Cardmarket trend €${m.cardmarket.trend.toFixed(2)}`);
  const when = (m.tcgplayer && m.tcgplayer.updated) || (m.cardmarket && m.cardmarket.updated) || "";
  priceNote(box, `Ungraded, from the card database (TCGdex): ${parts.join(" · ")}${when ? `, updated ${when.slice(0, 10)}` : ""}. Not a graded price.`);
}

function renderPrices() {
  const box = $("#prices-body");
  if (!box) return;
  renderCardSight();
  renderRiftPrices();
  box.innerHTML = "";
  const card = priceCard();
  const has = !!(card.name && card.number);
  $("#refresh-prices").hidden = !has;
  $("#pc-status").textContent = pcToken() ? "A token is saved on this device." : "";
  if (!has) {
    priceNote(box, "Confirm which card this is first: Card details → Read from photo, or Find online.");
    renderWebPrices();
    return;
  }
  const p = state.price;
  const stale = p.key !== priceKey(card);
  if (stale && p.status !== "idle") priceNote(box, "The card details changed. Tap Update for this card's prices.");
  if (!stale && p.status === "loading") priceNote(box, "Looking up prices…");
  if (!stale && p.status === "error") priceNote(box, p.error, "warn");
  // Riftbound: the TCGplayer section above already says where graded prices come from.
  if ((p.status === "no-token" || !pcToken()) && state.game === "pokemon" && !csKey()) priceNote(box, "For graded prices, add a CardSight key in Settings, or open the card on PriceCharting to see every grade.");
  if (!stale && p.status === "ok" && p.product) {
    const prod = p.product;
    const head = document.createElement("div");
    head.className = "pr-product";
    head.innerHTML = "<b></b><span></span>";
    $("b", head).textContent = prod.product_name;
    $("span", head).textContent = prod.console_name;
    box.append(head);
    const matches = p.search.matches.filter((m) => m.score > 0).slice(0, 8);
    if (matches.length > 1) {
      const sel = document.createElement("select");
      sel.className = "pr-choose";
      sel.setAttribute("aria-label", "PriceCharting version");
      for (const m of matches) {
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = `${m.product_name} · ${m.console_name}`;
        sel.append(o);
      }
      sel.value = p.chosenId;
      sel.addEventListener("change", () => choosePriceVersion(sel.value));
      box.append(sel);
    }
    if (p.search.needs_choice) priceNote(box, "Check this is your exact version: 1st Edition, Shadowless, reverse holo, foil and promo copies are priced separately.", "warn");
    const report = state.report;
    const rows = report ? Prices.forReport(prod, report) : { ungraded: prod.prices["loose-price"], rows: [], ceiling: false };
    const table = document.createElement("table");
    table.className = "pr-table";
    const add = (label, cents, small = "", cls = "") => {
      const tr = document.createElement("tr");
      if (cls) tr.className = cls;
      tr.innerHTML = "<th></th><td class=\"pr-val\"></td>";
      $("th", tr).textContent = label;
      if (small) { const sm = document.createElement("small"); sm.textContent = small; $("th", tr).append(sm); }
      $("td", tr).textContent = Prices.money(cents);
      table.append(tr);
    };
    add("Ungraded", rows.ungraded);
    for (const r of rows.rows) {
      const grade = r.label.replace(/^Up to /, "").replace(/ · incomplete$/, "");
      add(`${r.company} ${r.ceiling ? "up to " : ""}${grade}`, r.cents, [r.basis && `PriceCharting: ${r.basis}.`, r.note].filter(Boolean).join(" "), r.ceiling ? "pr-ceiling" : "");
    }
    box.append(table);
    if (rows.ceiling) priceNote(box, "These grades are best-case ceilings, so the graded prices are the most this card could sell for at those grades, not what it's worth. The real grade may be lower.", "warn");
    const ladder = document.createElement("details");
    ladder.className = "pr-ladder";
    ladder.innerHTML = "<summary>All grades</summary>";
    const lt = document.createElement("table");
    lt.className = "pr-table";
    for (const l of Prices.ladder(prod)) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<th></th><td class=\"pr-val\"></td>";
      $("th", tr).textContent = l.label;
      $("td", tr).textContent = Prices.money(l.cents);
      lt.append(tr);
    }
    ladder.append(lt);
    box.append(ladder);
    priceNote(box, `Prices from PriceCharting, fetched ${new Date(prod.fetched_at).toLocaleDateString()}. Grades 1-9.5 are PriceCharting's prices for any grading company.`);
  }
  if (p.status !== "ok" || stale) renderMarket(box);
  const links = document.createElement("div");
  links.className = "pr-links";
  if (!stale && p.status === "ok" && p.product) priceLink(links, Prices.productUrl(p.product), "Open on PriceCharting");
  else priceLink(links, Prices.searchUrl(card), "See prices on PriceCharting");
  if (state.game !== "riftbound" && state.tcgplayerId && /^\d+$/.test(state.tcgplayerId)) priceLink(links, `https://www.tcgplayer.com/product/${state.tcgplayerId}`, "TCGplayer");
  box.append(links);
  renderWebPrices();
}

/* ---------------------------------------------------------------- recent sales (CardSight, Pokemon) */

const CS_KEY = "cardGradingLab.cardsight.key";  // never in backups, drafts or History
const csKey = () => { try { return (pcStorage() && pcStorage().getItem(CS_KEY)) || ""; } catch (_) { return ""; } };
const money2 = (v) => (v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

async function loadCardSight({ force = false, chooseId = null } = {}) {
  const card = priceCard();
  const key = priceKey(card);
  if (state.game !== "pokemon" || !card.name) { state.cs = { key, status: "idle" }; renderCardSight(); return; }
  if (!csKey()) { state.cs = { key, status: "no-key" }; renderCardSight(); return; }
  if (!force && !chooseId && state.cs.key === key && ["loading", "ok"].includes(state.cs.status)) return;
  const prev = state.cs;
  state.cs = { ...(chooseId ? prev : {}), key, status: "loading" };
  renderCardSight();
  const opts = { apiKey: csKey(), fetch: (...a) => window.fetch(...a), storage: pcStorage() };
  try {
    const find = chooseId && prev.find ? prev.find : await CardSight.findCard(card, opts);
    if (state.cs.key !== key) return;
    if (!find.matches.length) throw new Error("CardSight has no card matching these details.");
    const chosen = chooseId ? find.matches.find((m) => m.id === chooseId) : find.best || find.matches[0];
    const data = await CardSight.sales(chosen.id, opts);
    if (state.cs.key !== key) return;
    state.cs = { key, status: "ok", find, chosenId: chosen.id, data: data || { raw: [], graded: [], messages: [] }, version: "" };
  } catch (err) {
    if (state.cs.key === key) state.cs = { key, status: "error", error: (err && err.message) || "The sales lookup failed." };
  }
  renderCardSight();
}

function renderCardSight() {
  renderPriceMeta();
  const wrap = $("#cs-prices"), box = $("#cs-body");
  if (!box) return;
  const pokemon = state.game === "pokemon";
  wrap.hidden = !pokemon;
  $("#cs-status").textContent = csKey() ? "A key is saved on this device." : "";
  if (!pokemon) return;
  box.innerHTML = "";
  const card = priceCard();
  const c = state.cs;
  const stale = c.key && c.key !== priceKey(card);
  if (!card.name) { priceNote(box, "Confirm which card this is first."); return; }
  if (!csKey() || c.status === "no-key") { priceNote(box, "Add your CardSight API key in Settings to see recent sales, raw and graded."); return; }
  if (stale) { priceNote(box, "The card details changed. Tap Update for this card's sales."); return; }
  if (c.status === "loading") { priceNote(box, "Looking up recent sales…"); return; }
  if (c.status === "error") { priceNote(box, c.error, "warn"); return; }
  if (c.status !== "ok") return;
  const m = c.find.matches.find((x) => x.id === c.chosenId) || c.find.matches[0];
  const head = document.createElement("div");
  head.className = "pr-product";
  head.innerHTML = "<b></b><span></span>";
  $("b", head).textContent = `${m.name}${m.number ? ` #${m.number}` : ""}`;
  $("span", head).textContent = [m.set, m.release !== m.set && m.release, m.year].filter(Boolean).join(" · ");
  box.append(head);
  const options = c.find.matches.filter((x) => x.score > 0).slice(0, 8);
  if (options.length > 1) {
    const sel = document.createElement("select");
    sel.className = "pr-choose";
    sel.setAttribute("aria-label", "CardSight card");
    for (const x of options) {
      const o = document.createElement("option");
      o.value = x.id;
      o.textContent = [`${x.name}${x.number ? ` #${x.number}` : ""}`, x.set || x.release, x.year].filter(Boolean).join(" · ");
      sel.append(o);
    }
    sel.value = c.chosenId;
    sel.addEventListener("change", () => loadCardSight({ chooseId: sel.value }));
    box.append(sel);
  }
  if (c.find.needs_choice) priceNote(box, "Check this is your exact card: several catalog entries look alike.", "warn");
  const vers = CardSight.versions(c.data);
  if (vers.length > 1) {
    const sel = document.createElement("select");
    sel.className = "pr-choose";
    sel.setAttribute("aria-label", "Version");
    for (const v of vers) {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = v.id ? `${v.name} (${v.count} sales)` : "Base card";
      sel.append(o);
    }
    sel.value = c.version;
    sel.addEventListener("change", () => { state.cs = { ...state.cs, version: sel.value }; renderCardSight(); });
    box.append(sel);
  }
  const res = CardSight.forReport(c.data, state.report, c.version);
  const table = document.createElement("table");
  table.className = "pr-table";
  const row = (label, st, extra = "", cls = "") => {
    const tr = document.createElement("tr");
    if (cls) tr.className = cls;
    tr.innerHTML = "<th></th><td class=\"pr-val\"></td>";
    $("th", tr).textContent = label;
    const sm = document.createElement("small");
    if (st) {
      sm.append(`${st.count} sale${st.count === 1 ? "" : "s"}, ${money2(st.low)}–${money2(st.high)}. Last `);
      if (httpsUrl(st.last.url)) {
        const a = document.createElement("a");
        a.href = st.last.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = `${money2(st.last.price)} on ${st.last.date}`;
        sm.append(a);
      } else sm.append(`${money2(st.last.price)} on ${st.last.date}`);
      if (st.last.source) sm.append(` (${st.last.source})`);
      sm.append(".");
    }
    if (extra) sm.append(`${st ? " " : ""}${extra}`);
    if (sm.textContent) $("th", tr).append(sm);
    $("td", tr).textContent = st ? money2(st.median) : "—";
    table.append(tr);
  };
  row("Ungraded", res.ungraded, res.ungraded ? "" : "No ungraded sales in the last year.");
  for (const r of res.rows) row(`${r.company} ${r.ceiling ? "up to " : ""}${r.label}`, r.stats, r.note, r.ceiling ? "pr-ceiling" : "");
  box.append(table);
  if (res.ceiling) priceNote(box, "These grades are best-case ceilings, so the graded prices are the most this card could sell for at those grades, not what it's worth. The real grade may be lower.", "warn");
  if (res.all.length) {
    const d = document.createElement("details");
    d.className = "pr-ladder";
    d.innerHTML = "<summary>All graded sales</summary>";
    const t = document.createElement("table");
    t.className = "pr-table";
    for (const a of res.all) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<th></th><td class=\"pr-val\"></td>";
      $("th", tr).textContent = `${a.company} ${a.grade}`;
      const sm = document.createElement("small");
      sm.textContent = `${a.stats.count} sale${a.stats.count === 1 ? "" : "s"}, last ${money2(a.stats.last.price)} on ${a.stats.last.date}`;
      $("th", tr).append(sm);
      $("td", tr).textContent = money2(a.stats.median);
      t.append(tr);
    }
    d.append(t);
    box.append(d);
  }
  priceNote(box, `Median of completed auction sales in the last year, from CardSight (fetched ${new Date(c.data.fetched_at || Date.now()).toLocaleDateString()}). Open the listings to check they're your version.${(c.data.messages || []).length ? ` CardSight: ${c.data.messages.join(" ")}` : ""}`);
}

function saveCardSightKey() {
  const k = $("#cs-key").value.trim();
  if (!CardSight.validKey(k)) { $("#cs-status").textContent = "That doesn't look like a CardSight API key."; return; }
  try { pcStorage().setItem(CS_KEY, k); } catch (_) { $("#cs-status").textContent = "This browser won't store it (private mode?)."; return; }
  $("#cs-key").value = "";
  $("#cs-settings").open = false;
  renderPrices();
  loadCardSight({ force: true });
}

function removeCardSightKey() {
  try { pcStorage().removeItem(CS_KEY); } catch (_) { /* blocked */ }
  CardSight.clearCache(pcStorage());  // cached CardSight data goes with the key
  $("#cs-key").value = "";
  state.cs = { key: "", status: "no-key" };
  renderPrices();
}

/* ---------------------------------------------------------------- Riftbound prices (TCGplayer, daily file) */

async function loadRiftPrices() {
  const card = { ...priceCard(), set_code: $("#card-set-code").value.trim(), tcgplayer_id: state.tcgplayerId };
  const key = priceKey(card);
  if (state.game !== "riftbound" || !card.number) { state.rb = { key, status: "idle" }; renderRiftPrices(); return; }
  state.rb = { key, status: "loading" };
  renderRiftPrices();
  try {
    const data = await RiftPrices.load({ fetch: (...a) => window.fetch(...a), url: ENV === "site" ? "riftbound-prices.json" : RiftPrices.SITE_URL });
    if (state.rb.key !== key) return;
    const match = RiftPrices.find(data, card);
    state.rb = { key, status: match ? "ok" : "none", match, updated: data.updated_at };
  } catch (err) {
    if (state.rb.key === key) state.rb = { key, status: "error", error: (err && err.message) || "The price list couldn't be loaded." };
  }
  renderRiftPrices();
}

function renderRiftPrices() {
  renderPriceMeta();
  const wrap = $("#rb-prices"), box = $("#rb-body");
  if (!box) return;
  wrap.hidden = state.game !== "riftbound";
  if (wrap.hidden) return;
  box.innerHTML = "";
  const r = state.rb;
  const stale = r.key && r.key !== priceKey(priceCard());
  if (!priceCard().number) { priceNote(box, "Confirm which card this is first."); return; }
  if (stale) { priceNote(box, "The card details changed. Tap Update for this card's prices."); return; }
  if (r.status === "loading") { priceNote(box, "Loading today's prices…"); return; }
  if (r.status === "error") { priceNote(box, r.error, "warn"); return; }
  if (r.status === "none") { priceNote(box, "This card isn't in TCGplayer's Riftbound list yet (new cards can take a few days)."); return; }
  if (r.status !== "ok") return;
  const c = r.match.card;
  const head = document.createElement("div");
  head.className = "pr-product";
  head.innerHTML = "<b></b><span></span>";
  $("b", head).textContent = c.name;
  $("span", head).textContent = [c.set_name, c.number, c.rarity].filter(Boolean).join(" · ");
  box.append(head);
  if (!r.match.name_matches) priceNote(box, "Matched by set and number, but the name differs: check it's your card.", "warn");
  const list = RiftPrices.rows(c);
  if (!list.length) priceNote(box, "No current TCGplayer price for this card.");
  else {
    const table = document.createElement("table");
    table.className = "pr-table";
    for (const x of list) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<th></th><td class=\"pr-val\"></td>";
      $("th", tr).textContent = `Ungraded · ${x.printing}`;
      const sm = document.createElement("small");
      sm.textContent = [x.market == null && "No recent sales (market price)", x.low != null && `lowest listing ${money2(x.low)}`, x.mid != null && `mid ${money2(x.mid)}`].filter(Boolean).join(" · ");
      $("th", tr).append(sm);
      $("td", tr).textContent = money2(x.market ?? x.mid);
      table.append(tr);
    }
    box.append(table);
  }
  priceNote(box, `TCGplayer market prices (recent sales, ungraded) via tcgcsv.com, updated ${String(r.updated || "").slice(0, 10)}. Graded Riftbound prices aren't listed on TCGplayer: use Web search below.`);
  const links = document.createElement("div");
  links.className = "pr-links";
  priceLink(links, c.url, "Open on TCGplayer");
  box.append(links);
}

/* ---------------------------------------------------------------- web price search (Gemini) */

const GM_KEY = "cardGradingLab.gemini.key", GM_MODEL = "cardGradingLab.gemini.model";  // never in backups, drafts or History
const gmKey = () => { try { return (pcStorage() && pcStorage().getItem(GM_KEY)) || ""; } catch (_) { return ""; } };
const gmModel = () => { try { return (pcStorage() && pcStorage().getItem(GM_MODEL)) || WebPrices.MODELS[0].id; } catch (_) { return WebPrices.MODELS[0].id; } };

async function webSearch() {
  const card = { ...priceCard(), set_code: $("#card-set-code").value.trim(), language: $("#card-language").value };
  const key = priceKey(card);
  if (!card.name) { state.web = { key, status: "error", error: "Confirm which card this is first: Card details → Read from photo, or Find online." }; renderWebPrices(); return; }
  if (!gmKey()) { state.web = { key, status: "error", error: "Add your Gemini API key in Settings first (API access → Gemini)." }; renderWebPrices(); return; }
  state.web = { key, status: "loading" };
  renderWebPrices();
  try {
    const result = await WebPrices.search(card, { apiKey: gmKey(), model: gmModel(), fetch: (...a) => window.fetch(...a), report: state.report });
    if (state.web.key === key) state.web = { key, status: "ok", result, ceiling: !!(state.report && state.report.complete === false) };
  } catch (err) {
    if (state.web.key === key) state.web = { key, status: "error", error: (err && err.message) || "The web search failed." };
  }
  renderWebPrices();
}

/** The Prices row on Review and the key states in Settings. */
function renderPriceMeta() {
  const set = (id, on) => { const el = $(id); if (el) el.textContent = on ? "Saved" : "Not set"; };
  set("#gm-state", gmKey());
  set("#pc-state", pcToken());
  set("#cs-state", csKey());
  const card = priceCard();
  const fresh = (x) => x && x.status !== "idle" && x.key === priceKey(card);
  const p = state.price, c = state.cs, r = state.rb;
  let text;
  if (!card.name && !card.number) text = "Identify the card first";
  else if ([p, c, r, state.web].some((x) => fresh(x) && x.status === "loading")) text = "Looking up prices…";
  else if (fresh(p) && p.status === "ok" && p.product) text = `PriceCharting · ungraded ${Prices.money(p.product.prices["loose-price"])}`;
  else if (fresh(c) && c.status === "ok") text = "Recent sales from CardSight";
  else if (fresh(r) && r.status === "ok") text = "TCGplayer market prices";
  else if ([p, c, r].some((x) => fresh(x) && x.status === "error")) text = offline() ? "Offline" : "Couldn't load prices";
  else if (!pcToken() && !csKey() && !gmKey() && state.game === "pokemon") text = "Market links · add API keys in Settings for more";
  else text = "Market links and searches";
  const el = $("#prices-summary");
  if (el) el.textContent = text;
}

function renderWebPrices() {
  renderPriceMeta();
  const box = $("#web-results");
  if (!box) return;
  box.innerHTML = "";
  const card = priceCard();
  const w = state.web;
  const stale = w.key && w.key !== priceKey({ ...card });
  $("#web-search").disabled = w.status === "loading";
  $("#web-status").textContent = w.status === "loading" ? "Searching… (10-30 s)" : gmKey() ? "" : "Needs your Gemini API key (Settings).";
  $("#gm-status").textContent = gmKey() ? "A key is saved on this device." : "";
  if (w.status === "error" && !stale) priceNote(box, w.error, "warn");
  if (w.status !== "ok" || stale) {
    if (stale && w.status === "ok") priceNote(box, "The card details changed. Search again for this card.");
    return;
  }
  const r = w.result;
  if (r.card_found) priceNote(box, `Found as: ${r.card_found}`);
  if (!r.grounded) priceNote(box, "Gemini didn't use web search for this answer, so no prices are shown. Try again.", "warn");
  if (r.grounded && !r.prices.length) priceNote(box, r.parsed ? "No prices for this card were found in the search results." : "Gemini's answer couldn't be read. Try again.", "warn");
  if (r.grounded && r.prices.length) {
    const table = document.createElement("table");
    table.className = "pr-table";
    for (const p of r.prices) {
      const tr = document.createElement("tr");
      if (!p.in_results) tr.className = "unverified";
      tr.innerHTML = "<th></th><td class=\"pr-val\"></td>";
      $("th", tr).textContent = p.grade;
      const sm = document.createElement("small");
      sm.textContent = [p.kind && cap(p.kind), p.source, p.date, p.version, !p.in_results && "source not in Google's results: check it"].filter(Boolean).join(" · ");
      $("th", tr).append(sm);
      $("td", tr).textContent = `$${p.price_usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      table.append(tr);
    }
    box.append(table);
    if (w.ceiling) priceNote(box, "Your grades are best-case ceilings: the real grade, and so the price, may be lower.", "warn");
  }
  priceNote(box, `An AI summary of a Google search (${r.model}). It can be wrong or pick the wrong version: check the sources before relying on a price.${r.notes ? ` Gemini's note: ${r.notes}` : ""}${r.dropped.some((d) => d.why === "blocked source") ? " PriceCharting figures are left out (its terms don't allow them here)." : ""}`);
  if (r.sources.length) {
    const ol = document.createElement("ol");
    ol.className = "pr-sources";
    for (const s of r.sources.slice(0, 10)) {
      if (!httpsUrl(s.uri)) continue;
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = s.uri;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = s.title || s.site;
      li.append(a);
      ol.append(li);
    }
    box.append(ol);
  }
  if (r.suggestionsHtml) {
    // Google's search suggestions must be shown with the results. Sandboxed: no scripts, links open a new tab.
    const f = document.createElement("iframe");
    f.className = "pr-suggest";
    f.title = "Google search suggestions";
    f.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
    f.srcdoc = WebPrices.suggestionsDoc(r.suggestionsHtml);
    box.append(f);
  }
}

function saveGeminiKey() {
  const k = $("#gm-key").value.trim();
  const model = $("#gm-model").value;
  try { if (model) pcStorage().setItem(GM_MODEL, model); } catch (_) { /* blocked */ }
  if (!k && gmKey()) { $("#gm-status").textContent = "Model saved."; return; }
  if (!WebPrices.validKey(k)) { $("#gm-status").textContent = "That doesn't look like a Gemini API key."; return; }
  try { pcStorage().setItem(GM_KEY, k); } catch (_) { $("#gm-status").textContent = "This browser won't store it (private mode?)."; return; }
  $("#gm-key").value = "";
  $("#gm-settings").open = false;
  renderWebPrices();
}

function removeGeminiKey() {
  try { pcStorage().removeItem(GM_KEY); } catch (_) { /* blocked */ }
  $("#gm-key").value = "";
  state.web = { key: "", status: "idle" };
  renderWebPrices();
}

function savePriceToken() {
  const t = $("#pc-token").value.trim();
  if (!Prices.validToken(t)) { $("#pc-status").textContent = "That doesn't look like a PriceCharting token (40 letters and digits)."; return; }
  try { pcStorage().setItem(PC_TOKEN_KEY, t); } catch (_) { $("#pc-status").textContent = "This browser won't store it (private mode?)."; return; }
  $("#pc-token").value = "";
  $("#pc-settings").open = false;
  loadPrices({ force: true });
}

function removePriceToken() {
  try { pcStorage().removeItem(PC_TOKEN_KEY); } catch (_) { /* blocked */ }
  Prices.clearCache(pcStorage());  // PriceCharting data may only be kept while subscribed
  $("#pc-token").value = "";
  state.price = { key: "", status: "no-token" };
  renderPrices();
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
    // DINGS the user logged, plus photo-check spots nobody has added or dismissed yet: those count only as
    // "possible wear" (confirmed: false), which limits an area to 9 at most and never stacks.
    defects: [...state.defects, ...pendingFlags()],
    inspected: { front: [...state.inspected.front], back: [...state.inspected.back] },
    photo_limits: { front: [...state.photoLimits.front], back: [...state.photoLimits.back] },
    inspected_in_hand: { front: [...state.inHand.front], back: [...state.inHand.back] },
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
    tile.className = "row row-btn tile" + (best ? " best" : "") + (incomplete ? " incomplete" : "");
    tile.dataset.co = g.company;
    tile.innerHTML = `<span class="tile-co">${g.company}</span><span class="tile-label"></span><span class="tile-sub"></span><span class="tile-grade"><span class="tile-num"></span>${svgIcon("chevron", "ic chev")}</span>`;
    $(".tile-num", tile).innerHTML = bigGradeHTML(g);
    const label = (incomplete ? "Up to " : "") + baseLabel(g).replace(/\s*\d+(\.\d)?$/, "").replace(/ 10 \(Black Label\)$/, " · Black Label");
    $(".tile-label", tile).textContent = label;
    if (incomplete) $(".tile-label", tile).insertAdjacentHTML("beforeend", ' <span class="tile-flag">Incomplete</span>');
    if (best) $(".tile-label", tile).insertAdjacentHTML("beforeend", ' <span class="tile-badge">Best</span>');
    $(".tile-sub", tile).textContent = g.company === "TAG" && g.score != null ? `${incomplete ? "≤ " : ""}${g.score} / 1000` : g.qualifiers.length ? g.qualifiers.join(" · ") : "";
    tile.setAttribute("aria-label", `${g.company}: ${bigGrade(g)}, ${label}${incomplete ? ", incomplete" : ""}${best ? ", best" : ""}. Show breakdown.`);
    tile.addEventListener("click", () => openCompany(g.company, tile));
    box.append(tile);
  }
  const line = $("#best-line");
  line.classList.toggle("warn", !top);
  line.textContent = !top
    ? "These are ceilings, not grades, until every area is checked."
    : top.tier >= 99
      ? "This card looks altered, so no company would give it a number."
      : `Best estimate: ${top.company} ${top.label}. Tap a grade for the breakdown.`;
}

function renderScore(report) {
  const incomplete = report.complete === false;
  $("#score-missing").hidden = !incomplete;
  $("#score-missing-list").textContent = incomplete ? report.unassessed.join(", ") : "";
  const f = state.centering.front, b = state.centering.back;
  $("#centering-summary").textContent = `${splitText(Math.max(f.lr, f.tb))} · ${splitText(Math.max(b.lr, b.tb))}`;
}

function renderMetrics(report) {
  // Rank only complete grades (re-graded with the current rules): a ceiling can't be ranked.
  const score = report.complete === false ? null : report.grades.TAG.score;
  const others = localStore.cards().map((c) => ({ c, r: currentReport(c) }))
    .filter(({ c, r }) => c.id !== state.savedId && r && r.complete !== false && r.grades.TAG.score != null);
  const rank = score == null ? null : 1 + others.filter(({ r }) => r.grades.TAG.score > score).length;
  $("#rank-value").textContent = rank == null ? (report.complete === false ? "After checking" : "—") : `#${rank} of ${others.length + 1}`;
}

function renderSubgrades(report) {
  const box = $("#subgrades");
  const areas = report.grades.TAG.subgrades;
  box.innerHTML = "";
  if (report.grades.TAG.tier >= 99) {
    box.innerHTML = '<p class="footnote tight" style="grid-column: 1 / -1">No subgrades: the card is logged as altered.</p>';
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
      const cell = document.createElement("span");
      if (v == null) {  // not inspected: no score, only a ceiling
        cell.className = "sub-cell unchecked";
        cell.innerHTML = "<b>Not checked</b>";
        cell.setAttribute("aria-label", `${side} ${comp} not checked`);
      } else {
        cell.className = "sub-cell";
        cell.innerHTML = "<b></b>";
        $("b", cell).textContent = v;
        cell.setAttribute("aria-label", `${side} ${comp} ${v} out of 1000`);
      }
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
    d.innerHTML = `<summary class="row row-btn"><span class="co-code">${g.company}</span><span class="co-label"></span><span class="co-grade"></span>${svgIcon("chevron", "ic chev")}</summary>
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
      li.textContent = uiText(r);
      why.append(li);
    }
    const notes = $(".notes", d);
    for (const n of g.notes) {
      const li = document.createElement("li");
      li.textContent = uiText(n);
      notes.append(li);
    }
    box.append(d);
  }
}

function openCompany(company, opener) {
  pushPane("pane-company", opener);
  const d = $(`.company[data-co="${company}"]`);
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ block: "start" });
  $("summary", d).focus({ preventScroll: true });
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
  renderSurfacePane();
  renderCompanies(report);
  renderPrices();
  renderConfidence();
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
  const line = [[c.set_name, c.set_code && `(${c.set_code})`].filter(Boolean).join(" "), c.number, c.rarity, c.finish].filter(Boolean).join(" · ");
  $("#identity-sub").textContent = line || "Set, number and rarity not set";
  $("#game-chip").textContent = gameInfo(state.game).label;
}

function setDetailsEditing(on, opener = null) {
  if (on) openDialog("#details-sheet", opener || document.activeElement);
  else closeDialog("#details-sheet");
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

/* ---------------------------------------------------------------- navigation: tabs, Review, detail screens, dialogs */

const scrollMem = {};
let paneOpener = null;

function currentScreenId() {
  if (state.tab !== "scan") return `${state.tab}-screen`;
  if (state.view !== "report") return "scan-screen";
  return state.pane || "report-screen";
}

function showScreens() {
  const id = currentScreenId();
  for (const el of $$(".screen")) el.hidden = el.id !== id;
  $$(".tabbar button").forEach((b) => (b.dataset.tab === state.tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $("#app").dataset.view = state.view;
  $("#app").dataset.tab = state.tab;
}

function focusScreenTitle() {
  const h = $(`#${currentScreenId()} .nav-title`);
  if (!h) return;
  h.tabIndex = -1;
  h.focus({ preventScroll: true });
}

function leaveScreen() {
  scrollMem[currentScreenId()] = window.scrollY;
  if (guide.outline) setOutlineMode(false);
}

function setTab(tab) {
  if (tab === state.tab) {
    if (tab === "scan" && state.pane) popPane();
    else window.scrollTo({ top: 0 });
    return;
  }
  leaveScreen();
  state.tab = tab;
  if (tab === "history") renderHistory();
  if (tab === "settings") renderSettings();
  showScreens();
  window.scrollTo({ top: scrollMem[currentScreenId()] || 0 });
  focusScreenTitle();
}

function pushPane(id, opener = null) {
  if (state.tab !== "scan" || state.view !== "report") return;
  leaveScreen();
  paneOpener = opener || document.activeElement;
  state.pane = id;
  if (id === "pane-centering") guide.show();
  showScreens();
  window.scrollTo({ top: 0 });
  focusScreenTitle();
}

function popPane() {
  if (!state.pane) return;
  leaveScreen();
  state.pane = null;
  showScreens();
  window.scrollTo({ top: scrollMem["report-screen"] || 0 });
  if (paneOpener && paneOpener.isConnected && !paneOpener.closest("[hidden]")) paneOpener.focus({ preventScroll: true });
  else focusScreenTitle();
  paneOpener = null;
}

const dialogOpeners = {};
const DIALOGS = ["#surface-viewer", "#details-sheet", "#defect-sheet"];  // lowest to topmost

function updateInert() {
  const open = DIALOGS.filter((sel) => !$(sel).hidden);
  $("#app").inert = open.length > 0;
  $("#surface-viewer").inert = !$("#surface-viewer").hidden && open.length > 1;
  $("#details-sheet").inert = !$("#details-sheet").hidden && !$("#defect-sheet").hidden;
  document.body.style.overflow = open.length ? "hidden" : "";
  $("#app").dataset.modal = !$("#surface-viewer").hidden ? "viewer" : open.length ? "sheet" : "";
}

function openDialog(sel, opener) {
  const el = $(sel);
  dialogOpeners[sel] = opener && opener !== document.body ? opener : null;
  el.hidden = false;
  updateInert();
  const target = $(".sheet-bar .nav-title, .navbar .nav-title", el);
  if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
}

function closeDialog(sel) {
  const el = $(sel);
  if (el.hidden) return;
  el.hidden = true;
  updateInert();
  const o = dialogOpeners[sel];
  dialogOpeners[sel] = null;
  if (o && o.isConnected && !o.closest("[hidden]")) { o.focus({ preventScroll: true }); return; }
  // The opener was redrawn meanwhile: focus the equivalent place in what's now on top.
  const top = topDialog();
  const scope = top ? $(top) : $(`#${currentScreenId()}`);
  const target = scope && ($('[aria-pressed="true"]', scope) || $(".nav-title", scope));
  if (target) { if (target.classList.contains("nav-title")) target.tabIndex = -1; target.focus({ preventScroll: true }); }
}

function topDialog() {
  return [...DIALOGS].reverse().find((sel) => !$(sel).hidden) || null;
}

function setView(view, { animate = true, focus = true } = {}) {
  void animate;
  if (state.view !== view || state.tab !== "scan") leaveScreen();
  state.view = view;
  state.tab = "scan";
  state.pane = null;
  showScreens();
  window.scrollTo({ top: 0 });
  if (view === "report") {
    renderCentering();
    renderDefects();
    runGrade();
    const s = state.scans.front;
    if (!state.example && !state.autoRead && s && s.photo && !$("#card-name").value.trim() && !$("#card-number").value.trim() && !offline()) {
      state.autoRead = true;   // once per card: reading downloads the text reader the first time
      readFromPhoto({ auto: true });
    } else if (!state.example) {
      loadPrices();
      loadCardSight();
      loadRiftPrices();
    }
  } else {
    renderSlots();
    renderResume();
  }
  if (focus) focusScreenTitle();
}

/* ---------------------------------------------------------------- card lifecycle */

function resetCard() {
  // A new card: every async answer still in flight belongs to the old one and is dropped (isCurrent()).
  state.cardRev++;
  for (const side of SIDES) {
    try { runner().cancel(`scan-${side}`); runner().cancel(`marks-${side}`); runner().cancel(`angled-${side}`); } catch (_) { /* ignore */ }
    setSideBusy(side, false);
  }
  try { runner().cancel("filter"); } catch (_) { /* ignore */ }
  state.scans = { front: null, back: null };
  state.thumbs = { front: null, back: null };
  state.centering = { front: { lr: 50, tb: 50 }, back: { lr: 50, tb: 50 } };
  state.defects = [];
  state.inspected = { front: [], back: [] };
  state.photoLimits = { front: [], back: [] };
  state.inHand = { front: [], back: [] };
  state.dismissed = { front: [], back: [] };
  state.evidence = { front: { lr: "unread", tb: "unread" }, back: { lr: "unread", tb: "unread" } };
  state.pendingRev = { front: "", back: "" };
  state.conf = { front: null, back: null };
  state.confAnnounced = { front: "", back: "" };
  state.marks = { front: null, back: null };
  state.angled = { front: null, back: null };
  state.activeSide = "front";
  state.example = false;
  state.report = null;
  state.savedId = null;
  state.market = null;
  state.tcgplayerId = "";
  state.price = { key: "", status: "idle" };
  state.web = { key: "", status: "idle" };
  state.cs = { key: "", status: "idle" };
  state.rb = { key: "", status: "idle" };
  state.autoRead = false;
  clearReference();
  sv.reset();
  $("#id-results").hidden = true;
  $("#find-card").disabled = false;
  $("#read-card").disabled = false;
  setStatus("Reads the name and number from your front photo, then looks the card up. With a Gemini key saved (Settings), Gemini reads it and the front photo is sent to Google; without one, it's read on this device and only the text is sent.");
  $("#card-name").value = "";
  clearDetails();
  for (const sel of DIALOGS) closeDialog(sel);
  $("#example-note").hidden = true;
}

function newScan() {
  resetCard();
  localStore.remove(KEYS.draft);
  localStore.remove(KEYS.draftV2);
  setView("scan");
}

/** A destructive button that needs a second tap within a few seconds. */
function armed(btn, label, action) {
  const title = $(".row-title", btn) || btn;
  const original = title.textContent;
  btn.addEventListener("click", () => {
    if (btn.dataset.armed) {
      delete btn.dataset.armed;
      title.textContent = original;
      action();
      return;
    }
    btn.dataset.armed = "1";
    title.textContent = label;
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; title.textContent = original; } }, 3000);
  });
}

const hasCardData = () => !!(state.thumbs.front || state.thumbs.back || state.defects.length || $("#card-name").value.trim());

/* ---------------------------------------------------------------- example + drafts */

async function showExample() {
  resetCard();
  const token = cardToken();
  const ex = gameInfo(state.game).example;
  for (const side of SIDES) {
    await runScan(side, samplePhoto(side, state.game));
    if (!isCurrent(token)) return;
  }
  renderSlots();
  state.defects = ex.defects.map((d) => ({ ...d }));
  // The example card was fully inspected (in hand too), so it shows a complete grade.
  state.inspected = { front: [...COMPONENTS], back: [...COMPONENTS] };
  state.inHand = { front: [...COMPONENTS], back: [...COMPONENTS] };
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
  btn.hidden = !(draft && draft.centering) || hasCardData();
  if (!btn.hidden) $("#resume-text").textContent = `Resume ${draft.card && draft.card.name ? draft.card.name : "last card"}`;
}

function loadAssessment(a, thumbs) {
  resetCard();
  setGame((a.card && a.card.game) || "pokemon", { remember: false });
  $("#card-name").value = (a.card && a.card.name) || "";
  fillDetails(a.card || {});
  state.centering = { front: { ...a.centering.front }, back: { ...a.centering.back } };
  // Only confirmed defects are kept (unconfirmed photo-check flags are recomputed from a photo). Stored field
  // names are unchanged since the first version, so older saves load as they are.
  state.defects = (a.defects || []).filter((d) => d.confirmed !== false).map((d) => ({ ...d }));
  // Older saves have no inspection record: their areas start unchecked. Their centering was typed or
  // measured before saving (the grading engine's default when evidence is missing).
  const bySide = (x) => ({ front: [...((x || {}).front || [])], back: [...((x || {}).back || [])] });
  state.inspected = bySide(a.inspected);
  state.photoLimits = { front: Grading.photoLimitComponents(bySide(a.photo_limits).front), back: Grading.photoLimitComponents(bySide(a.photo_limits).back) };
  state.inHand = bySide(a.inspected_in_hand);
  const ev = a.centering_evidence || {};
  state.evidence = {
    front: { lr: "typed", tb: "typed", ...(ev.front || {}) },
    back: { lr: "typed", tb: "typed", ...(ev.back || {}) },
  };
  state.thumbs = { front: (thumbs && thumbs.front) || null, back: (thumbs && thumbs.back) || null };
  for (const side of SIDES) {
    // Photos aren't kept after saving: there's nothing to rate until the side is photographed again.
    state.conf[side] = { ...Confidence().notScanned(), summary: state.thumbs[side] ? "Photos aren't kept after saving. Retake this side to rate the scan." : "No photo of this side." };
  }
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
    list.innerHTML = '<li class="empty">No saved cards yet. Review a card and tap Save.</li>';
    return;
  }
  for (const c of cards) {
    if (!c || !c.assessment) continue;
    const li = document.createElement("li");
    li.innerHTML = `${c.front_thumb ? '<img alt="">' : '<span class="ph"></span>'}
      <div class="h-body"><div class="h-name"></div><div class="h-meta"></div><div class="h-grades"></div></div>
      <button type="button" class="icon-btn del"></button>`;
    if (c.front_thumb) $("img", li).src = c.front_thumb;
    const card = c.assessment.card || {};
    $(".h-name", li).textContent = card.name || "Unnamed card";
    $(".h-meta", li).textContent = [gameInfo(card.game).label, card.set_name, card.number, card.rarity, new Date(c.created_at).toLocaleDateString()].filter(Boolean).join(" · ");
    const report = currentReport(c);
    $(".h-grades", li).textContent = report ? Object.values(report.grades).map((g) => `${g.company} ${bigGrade(g)}`).join(" · ") : "";
    if (report && report.complete === false) $(".h-grades", li).insertAdjacentHTML("afterbegin", '<span class="h-flag">Incomplete</span> ');
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `Open ${card.name || "unnamed card"}${report ? `: ${$(".h-grades", li).textContent}` : ""}`);
    const open = () => {
      loadAssessment(c.assessment, { front: c.front_thumb, back: c.back_thumb });
      state.savedId = c.id;
      toast("Loaded from History");
    };
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => { if (e.target === li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } });
    const del = $(".del", li);
    const idle = () => { del.innerHTML = svgIcon("trash"); del.classList.remove("danger"); del.setAttribute("aria-label", `Delete ${card.name || "unnamed card"}`); };
    idle();
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (del.dataset.armed) {  // second tap confirms
        localStore.saveCards(localStore.cards().filter((x) => x.id !== c.id));
        renderHistory();
        toast("Deleted");
        const first = $("#history-list li");
        if (first) first.focus();
        return;
      }
      del.dataset.armed = "1";
      del.textContent = "Delete";
      del.classList.add("danger");
      del.setAttribute("aria-label", `Confirm: delete ${card.name || "unnamed card"}`);
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; idle(); } }, 3000);
    });
    list.append(li);
  }
}

function openHistory() {
  setTab("history");
}

function saveCard() {
  leaveExample();
  runGrade();
  const cards = localStore.cards().filter((c) => c.id !== state.savedId);  // saving again replaces the earlier save
  state.savedId = `${Date.now()}`;
  cards.unshift({
    id: state.savedId,
    created_at: new Date().toISOString(),
    assessment: assessment(),   // confirmed defects and evidence only: no filter previews, marks or keys
    report: state.report,
    front_thumb: state.thumbs.front,
    back_thumb: state.thumbs.back,
  });
  if (localStore.saveCards(cards)) {
    toast(`Saved. ${cards.length} card${cards.length === 1 ? "" : "s"} in History.`);
    renderMetrics(state.report);
  }
  else toast("This browser isn't letting the app save. Copy a backup in Settings to keep your cards.");
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
  const incoming = Array.isArray(data) ? data : data && data.cards;
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

/* ---------------------------------------------------------------- settings */

let themeSetByApp = false;
function applyTheme(choice, { remember = true } = {}) {
  const c = ["light", "dark"].includes(choice) ? choice : "system";
  const root = document.documentElement;
  if (c === "system") { if (themeSetByApp) root.removeAttribute("data-theme"); themeSetByApp = false; }
  else { root.setAttribute("data-theme", c); themeSetByApp = true; }
  if (remember) localStore.write(KEYS.theme, c);
  $$("#theme-seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === c)));
  viewer.render();
  sv.render();
}

function renderSettings() {
  renderPriceMeta();
  $("#gm-status").textContent = gmKey() ? "A key is saved on this device." : "";
  $("#pc-status").textContent = pcToken() ? "A token is saved on this device." : "";
  $("#cs-status").textContent = csKey() ? "A key is saved on this device." : "";
}

/* ---------------------------------------------------------------- surface inspection viewer */

// View-only tools: zoom, pan, filters and possible-mark finding. The original scan is never changed, and
// nothing here reaches grading unless the user adds a mark as a defect (then it's an ordinary confirmed defect).
const MARK_STATE_TEXT = { pending: "To review", added: "Added as a defect", dismissed: "Dismissed", check_in_hand: "Check in hand" };

const sv = {
  side: "front",
  source: "photo",        // photo | angled
  kind: "original",       // chosen filter
  showFiltered: false,    // the Original/Filtered toggle
  intensity: 60,
  zoom: 1, panX: 0, panY: 0,
  selected: null,         // selected candidate id
  cache: new Map(),       // filter key -> canvas (transient, never saved)
  filterBusy: false,
  filterError: "",
  pointers: new Map(),
  gesture: null,

  init() {
    this.canvas = $("#sv-canvas");
    this.ctx = this.canvas.getContext("2d");
    const filters = $("#sv-filters");
    for (const [kind, label] of SURFACE_FILTERS) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.kind = kind;
      b.textContent = label;
      b.addEventListener("click", () => this.setKind(kind));
      filters.append(b);
    }
    $$("[data-sv-side]").forEach((b) => b.addEventListener("click", () => { this.side = b.dataset.svSide; this.source = "photo"; this.selected = null; this.resetView(); this.render(); }));
    $$("[data-sv-source]").forEach((b) => b.addEventListener("click", () => { this.source = b.dataset.svSource; this.selected = null; this.render(); }));
    $$("[data-sv-view]").forEach((b) => b.addEventListener("click", () => { this.showFiltered = b.dataset.svView === "filtered" && this.kind !== "original"; this.render(); }));
    const slider = $("#sv-intensity");
    slider.addEventListener("input", () => {
      this.intensity = Number(slider.value);
      $("#sv-intensity-val").textContent = String(this.intensity);
      this.render();   // coalesced: only the latest value's filter is kept
    });
    $("#sv-reset").addEventListener("click", () => { this.kind = "original"; this.showFiltered = false; this.intensity = 60; slider.value = "60"; $("#sv-intensity-val").textContent = "60"; this.selected = null; this.resetView(); this.render(); });
    $("#sv-done").addEventListener("click", () => this.close());
    $("#sv-find").addEventListener("click", () => this.findMarks());
    const c = this.canvas;
    c.tabIndex = 0;
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e));
    c.addEventListener("pointercancel", (e) => this.onUp(e));
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0025));
    }, { passive: false });
    c.addEventListener("dblclick", (e) => {
      const r = c.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, this.zoom > 1.5 ? 1 / this.zoom : 3 / this.zoom);
    });
    c.addEventListener("keydown", (e) => {
      const r = c.getBoundingClientRect(), step = 40;
      const keys = {
        "+": () => this.zoomAt(r.width / 2, r.height / 2, 1.25), "=": () => this.zoomAt(r.width / 2, r.height / 2, 1.25),
        "-": () => this.zoomAt(r.width / 2, r.height / 2, 0.8), "0": () => { this.resetView(); this.draw(); },
        ArrowLeft: () => this.panBy(step, 0), ArrowRight: () => this.panBy(-step, 0), ArrowUp: () => this.panBy(0, step), ArrowDown: () => this.panBy(0, -step),
      };
      if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
    });
    window.addEventListener("resize", () => { if (this.isOpen()) this.draw(); });
  },

  isOpen() { return !$("#surface-viewer").hidden; },

  open(side, opener) {
    this.side = side;
    this.source = "photo";
    this.selected = null;
    this.resetView();
    openDialog("#surface-viewer", opener);
    this.render();
  },

  close() {
    try { runner().cancel("filter"); } catch (_) { /* ignore */ }
    closeDialog("#surface-viewer");
    renderSurfacePane();
  },

  reset() {
    this.cache.clear();
    this.kind = "original";
    this.showFiltered = false;
    this.selected = null;
    this.filterError = "";
    if (this.canvas && this.isOpen()) closeDialog("#surface-viewer");
  },

  /** A new photo or outline for this side: transient previews and candidates no longer apply. */
  invalidate(side) {
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${side}|`)) this.cache.delete(k);
    if (this.side === side) this.selected = null;
    if (this.canvas && this.isOpen()) this.render();
  },

  // The flattened image being viewed: the scan, or the angled-light photo of the same side.
  src() {
    const a = state.angled[this.side];
    if (this.source === "angled" && a && a.result) return { img: a.img, result: a.result, margin: a.margin, width: a.width, height: a.height, rev: a.rev, kind: "angled" };
    const s = state.scans[this.side];
    if (s && s.result) return { img: s.img, result: s.result, margin: s.margin, width: s.width, height: s.height, rev: s.rev, kind: "photo" };
    return null;
  },

  /**
   * The user-confirmed reference aligned to the front scan (Surface.compareReference), computed once per scan
   * revision and reference. undefined while it's being computed, null when there's nothing to compare.
   */
  refCompare() {
    const r = state.reference, s = state.scans.front, api = surfaceApi();
    if (!r || !r.rgba || !r.usable || !s || !s.result || !api || typeof api.compareReference !== "function") return null;
    const key = s.rev;
    if (this.cmp && this.cmp.key === key && this.cmp.ref === r) return this.cmp.result;
    if (this.cmpPending && this.cmpPending.key === key && this.cmpPending.ref === r) return undefined;
    const job = { key, ref: r };
    this.cmpPending = job;
    setTimeout(() => {
      if (this.cmpPending !== job) return;
      let result;
      try { result = api.compareReference(s.result.warped, s.margin, r.rgba); } catch (err) { result = { ok: false, reason: (err && err.message) || "The reference couldn't be compared." }; }
      this.cmpPending = null;
      if (state.reference !== r || !state.scans.front || state.scans.front.rev !== key) return;
      this.cmp = { key, ref: r, result };
      this.render();
    }, 30);
    return undefined;
  },

  diffReference() {
    const r = state.reference;
    if (this.side !== "front") return { ok: false, why: "A reference image shows the card's front only." };
    if (this.source !== "photo") return { ok: false, why: "Color difference compares the reference with the main photo." };
    if (!r) return { ok: false, why: "Needs a confirmed reference image: Card details → Find online, then confirm your card." };
    if (!r.rgba || !r.usable) return { ok: false, why: "The confirmed reference image can't be compared pixel by pixel." };
    const cmp = this.refCompare();
    if (cmp === undefined) return { ok: false, why: "Lining up the reference image with your photo…" };
    if (!cmp || !cmp.ok) return { ok: false, why: (cmp && cmp.reason) || "The reference image doesn't line up with this photo." };
    return { ok: true, reference: cmp };
  },

  filterAvailable(kind) {
    if (kind === "original") return { ok: true };
    if (!surfaceApi()) return { ok: false, why: "Filters aren't available in this build." };
    if (kind === "difference") return this.diffReference();
    return { ok: true };
  },

  setKind(kind) {
    if (!this.filterAvailable(kind).ok) return;
    this.kind = kind;
    this.showFiltered = kind !== "original";
    this.render();
  },

  setMarkStatus(side, id, status) {
    const m = state.marks[side];
    const c = m && m.candidates ? m.candidates.find((x) => x.id === id) : null;
    if (c) c.status = status;
  },

  resetView() { this.zoom = 1; this.panX = 0; this.panY = 0; },

  /* ----- geometry */
  layout() {
    const src = this.src();
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth || 1, ch = c.clientHeight || 1;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
    if (!src) return null;
    const w = src.width - 2 * src.margin, h = src.height - 2 * src.margin;
    const fit = Math.min(cw / w, ch / h) * 0.94;
    const s = fit * this.zoom;
    return { src, cw, ch, dpr, w, h, s, x0: cw / 2 + this.panX - (w * s) / 2, y0: ch / 2 + this.panY - (h * s) / 2 };
  },

  clampPan() {
    const L = this.layout();
    if (!L) return;
    const mx = Math.max(0, (L.w * L.s - L.cw) / 2) + L.cw * 0.25, my = Math.max(0, (L.h * L.s - L.ch) / 2) + L.ch * 0.25;
    this.panX = Math.max(-mx, Math.min(mx, this.panX));
    this.panY = Math.max(-my, Math.min(my, this.panY));
  },

  zoomAt(x, y, factor) {
    const L = this.layout();
    if (!L) return;
    const z = Math.max(1, Math.min(8, this.zoom * factor));
    const k = z / this.zoom;
    this.panX = x - L.cw / 2 - (x - L.cw / 2 - this.panX) * k;
    this.panY = y - L.ch / 2 - (y - L.ch / 2 - this.panY) * k;
    this.zoom = z;
    this.clampPan();
    this.draw();
  },

  panBy(dx, dy) { this.panX += dx; this.panY += dy; this.clampPan(); this.draw(); },

  zoomTo(c) {
    const L = this.layout();
    if (!L) return;
    // Zoom so the mark fills about 40% of the stage, centred on it.
    const fit = L.s / this.zoom;
    const extent = Math.max(c.w * L.w, c.h * L.h, 4) * fit;
    const z = Math.max(1, Math.min(6, (0.4 * Math.min(L.cw, L.ch)) / extent));
    this.zoom = z;
    this.panX = -(c.x + c.w / 2 - 0.5) * L.w * fit * z;
    this.panY = -(c.y + c.h / 2 - 0.5) * L.h * fit * z;
    this.clampPan();
  },

  /* ----- pointer gestures: one finger pans, two pinch; a tap selects a mark */
  onDown(e) {
    this.canvas.setPointerCapture && this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.gesture = { start: Date.now(), moved: 0, x: e.clientX, y: e.clientY };
  },
  onMove(e) {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const pts = [...this.pointers.values()];
    if (this.pointers.size === 2) {
      const other = pts.find((p) => p !== prev);
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      const r = this.canvas.getBoundingClientRect();
      if (d0 > 0) this.zoomAt((e.clientX + other.x) / 2 - r.left, (e.clientY + other.y) / 2 - r.top, d1 / d0);
    } else {
      this.panBy(e.clientX - prev.x, e.clientY - prev.y);
    }
    if (this.gesture) this.gesture.moved += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  },
  onUp(e) {
    const g = this.gesture;
    this.pointers.delete(e.pointerId);
    if (g && this.pointers.size === 0 && g.moved < 8 && Date.now() - g.start < 400) {
      const r = this.canvas.getBoundingClientRect();
      this.tapAt(e.clientX - r.left, e.clientY - r.top);
    }
    if (!this.pointers.size) this.gesture = null;
  },
  tapAt(x, y) {
    const L = this.layout();
    const m = this.visibleMarks();
    if (!L || !m.length) return;
    const u = (x - L.x0) / (L.w * L.s), v = (y - L.y0) / (L.h * L.s);
    const pad = 14 / (L.w * L.s);
    const hit = m.find((c) => u >= c.x - pad && u <= c.x + c.w + pad && v >= c.y - pad && v <= c.y + c.h + pad);
    if (hit) this.select(hit.id);
  },

  visibleMarks() {
    const m = state.marks[this.side];
    const src = this.src();
    if (!m || !m.candidates || !src || m.rev !== src.rev) return [];
    return m.candidates;
  },

  select(id, { zoom = true } = {}) {
    this.selected = id;
    const c = this.visibleMarks().find((x) => x.id === id);
    if (c && zoom) this.zoomTo(c);
    this.render();
    const btn = $(`#sv-list button[data-id="${CSS.escape(id)}"]`);
    if (btn) btn.focus({ preventScroll: true });
  },

  /* ----- filters (view only) */
  filterKey(kind, src) { return `${this.side}|${src.kind}|${src.rev}|${kind}|${kind === "original" ? 0 : this.intensity}`; },

  /** The filtered image for `kind`, or null while it's computed (the canvas redraws when it arrives). */
  filtered(kind) {
    const src = this.src();
    if (!src || kind === "original") return null;
    const key = this.filterKey(kind, src);
    if (this.cache.has(key)) return this.cache.get(key);
    if (!this.filterAvailable(kind).ok) return null;
    if (this.pendingKey === key) return null;
    this.pendingKey = key;
    this.filterBusy = true;
    this.filterError = "";
    const token = { card: state.cardRev, side: this.side, rev: src.rev, key };
    // Only the newest request is kept (coalesced), so dragging the slider never queues stale previews. The scan
    // is sent as a copy (never transferred): a filter only ever produces a new image for this view.
    const payload = { src: src.result.warped, kind, intensity: this.intensity / 100 };
    if (kind === "difference") payload.reference = this.diffReference().reference;
    runner().run("filter", payload, { coalesceKey: "filter" })
      .then((out) => {
        if (token.card !== state.cardRev || this.pendingKey !== key) return;
        this.pendingKey = null;
        this.filterBusy = false;
        const cur = this.src();
        if (!cur || cur.rev !== token.rev) return;
        if (out && out.unavailable) throw new Error(out.reason || "This filter isn't available for this photo.");
        const img = out && out.data ? out : out && out.image;
        if (!img || !img.data) throw new Error("The filter returned no image.");
        if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, canvasFromRGBA({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }));
        this.render();
      })
      .catch((err) => {
        if (isStale(err)) return;
        if (this.pendingKey === key) { this.pendingKey = null; this.filterBusy = false; this.filterError = (err && err.message) || "The filter couldn't run."; this.render(); }
      });
    return null;
  },

  /* ----- possible marks */
  async findMarks() {
    const src = this.src();
    if (!src) return;
    const side = this.side;
    const token = { card: state.cardRev, side, rev: src.rev, kind: src.kind };
    const base = src.kind === "photo" ? state.scans[side] : null;
    // A reference that lines up with the photo lets printed structure be told apart from marks.
    const cmp = side === "front" && src.kind === "photo" ? this.refCompare() : null;
    const options = {
      quality: base ? base.quality : null, check: base ? base.check : null, side, revision: src.rev,
      reference: cmp && cmp.ok ? cmp : null,
      maxCandidates: 12, timeBudgetMs: 4000,
    };
    if (side === "front" && state.reference && state.reference.usable && state.reference.rgba) {
      try { options.printedMask = Identify.printedMask(state.reference.rgba, src.result.warped, src.margin); } catch (_) { /* no mask */ }
    }
    state.marks[side] = { status: "running", rev: src.rev, source: src.kind, candidates: [], cannotAssess: [], note: "" };
    this.selected = null;
    this.render();
    let res;
    try {
      res = await runner().run("marks", { scan: src.result, ...options }, { coalesceKey: `marks-${side}`, supersede: true });
    } catch (err) {
      if (isStale(err)) return;
      res = { status: "error", candidates: [], cannotAssess: [], note: err && err.timeout ? "Looking for marks took too long. Try again." : (err && err.message) || "Mark finding failed." };
    }
    const cur = this.src();
    if (token.card !== state.cardRev || !state.marks[side] || state.marks[side].rev !== token.rev || (this.side === side && cur && cur.rev !== token.rev && cur.kind === token.kind)) return;
    state.marks[side] = {
      status: res.status || "done", rev: token.rev, source: token.kind, note: res.note || "",
      // Candidates are transient: they never enter grading, drafts, History or backups.
      candidates: (res.candidates || []).map((c, i) => ({ ...c, id: String(c.id != null ? c.id : i + 1), side, revision: token.rev, status: "pending" })),
      cannotAssess: res.cannotAssess || [],
    };
    this.render();
    renderSurfacePane();
    const n = state.marks[side].candidates.length;
    announce(n ? `${n} possible mark${n === 1 ? "" : "s"} found. None is counted until you add it as a defect.` : res.status === "unavailable" ? res.note : "No visible marks found in this photo.");
  },

  isAdded(c) {
    return state.defects.some((d) => d.region && d.side === c.side && d.scan_revision === c.revision && d.region.x === c.x && d.region.y === c.y && d.region.w === c.w && d.region.h === c.h);
  },
  statusOf(c) { return this.isAdded(c) ? "added" : c.status === "added" ? "pending" : c.status || "pending"; },

  /* ----- drawing */
  draw() {
    const { ctx, canvas } = this;
    const L = this.layout();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $("#sv-empty").hidden = !!L;
    $("#sv-zoom").textContent = `${this.zoom < 1.95 ? this.zoom.toFixed(1) : Math.round(this.zoom)}×`;
    if (!L) return;
    ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
    const m = L.src.margin;
    const shown = this.showFiltered && this.kind !== "original" ? this.filtered(this.kind) : null;
    ctx.imageSmoothingEnabled = L.s < 2.5;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(shown || L.src.img, m, m, L.w, L.h, L.x0, L.y0, L.w * L.s, L.h * L.s);
    const marks = this.marksForDraw();
    const X = (u) => L.x0 + u * L.w * L.s, Y = (v) => L.y0 + v * L.h * L.s;
    ctx.save();
    for (const r of marks.cannot) {
      ctx.fillStyle = "rgba(128, 128, 136, 0.35)";
      ctx.fillRect(X(r.x), Y(r.y), r.w * L.w * L.s, r.h * L.h * L.s);
    }
    marks.list.forEach((c, i) => {
      const sel = c.id === this.selected;
      const st = this.statusOf(c);
      const x = X(c.x), y = Y(c.y), w = Math.max(6, c.w * L.w * L.s), h = Math.max(6, c.h * L.h * L.s);
      ctx.setLineDash(st === "dismissed" ? [5, 4] : []);
      ctx.lineWidth = sel ? 4 : 2.5;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
      ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
      ctx.lineWidth = sel ? 2.5 : 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
      ctx.setLineDash([]);
      const r = 11, bx = x - 3, by = y - 3;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = sel ? "#ffffff" : "#111114";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = sel ? "#111114" : "#ffffff";
      ctx.stroke();
      ctx.fillStyle = sel ? "#111114" : "#ffffff";
      ctx.font = "700 12px -apple-system, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), bx, by + 0.5);
    });
    ctx.restore();
  },

  marksForDraw() {
    const m = state.marks[this.side];
    const src = this.src();
    if (!m || !src || m.rev !== src.rev) return { list: [], cannot: [] };
    return { list: m.candidates || [], cannot: m.cannotAssess || [] };
  },

  cropTo(canvasEl, img, c, src) {
    const ctx = canvasEl.getContext("2d");
    const size = 160;
    canvasEl.width = size;
    canvasEl.height = size;
    ctx.clearRect(0, 0, size, size);
    if (!img) return;
    const m = src.margin, w = src.width - 2 * m, h = src.height - 2 * m;
    // Tight enough that a thin line stays visible at crop size, with some surroundings for context.
    const side = Math.max(48, Math.max(c.w * w, c.h * h) * 1.35);
    const cx = m + (c.x + c.w / 2) * w, cy = m + (c.y + c.h / 2) * h;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
  },

  /* ----- panel */
  render() {
    if (!this.canvas) return;
    if (!this.isOpen()) return;
    const src = this.src();
    $$("[data-sv-side]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.svSide === this.side)));
    const hasAngled = !!(state.angled[this.side] && state.angled[this.side].result);
    $("#sv-source").hidden = !hasAngled;
    if (!hasAngled) this.source = "photo";
    $$("[data-sv-source]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.svSource === this.source)));
    // Filter toolbar
    const notes = [];
    for (const b of $$("#sv-filters button")) {
      const av = this.filterAvailable(b.dataset.kind);
      b.disabled = !av.ok || !src;
      b.setAttribute("aria-checked", String(b.dataset.kind === this.kind));
      b.title = av.ok ? "" : av.why;
      if (!av.ok && b.dataset.kind === "difference" && surfaceApi()) notes.push(`Color difference: ${av.why}`);
      if (!av.ok && b.dataset.kind === "grayscale") notes.push(av.why);
    }
    if (!this.filterAvailable(this.kind).ok) { this.kind = "original"; this.showFiltered = false; }
    $$("[data-sv-view]").forEach((b) => {
      b.setAttribute("aria-checked", String((b.dataset.svView === "filtered") === (this.showFiltered && this.kind !== "original")));
      if (b.dataset.svView === "filtered") b.disabled = this.kind === "original";
    });
    if (this.filterBusy && this.showFiltered) notes.push("Applying filter…");
    if (this.filterError && this.showFiltered) notes.push(this.filterError);
    $("#sv-filter-note").textContent = notes.join(" ");
    $("#sv-intensity-row").hidden = ["original", "invert"].includes(this.kind);
    // Marks
    const m = state.marks[this.side];
    const fresh = m && src && m.rev === src.rev;
    const running = fresh && m.status === "running";
    $("#sv-find").disabled = !src || running;
    $("#sv-find span").textContent = running ? "Looking for possible marks…" : fresh && !["running", "unavailable", "error"].includes(m.status) ? "Find possible marks again" : "Find possible marks";
    const status = $("#sv-status");
    const list = $("#sv-list");
    list.innerHTML = "";
    const detail = $("#sv-detail");
    detail.hidden = true;
    detail.innerHTML = "";
    if (!src) status.textContent = `No ${this.side} photo to inspect. Add one on the Scan screen.`;
    else if (!fresh) status.textContent = m && m.rev !== src.rev ? "The photo changed, so earlier marks were cleared. Look again." : "Looks for spots that stand out from the card's print. Nothing is counted until you add it as a defect.";
    else if (running) status.textContent = "Looking for possible marks…";
    else if (m.status === "unavailable" || m.status === "error") status.textContent = m.note || "Mark finding isn't available.";
    else if (m.status === "cannot_assess" && !m.candidates.length) status.textContent = m.note || "This photo can't show the surface well enough to look for marks. Retake it, or check the card in hand.";
    else if (!m.candidates.length) {
      status.textContent = "No visible marks found in this photo.";
      detail.hidden = false;
      const p = document.createElement("p");
      p.className = "footnote tight";
      p.textContent = `${m.note ? `${m.note} ` : ""}That doesn't mean the surface is flawless: it stays unchecked until you check the card in hand under angled light (Surface → Check in hand).`;
      detail.append(p);
      if (src.kind === "photo") {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn tinted wide";
        b.textContent = "Add angled-light photo";
        b.addEventListener("click", () => { state.activeSide = this.side; $("#angled-file").click(); });
        detail.append(b);
      }
    } else {
      const open = m.candidates.filter((c) => this.statusOf(c) === "pending").length;
      status.textContent = `${m.candidates.length} possible mark${m.candidates.length === 1 ? "" : "s"} · ${open} to review. ${m.note || "Detection confidence is an uncalibrated heuristic, not a measurement."}${m.status === "timeout" ? " The search stopped at its time limit: run it again to finish." : ""}`;
      m.candidates.forEach((c, i) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.id = c.id;
        b.setAttribute("aria-pressed", String(c.id === this.selected));
        const st = this.statusOf(c);
        const typeLabel = (c.suggestedTypes || []).map((t) => CRITERIA.defects.types[t] && CRITERIA.defects.types[t].label).filter(Boolean)[0];
        b.innerHTML = `<span class="mark-no" aria-hidden="true">${i + 1}</span><span class="m-text"><span class="m-title"></span><span class="m-sub"></span></span><span class="m-state"></span>`;
        $(".m-title", b).textContent = `Possible mark ${i + 1}${typeLabel ? ` · looks like ${typeLabel.toLowerCase()}` : ""}`;
        $(".m-sub", b).textContent = `Detection confidence: ${cap(c.detection || "low")}`;
        $(".m-state", b).textContent = MARK_STATE_TEXT[st];
        b.addEventListener("click", () => this.select(c.id));
        li.append(b);
        list.append(li);
      });
      const sel = m.candidates.find((c) => c.id === this.selected);
      if (sel) this.renderDetail(sel, m.candidates.indexOf(sel), src);
    }
    // Redrawing replaced the focused control: keep keyboard focus on the selected mark.
    if (topDialog() === "#surface-viewer" && (!document.activeElement || document.activeElement === document.body)) {
      const f = $('#sv-list [aria-pressed="true"]') || $("#sv-find");
      if (f) f.focus({ preventScroll: true });
    }
    $("#sv-runner-note").hidden = !(runnerInstance && runnerInstance.mode === "main-thread");
    $("#sv-runner-note").textContent = runnerInstance ? runnerInstance.unavailableReason || "" : "";
    this.draw();
  },

  renderDetail(c, i, src) {
    const box = $("#sv-detail");
    box.hidden = false;
    const st = this.statusOf(c);
    const cropKind = this.kind !== "original" ? this.kind : (this.filterAvailable("contrast").ok ? "contrast" : null);
    const cropLabel = cropKind ? SURFACE_FILTERS.find(([k]) => k === cropKind)[1] : "Filtered";
    box.innerHTML = `<b></b><div class="mark-crops"><figure><canvas aria-hidden="true"></canvas><figcaption>Original</figcaption></figure><figure><canvas aria-hidden="true"></canvas><figcaption></figcaption></figure></div>
      <p class="footnote tight m-conf"></p><p class="footnote tight m-reason"></p>
      <div class="mark-actions"><button type="button" class="btn filled">Add defect</button><button type="button" class="btn tinted">Dismiss</button><button type="button" class="btn tinted">Check in hand</button></div>`;
    $("b", box).textContent = `Possible mark ${i + 1} · ${MARK_STATE_TEXT[st]}`;
    $$("figcaption", box)[1].textContent = cropLabel;
    const [a, b] = $$("canvas", box);
    this.cropTo(a, src.img, c, src);
    this.cropTo(b, cropKind ? this.filtered(cropKind) : null, c, src);
    const note = String(c.detectionNote || "").replace(/\.+$/, "");
    const heuristic = /uncalibrated/i.test(note) ? "" : " An uncalibrated heuristic: it says how clearly the photo shows something, not how bad it is.";
    $(".m-conf", box).textContent = `Detection confidence: ${cap(c.detection || "low")}${note ? ` · ${note}` : ""}.${heuristic}`;
    $(".m-reason", box).textContent = c.reason || "";
    const [add, dismiss, inHand] = $$(".mark-actions button", box);
    add.disabled = st === "added";
    add.addEventListener("click", () => openSheet(c.side, "surface", { mark: c, opener: add }));
    dismiss.addEventListener("click", () => { c.status = "dismissed"; this.render(); renderSurfacePane(); });
    inHand.addEventListener("click", () => {
      c.status = "check_in_hand";
      toast("Check this spot on the card in hand, then record it in Surface → Check in hand.");
      this.render();
      renderSurfacePane();
    });
  },
};

/* ---------------------------------------------------------------- angled-light photo (view only) */

async function addAngledPhoto(side, file) {
  const s = state.scans[side];
  const token = { card: state.cardRev, side, rev: s ? s.rev : "" };
  state.angled[side] = { status: "busy" };
  renderSurfacePane();
  try {
    const pixels = await readImage(file);
    if (token.card !== state.cardRev) return;
    const out = await runner().run("scan", scanPayload(pixels, side), { coalesceKey: `angled-${side}` });
    if (token.card !== state.cardRev || (state.scans[side] ? state.scans[side].rev : "") !== token.rev) return;
    const scan = out.scan;
    // Only for looking at: it never changes centering, confidence, photo limits or grades.
    state.angled[side] = { status: "ready", img: canvasFromRGBA(scan.warped), result: scan, margin: scan.margin, width: scan.width, height: scan.height, rev: newRev() };
    assessConfidence(side);   // the rating notes that angled light is available for this side
    renderConfidence();
    toast(`Angled-light photo added for the ${side}. Switch to it in Inspect surface.`);
  } catch (err) {
    if (isStale(err)) return;
    if (token.card === state.cardRev) { state.angled[side] = null; toast((err && err.message) || "Couldn't use this photo."); }
  }
  renderSurfacePane();
  if (sv.isOpen()) { if (state.angled[side]) { sv.side = side; sv.source = "angled"; } sv.render(); }
}

/* ---------------------------------------------------------------- init */

function bindFile(input, handler) {
  input.addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) handler(f);
  });
}

function init() {
  guide.init();
  viewer.init();
  sv.init();
  for (const fig of $$(".map")) buildMap(fig, fig.dataset.side);
  applyTheme(localStore.read(KEYS.theme, "system"), { remember: false });

  // Tabs
  $$(".tabbar button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  // Scan
  $$("#game-seg button").forEach((b) => b.addEventListener("click", () => setGame(b.dataset.game)));
  setGame(localStore.read(KEYS.game, "pokemon"), { remember: false });
  for (const side of SIDES) {
    bindFile($(`#file-${side}`), (f) => scanFile(side, f));
    bindFile($(`#camera-${side}`), (f) => scanFile(side, f));
  }
  $("#review-card").addEventListener("click", () => setView("report"));
  $("#front-only").addEventListener("click", () => setView("report"));
  $("#try-example").addEventListener("click", showExample);
  $("#resume").addEventListener("click", () => {
    const draft = localStore.draft();
    if (draft) loadAssessment(draft, draft.thumbs);
  });
  armed($("#clear-card"), "Tap to confirm", newScan);

  // Review
  $("#back-to-scan").addEventListener("click", () => (state.example ? newScan() : setView("scan")));
  armed($("#new-scan"), "Tap again to start a new scan", newScan);
  $("#scan-own").addEventListener("click", newScan);
  $("#save-card").addEventListener("click", saveCard);
  $("#open-details").addEventListener("click", (e) => setDetailsEditing(true, e.currentTarget));
  $("#done-details").addEventListener("click", () => setDetailsEditing(false));
  $$("[data-pane]").forEach((b) => b.addEventListener("click", () => pushPane(b.dataset.pane, b)));
  $$("[data-pop]").forEach((b) => b.addEventListener("click", popPane));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.goto)));
  $("#open-subgrades").addEventListener("click", (e) => pushPane("pane-company", e.currentTarget));
  for (const id of ["#open-surface", "#pane-open-surface"]) $(id).addEventListener("click", (e) => sv.open(state.activeSide, e.currentTarget));
  $("#go-checklist").addEventListener("click", (e) => pushPane("pane-defects", e.currentTarget));
  document.addEventListener("click", (e) => {
    const act = e.target.closest("[data-conf-action]");
    if (act) { confAction(act.dataset.confAction, act.dataset.side); return; }
    const sideBtn = e.target.closest(".side-seg button");
    if (sideBtn) {
      if (guide.outline) setOutlineMode(false);
      state.activeSide = sideBtn.dataset.side;
      renderCentering();
    }
  });
  // Inspection checklist rows are redrawn as the grade changes; one listener handles all of them.
  document.addEventListener("change", (e) => {
    const box = e.target.closest("input[type=checkbox][data-comp]");
    if (box) setInspected(box.dataset.side, box.dataset.comp, box.checked);
  });
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
  bindFile($("#retake-file"), (f) => scanFile(state.activeSide, f));
  bindFile($("#angled-file"), (f) => addAngledPhoto(state.activeSide, f));
  fillSelect($("#card-finish"), FINISHES);
  fillSelect($("#card-language"), ["", ...Object.keys(LANGUAGES)], { "": "—", ...LANGUAGES });
  $("#card-language").value = "EN";
  for (const id of ["card-name", ...Object.keys(DETAIL_FIELDS)]) {
    $(`#${id}`).addEventListener("input", () => { leaveExample(); renderDetails(); saveDraft(); renderPriceMeta(); });
    $(`#${id}`).addEventListener("change", () => { leaveExample(); renderDetails(); saveDraft(); renderPriceMeta(); });
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
  $("#read-card").addEventListener("click", () => readFromPhoto());
  $("#refresh-prices").addEventListener("click", () => { loadPrices({ force: true }); loadCardSight({ force: true }); loadRiftPrices(); });
  $("#web-search").addEventListener("click", webSearch);
  $("#clear-reference").addEventListener("click", () => { clearReference(); setStatus("Reference removed."); });
  // A reference only belongs to the card it was confirmed for: changing what identifies the card drops it.
  for (const id of ["card-set-code", "card-number", "card-language"]) {
    $(`#${id}`).addEventListener("input", () => { if (state.reference && state.reference.source !== "user") { clearReference(); setStatus("Details changed: find the card again to get its reference."); } });
  }

  // Settings
  $$("#theme-seg button").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeChoice)));
  $("#cs-save").addEventListener("click", saveCardSightKey);
  $("#cs-remove").addEventListener("click", removeCardSightKey);
  $("#pc-save").addEventListener("click", savePriceToken);
  $("#pc-remove").addEventListener("click", removePriceToken);
  $("#gm-save").addEventListener("click", saveGeminiKey);
  $("#gm-remove").addEventListener("click", removeGeminiKey);
  for (const m of WebPrices.MODELS) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    $("#gm-model").append(o);
  }
  $("#gm-model").value = gmModel();
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
  bindFile($("#restore-file"), async (f) => restoreFrom(await f.text()));
  $("#restore-text").addEventListener("click", () => restoreFrom($("#backup-text").value));

  // Sheets
  $$("#sev-seg button").forEach((b) => b.addEventListener("click", () => { state.sheet.severity = b.dataset.sev; updateSheet(); }));
  $("#sheet-add").addEventListener("click", addDefectFromSheet);
  $("#sheet-cancel").addEventListener("click", closeSheet);
  $("#defect-sheet").addEventListener("click", (e) => { if (e.target.id === "defect-sheet") closeSheet(); });
  $("#details-sheet").addEventListener("click", (e) => { if (e.target.id === "details-sheet") setDetailsEditing(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const top = topDialog();
    if (top === "#surface-viewer") sv.close();
    else if (top) closeDialog(top);
    else if (guide.outline) setOutlineMode(false);
    else if (state.pane) popPane();
  });

  setView("scan", { animate: false, focus: false });
}

init();
