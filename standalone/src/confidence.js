/*
 * Scan confidence: how well ONE PHOTO supports inspecting a card face.
 *
 * This is not the chance that a grade is right, and it is never a number or a percentage. It only says how
 * much of the inspection this photo can carry, from evidence the other modules already produce:
 *   scan     Vision.scan(...)            confidence.card (outline detector), confidence.per_side (border reads)
 *   quality  Inspect.quality(img, scan)  checks.resolution / sharpness / glare (incl. where) / boundary /
 *                                        perspective / detection / sleeve, blocked, blocked_reasons
 *   check    Inspect.edgesAndCorners()   sides[side].assessable/reason, corners[i].assessable/reason
 *   evidence {lr, tb}: "measured" | "unread" | "typed" (the app's centering evidence for this face)
 *   outlineAdjusted  true when the outline was dragged onto the card by hand (the detector is then moot)
 *   angledLight      (added, optional) true only when this photo was taken under raking / angled light
 * Checking the card in hand is deliberately NOT an input: it completes the evidence, it doesn't make the photo
 * any better. Filters / previews are not an input either, so a filter can never change confidence.
 *
 * API (global ScanConfidence, or module.exports in Node):
 *   assess({scan, quality, check, evidence, outlineAdjusted, angledLight}) -> SideConfidence
 *   notScanned() -> SideConfidence (level "not_scanned")       assessing() -> SideConfidence (level "assessing")
 *   combine(front, back) -> {level, label, reasons, missing: [sides], pending: [sides], sides: {front, back}, summary}
 *   LEVELS {level: label}, ORDER (weakest first), THRESHOLDS (the table T below), RULES (rule id -> text)
 *
 * SideConfidence = {
 *   level: "high" | "medium" | "low" | "cannot_assess" | "not_scanned" | "assessing",
 *   label: "High" | "Medium" | "Low" | "Cannot assess" | "Not scanned" | "Assessing scan…",
 *   areas: { outline, centering, corners_edges, surface_visibility }: each {level, reason}
 *          (additions: outline.adjusted; centering.unread: ["lr"|"tb"]; corners_edges.blocked: ["top edge",
 *          "top-right corner", ...], corners_edges.groups: {reason: [where]}, corners_edges.photoFailure;
 *          surface_visibility.limited),
 *   surfaceLimited: bool, summary: one plain sentence, reasons: [string],
 *   actions: [{id: "retake" | "adjust_outline" | "angled_light", label}],
 *   covered: [area ids the overall level speaks for], notCovered: [area ids it can't speak for],
 *   rules: [rule ids from RULES that set or capped the level]          (covered / notCovered / rules are additions)
 * }
 *
 * How the overall level is formed (no averaging of unrelated scores):
 *   1. Each area gets a level from its own evidence (per-area rules below).
 *   2. Hard fails: outline cannot_assess -> overall cannot_assess (R_OUTLINE); centering AND corners/edges both
 *      cannot_assess -> overall cannot_assess (R_NOTHING).
 *   3. Overall = the WEAKEST of the areas it claims to cover (outline, centering, corners_edges that are not
 *      cannot_assess). An area that can't be assessed is listed in notCovered and named in the summary; missing or
 *      unsupported evidence (an unread border, a full-art card) is "not covered", never "low".
 *   4. Caps: corners/edges lost to a photo failure (resolution, focus, angle, outline, every spot blocked) -> at most
 *      low (R_CE_FAIL); surface lost to a photo failure -> at most low (R_SURFACE_FAIL); a flat photo can't show the
 *      surface -> surfaceLimited and at most medium (R_FLAT), with "limited — surface needs inspection" in the summary.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ScanConfidence = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LEVELS = {
    high: "High", medium: "Medium", low: "Low", cannot_assess: "Cannot assess",
    not_scanned: "Not scanned", assessing: "Assessing scan…",
  };
  const ORDER = ["cannot_assess", "low", "medium", "high"];  // weakest first (assessed levels only)
  const rank = (l) => ORDER.indexOf(l);
  const weakest = (levels) => levels.reduce((a, b) => (rank(b) < rank(a) ? b : a), "high");
  const cap = (level, max) => (rank(level) > rank(max) ? max : level);

  /*
   * The one threshold table. Photo-quality cut-offs themselves (blur, glare, resolution, angle, detector
   * confidence) are NOT repeated here: this module reads Inspect.quality's ok / warn / fail statuses, so there is
   * one source of truth for them (inspect.js T). These are proposals, not fitted to graded cards.
   */
  const T = {
    // Border read of one centering axis = the weaker of its two sides' scan.confidence.per_side.
    axisHigh: 0.6,          // at or above: high
    axisMedium: 0.3,        // at or above: medium (0.3 is also where the app calls a side "read"); below: low
    // Corners / edges: how many of the 8 locations (4 edges, 4 corners) the edge/corner check could not assess.
    ceMediumMax: 2,         // 1..2 not assessable -> medium
    ceLowMax: 7,            // 3..7 -> low; all 8 -> cannot_assess
    // Quality status -> the most an area can be.
    status: { ok: "high", warn: "medium", fail: "cannot_assess" },
    perspectiveFail: "low", // a strongly tilted photo still has a usable outline, but not a trustworthy one
    flatSurface: "low",     // surface visibility of a flat (not angled-light) photo
    flatCap: "medium",      // ... caps the overall level at this (R_FLAT)
    failCap: "low",         // R_CE_FAIL / R_SURFACE_FAIL cap
  };

  const RULES = {
    R_NO_SCAN: "No photo for this face.",
    R_OUTLINE: "The card outline isn't usable, so nothing on this photo can be assessed.",
    R_NOTHING: "Neither centering nor corners/edges can be assessed from this photo.",
    R_WEAKEST: "Overall is the weakest of the areas it covers.",
    R_CE_FAIL: "Corners and edges were lost to a photo problem: overall at most low.",
    R_SURFACE_FAIL: "The surface is hidden by a photo problem: overall at most low.",
    R_FLAT: "A flat photo can't show the surface: overall at most medium.",
  };

  const AREAS = ["outline", "centering", "corners_edges", "surface_visibility"];
  const SIDES = ["top", "right", "bottom", "left"];
  const CORNERS = ["top_left", "top_right", "bottom_right", "bottom_left"];
  const pretty = (s) => String(s).replace(/_/g, "-");
  const listText = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const area = (level, reason, extra) => Object.assign({ level, reason }, extra || {});
  const statusOf = (quality, name) => (quality && quality.checks && quality.checks[name] ? quality.checks[name].status : null);
  const REASON_TEXT = {
    glare: "glare", resolution: "low resolution", sharpness: "soft focus", boundary: "the card is cut off",
    perspective: "the photo is at an angle", detection: "uncertain outline",
  };
  const why = (list) => listText((list || []).map((r) => REASON_TEXT[r] || r));

  function blank(level, summary) {
    const a = {};
    for (const k of AREAS) a[k] = area(level, summary);
    return { level, label: LEVELS[level], areas: a, surfaceLimited: false, summary, reasons: [], actions: [], covered: [], notCovered: [], rules: level === "not_scanned" ? ["R_NO_SCAN"] : [] };
  }
  const notScanned = () => blank("not_scanned", "Not scanned yet.");
  const assessing = () => blank("assessing", "Assessing scan…");

  /* ------------------------------------------------------------- areas */

  function outlineArea(scan, quality, adjusted) {
    const boundary = statusOf(quality, "boundary"), persp = statusOf(quality, "perspective");
    let detect = statusOf(quality, "detection");
    if (!detect) {  // no quality result: read the detector directly, at Inspect's default cut-offs
      const c = scan.confidence && scan.confidence.card != null ? scan.confidence.card : 0;
      detect = c < 0.5 ? "fail" : c < 0.7 ? "warn" : "ok";
    }
    if (adjusted) detect = "ok";  // placed on the card by hand: the detector's doubt no longer applies
    const notes = [];
    let level = "high";
    if (boundary === "fail") { level = "cannot_assess"; notes.push(quality.checks.boundary.note); }
    if (detect === "fail") { level = "cannot_assess"; notes.push("The card's outline wasn't found reliably; drag the outline onto the card's edges or retake."); }
    if (level !== "cannot_assess") {
      if (persp === "fail") { level = cap(level, T.perspectiveFail); notes.push("The photo is strongly tilted, so the flattened card is distorted."); }
      else if (persp === "warn") { level = cap(level, "medium"); notes.push("The photo is slightly tilted."); }
      if (boundary === "warn") { level = cap(level, "medium"); notes.push(quality.checks.boundary.note); }
      if (detect === "warn") { level = cap(level, "medium"); notes.push("The outline is a little uncertain; check it lines up with the card's edges."); }
    }
    const reason = notes.length ? notes.join(" ") : adjusted ? "Outline set by hand on the card's edges." : "Card outline found clearly.";
    return area(level, reason, { adjusted: !!adjusted });
  }

  function centeringArea(scan, quality, evidence) {
    const blocked = quality && quality.blocked_reasons && quality.blocked_reasons.centering;
    if (blocked) return area("cannot_assess", `Centering can't be measured: ${why(blocked)}.`, { unread: ["lr", "tb"] });
    const per = (scan.confidence && scan.confidence.per_side) || {};
    const ev = evidence || {};
    const axes = { lr: ["left", "right", "left/right"], tb: ["top", "bottom", "top/bottom"] };
    const read = [], unread = [], notes = [];
    for (const [axis, [a, b, name]] of Object.entries(axes)) {
      if (ev[axis] !== "measured") {
        unread.push(axis);
        notes.push(ev[axis] === "typed" ? `${name} centering was typed in, not read from this photo.` : `${name} border not read from this photo.`);
        continue;
      }
      const c = Math.min(per[a] != null ? per[a] : 0, per[b] != null ? per[b] : 0);
      const lv = c >= T.axisHigh ? "high" : c >= T.axisMedium ? "medium" : "low";
      if (lv === "medium") notes.push(`${name} border read, but faintly on one side.`);
      if (lv === "low") notes.push(`${name} border barely visible: check the guides line up with the printed frame.`);
      read.push(lv);
    }
    if (!read.length) return area("cannot_assess", "No border could be read from this photo, so centering isn't measured (full-art card, glare or a faint frame).", { unread });
    return area(weakest(read), notes.length ? notes.join(" ") : "Both borders read clearly.", { unread });
  }

  function cornersEdgesArea(quality, check) {
    const res = statusOf(quality, "resolution"), sharp = statusOf(quality, "sharpness"), sleeve = quality && quality.checks && quality.checks.sleeve;
    if (res === "fail") return area("cannot_assess", "The card is too small in the photo to see edge and corner wear.", { blocked: ["all"], photoFailure: true });
    if (sharp === "fail") return area("cannot_assess", "The photo is too blurry to see edge and corner wear.", { blocked: ["all"], photoFailure: true });
    if (!check || !check.sides || !check.corners) return area("cannot_assess", "The edge and corner check didn't run on this photo.", { blocked: ["all"], photoFailure: false });
    const blocked = [], groups = {};
    const add = (name, reason) => { blocked.push(name); (groups[reason || "unclear"] = groups[reason || "unclear"] || []).push(name); };
    for (const s of SIDES) if (check.sides[s] && !check.sides[s].assessable) add(`${s} edge`, check.sides[s].reason);
    for (const c of check.corners) if (!c.assessable) add(`${pretty(c.location)} corner`, c.reason);
    const n = blocked.length;
    let level = n === 0 ? "high" : n <= T.ceMediumMax ? "medium" : n <= T.ceLowMax ? "low" : "cannot_assess";
    const notes = Object.entries(groups).map(([reason, where]) => `${reason}: ${listText(where)}`);
    if (res === "warn") { level = cap(level, "medium"); notes.push("the card is fairly small in the photo, so fine wear can be missed"); }
    if (sharp === "warn") { level = cap(level, "medium"); notes.push("the photo is slightly soft"); }
    if (sleeve && sleeve.value) { level = cap(level, "medium"); notes.push("seen through a sleeve or slab"); }
    const photoFailure = level === "cannot_assess" && Object.keys(groups).some((r) => /glare|resolution|sharpness|perspective|detection|boundary/.test(r));
    const reason = notes.length ? `${notes.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()) : "All four edges and corners can be checked.";
    return area(level, reason, { blocked, groups, photoFailure });
  }

  function surfaceArea(quality, angled) {
    const blocked = quality && quality.blocked_reasons && quality.blocked_reasons.surface;
    if (blocked) return area("cannot_assess", `The surface can't be seen: ${why(blocked)}.`, { limited: true });
    if (!angled) return area(T.flatSurface, "Limited: a flat photo can show print spots and stains, but not scratches, dents, creases or gloss loss; those need angled light or a check in hand.", { limited: true });
    let level = "high";
    const notes = [];
    const WARN = { glare: "Some glare on the card.", sharpness: "The photo is slightly soft.", resolution: "The card is fairly small in the photo." };
    for (const name of Object.keys(WARN)) {
      if (statusOf(quality, name) === "warn") { level = cap(level, "medium"); notes.push(WARN[name]); }
    }
    return area(level, notes.length ? notes.join(" ") : "Angled light: scratches and dents can show.", { limited: false });
  }

  /* ------------------------------------------------------------- overall */

  function assess(input) {
    const { scan, quality = null, check = null, evidence = null, outlineAdjusted = false, angledLight = false } = input || {};
    if (!scan) return notScanned();
    const areas = {
      outline: outlineArea(scan, quality, outlineAdjusted),
      centering: centeringArea(scan, quality, evidence),
      corners_edges: cornersEdgesArea(quality, check),
      surface_visibility: surfaceArea(quality, angledLight),
    };
    const rules = [], reasons = [], actions = [];
    const surfaceLimited = !!areas.surface_visibility.limited;
    const main = ["outline", "centering", "corners_edges"];
    const covered = main.filter((k) => areas[k].level !== "cannot_assess");
    const notCovered = AREAS.filter((k) => areas[k].level === "cannot_assess");
    if (surfaceLimited && !notCovered.includes("surface_visibility")) notCovered.push("surface_visibility");

    let level;
    if (areas.outline.level === "cannot_assess") { level = "cannot_assess"; rules.push("R_OUTLINE"); }
    else if (areas.centering.level === "cannot_assess" && areas.corners_edges.level === "cannot_assess") { level = "cannot_assess"; rules.push("R_NOTHING"); }
    else {
      level = weakest(covered.map((k) => areas[k].level));
      rules.push("R_WEAKEST");
      if (areas.corners_edges.level === "cannot_assess" && areas.corners_edges.photoFailure && rank(level) > rank(T.failCap)) { level = T.failCap; rules.push("R_CE_FAIL"); }
      if (areas.surface_visibility.level === "cannot_assess" && rank(level) > rank(T.failCap)) { level = T.failCap; rules.push("R_SURFACE_FAIL"); }
      if (surfaceLimited) { level = cap(level, T.flatCap); rules.push("R_FLAT"); }
    }
    if (level === "cannot_assess") covered.length = 0;

    for (const k of AREAS) if (areas[k].level !== "high") reasons.push(areas[k].reason);

    // Actions: what would make the photo support more.
    const checks = (quality && quality.checks) || {};
    const failed = Object.values(checks).some((c) => c && c.status === "fail");
    const glareSpots = checks.glare && checks.glare.where ? Object.keys(checks.glare.where).filter((z) => checks.glare.where[z] >= 0.02) : [];
    if (failed || glareSpots.length || ["resolution", "sharpness"].some((n) => statusOf(quality, n) === "warn") || (checks.sleeve && checks.sleeve.value)) {
      actions.push({ id: "retake", label: "Retake photo" });
    }
    const outlineDoubt = areas.outline.level !== "high" && areas.outline.level !== "cannot_assess" ? true : areas.outline.level === "cannot_assess" && statusOf(quality, "detection") === "fail";
    const faintAxis = areas.centering.level === "low";
    if ((outlineDoubt || faintAxis || (statusOf(quality, "boundary") === "warn")) && !(outlineAdjusted && !faintAxis && areas.outline.level === "high")) {
      actions.push({ id: "adjust_outline", label: outlineAdjusted ? "Adjust outline again" : "Adjust outline" });
    }
    if (surfaceLimited) actions.push({ id: "angled_light", label: "Add an angled-light photo" });

    return { level, label: LEVELS[level], areas, surfaceLimited, summary: summarize(areas, surfaceLimited), reasons, actions, covered, notCovered, rules };
  }

  function summarize(areas, surfaceLimited) {
    const o = areas.outline;
    if (o.level === "cannot_assess") return "Card outline not usable: retake with the whole card in the frame, or drag the outline onto the card.";
    const parts = [];
    parts.push(o.adjusted && o.level === "high" ? "Outline set by hand" : o.level === "high" ? "Clear outline" : o.level === "medium" ? "Outline slightly uncertain" : "Outline unreliable (photo at an angle)");
    const c = areas.centering;
    if (c.level === "cannot_assess") parts.push("centering can't be measured from this photo");
    else if (c.unread && c.unread.length) parts.push(`${c.unread.map((a) => (a === "lr" ? "left/right" : "top/bottom")).join(" and ")} centering not read`);
    else if (c.level === "low") parts.push("borders are faint, so check the centering guides");
    const ce = areas.corners_edges;
    if (ce.level === "cannot_assess") {
      parts.push(ce.reason.replace(/\.$/, "").replace(/^The /, "the "));
    } else if (ce.groups) {
      for (const [reason, where] of Object.entries(ce.groups)) {
        parts.push(/glare/.test(reason) ? `glare obscures the ${listText(where)}` : `${listText(where)} not assessable (${reason})`);
      }
      if (/slightly soft/.test(ce.reason)) parts.push("slightly soft focus");
      if (/fairly small/.test(ce.reason)) parts.push("card is small in the frame");
      if (/sleeve/.test(ce.reason)) parts.push("seen through a sleeve or slab");
    }
    if (areas.surface_visibility.level === "cannot_assess") parts.push("the surface can't be seen");
    else if (surfaceLimited) parts.push("limited — surface needs inspection");
    const s = parts.join("; ");
    return s.charAt(0).toUpperCase() + s.slice(1) + ".";
  }

  /* ------------------------------------------------------------- both faces */

  /**
   * Front + back: the weaker ASSESSED face, never an average, and the faces with no photo listed in `missing`
   * (a missing back is never averaged away). Faces still being assessed are listed in `pending`.
   */
  function combine(front, back) {
    const sides = { front: front || notScanned(), back: back || notScanned() };
    const missing = [], pending = [], assessed = [];
    for (const [name, s] of Object.entries(sides)) {
      if (s.level === "not_scanned") missing.push(name);
      else if (s.level === "assessing") pending.push(name);
      else assessed.push([name, s]);
    }
    const reasons = [];
    let level;
    if (!assessed.length) level = pending.length ? "assessing" : "not_scanned";
    else {
      level = weakest(assessed.map(([, s]) => s.level));
      const worst = assessed.filter(([, s]) => s.level === level).map(([n]) => n);
      if (assessed.length > 1) reasons.push(`${listText(worst)} ${worst.length > 1 ? "are" : "is"} the weaker photo.`);
      for (const [n, s] of assessed) if (s.level !== "high") reasons.push(`${n[0].toUpperCase()}${n.slice(1)}: ${s.summary}`);
    }
    for (const n of missing) reasons.push(`${n[0].toUpperCase()}${n.slice(1)} not scanned: it isn't covered at all.`);
    for (const n of pending) reasons.push(`${n[0].toUpperCase()}${n.slice(1)} still being assessed.`);
    const summary = !assessed.length ? (pending.length ? "Assessing scan…" : "No photos yet.")
      : `${LEVELS[level]} on the ${assessed.length > 1 ? "weaker face" : assessed[0][0]}${missing.length ? `; ${listText(missing)} not scanned` : ""}.`;
    return { level, label: LEVELS[level], reasons, missing, pending, sides: { front: sides.front.level, back: sides.back.level }, summary };
  }

  return { assess, notScanned, assessing, combine, LEVELS, ORDER, THRESHOLDS: T, RULES };
});
