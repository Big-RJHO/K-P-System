/*
 * Card grading engine: a JavaScript port of the Python `cardgrader` package
 * (condition.py, centering.py, graders/*.py, engine.py).
 * tests/test_standalone_parity.py checks that both give identical results.
 * All rules come from the criteria object built from cardgrader/criteria/*.yaml.
 *
 * Assessment evidence (same shape and meaning as cardgrader/models.py; this project's convention,
 * not a grading company's rule):
 *   inspected:          {front: ["corners", ...], back: [...]}  components looked at; defects found are listed
 *   centering_evidence: {front: {lr, tb}, back: {lr, tb}}       "measured" | "typed" | "unread"
 * A component with no defects that wasn't inspected is unassessed (never assumed flawless); an unread
 * centering axis counts as at least 55/45 and is unassessed too. Then every company grade has
 * complete: false, unassessed: [...], tier: null and a ceiling grade/score labelled
 * "Up to <label> · incomplete"; the report has complete: false and best_fit: null.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Grading = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FLAWLESS = 10.5;
  const COMPONENTS = ["corners", "edges", "surface"];
  const SIDES = ["front", "back"];
  const CORNERS = ["top_left", "top_right", "bottom_left", "bottom_right"];
  const EDGES = ["top", "right", "bottom", "left"];
  const AXES = ["lr", "tb"];
  const EVIDENCE = ["measured", "typed", "unread"];
  // This project's convention: a centering axis nobody measured counts as just making Gem Mint (55/45).
  const UNREAD_SHARE = 55;
  const INCOMPLETE_NOTE =
    "\"Up to ... · incomplete\" is this lab's own convention for a card that hasn't been fully checked, " +
    "not a label any grading company uses.";
  const DISCLAIMER =
    "Theoretical estimate built from each company's published grading standards. " +
    "Not affiliated with or endorsed by PSA, Beckett, CGC or TAG. Real grades depend on " +
    "each company's inspection and can differ.";

  /* ---------- Python-compatible number helpers ---------- */

  // Python's f"{x:.{nd}f}": round-half-even on the exact binary value of x.
  // toFixed(nd + 30) exposes that exact value's decimal digits.
  function pyFixed(x, nd) {
    const neg = x < 0;
    const [ip, fp] = Math.abs(x).toFixed(nd + 30).split(".");
    const keep = ip + fp.slice(0, nd);
    const rest = fp.slice(nd);
    let n = BigInt(keep);
    const half = "5" + "0".repeat(rest.length - 1);
    if (rest > half || (rest === half && n % 2n === 1n)) n += 1n;
    let digits = n.toString().padStart(nd + 1, "0");
    const out = nd ? `${digits.slice(0, -nd)}.${digits.slice(-nd)}` : digits;
    return neg && Number(out) !== 0 ? `-${out}` : out;
  }

  // Python's round(x, nd)
  const pyRound = (x, nd = 0) => Number(pyFixed(x, nd));

  // Python's f"{x:g}" for the values used here (grades and penalties)
  const g = (x) => String(Number(x));

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  function floorTo(grades, value) {
    const eligible = grades.filter((x) => x <= value + 1e-9);
    return eligible.length ? Math.max(...eligible) : Math.min(...grades);
  }

  /* ---------- model helpers ---------- */

  function locationComponent(location) {
    if (CORNERS.includes(location)) return "corners";
    if (EDGES.includes(location)) return "edges";
    if (location === "surface") return "surface";
    throw new Error(`unknown location ${location}`);
  }

  const axisName = (axis) => (axis === "lr" ? "left/right" : "top/bottom");

  // CardAssessment.is_inspected: a listed defect counts as having looked.
  const isInspected = (a, side, comp) =>
    (a.inspected[side] || []).includes(comp) ||
    a.defects.some((d) => d.side === side && locationComponent(d.location) === comp);

  const worst = (s) => Math.max(s.lr, s.tb);
  const best = (s) => Math.min(s.lr, s.tb);

  function sideLabel(s) {
    const fmt = (v) =>
      Math.abs(v - pyRound(v)) < 0.05
        ? `${pyFixed(v, 0)}/${pyFixed(100 - v, 0)}`
        : `${pyFixed(v, 1)}/${pyFixed(100 - v, 1)}`;
    return `L/R ${fmt(s.lr)}, T/B ${fmt(s.tb)}`;
  }

  /* ---------- criteria access ---------- */

  function defectType(criteria, key) {
    const spec = criteria.defects.types[key];
    if (!spec) throw new Error(`unknown defect type '${key}'`);
    return spec;
  }

  /* ---------- centering.py ---------- */

  function fmtShare(share) {
    share = pyRound(share, 1);
    const other = pyRound(100 - share, 1);
    if (Number.isInteger(share)) return `${share}/${Math.trunc(other)}`;
    return `${share}/${other}`;
  }

  function sideFails(side, row, key, tol) {
    const reasons = [];
    const limit = row[key];
    if (worst(side) > limit + tol) reasons.push(`${key} centering ${fmtShare(worst(side))} exceeds ${fmtShare(limit)}`);
    const otherKey = `${key}_other`;
    if (otherKey in row && best(side) > row[otherKey] + tol) {
      reasons.push(`${key} centering needs ${fmtShare(row[otherKey])} on one axis (best axis is ${fmtShare(best(side))})`);
    }
    return reasons;
  }

  function centeringGrade(centering, crit) {
    const tol = Number(crit.tolerance || 0);
    const rows = crit.centering;
    let previousFail = [];
    for (const row of rows) {
      const fails = [...sideFails(centering.front, row, "front", tol), ...sideFails(centering.back, row, "back", tol)];
      if (!fails.length) return { grade: Number(row.grade), limiting: previousFail };
      previousFail = fails.map((r) => `${r} (needed for ${g(row.grade)})`);
    }
    return { grade: Number(rows[rows.length - 1].grade), limiting: previousFail };
  }

  function gradedCentering(a) {
    const out = {};
    for (const side of SIDES) {
      out[side] = {};
      for (const axis of AXES) {
        const v = a.centering[side][axis];
        out[side][axis] = a.centering_evidence[side][axis] === "unread" ? Math.max(v, UNREAD_SHARE) : v;
      }
    }
    return out;
  }

  function interpolate(points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (let i = 0; i < points.length - 1; i++) {
      const [x0, y0] = points[i], [x1, y1] = points[i + 1];
      if (x <= x1) {
        const t = x1 !== x0 ? (x - x0) / (x1 - x0) : 0;
        return y0 + t * (y1 - y0);
      }
    }
    return points[points.length - 1][1];
  }

  /* ---------- condition.py ---------- */

  function defectCap(criteria, d, company) {
    const spec = defectType(criteria, d.type);
    const override = ((spec.overrides || {})[company] || {});
    if (company && d.severity in override) return Number(override[d.severity]);
    return Number(spec.caps[d.severity]);
  }

  function describe(criteria, d) {
    const spec = defectType(criteria, d.type);
    let where;
    if (d.location === "surface") where = `${d.side} surface`;
    else where = `${d.side} ${d.location.replace(/_/g, " ")} ${locationComponent(d.location) === "corners" ? "corner" : "edge"}`;
    return `${d.severity} ${spec.label.toLowerCase()} (${where})`;
  }

  // grade null = unassessed: nothing listed and nobody looked.
  const ceiling = (cc) => (cc.grade == null ? FLAWLESS : cc.grade);

  function condition(criteria, defects, company, inspected) {
    if (!defects.length) return { grade: inspected ? FLAWLESS : null, reasons: [] };
    const rules = criteria.defects.component_rules;
    const capped = defects.map((d) => [defectCap(criteria, d, company), d]).sort((a, b) => a[0] - b[0]);
    const [worstCap, worstDefect] = capped[0];
    let grade = worstCap;
    const reasons = [`${describe(criteria, worstDefect)} caps it at ${g(worstCap)}`];
    const others = capped.slice(1).filter(([c]) => c < 10);
    if (others.length) {
      const penalty = Math.min(rules.stack_penalty * others.length, rules.max_stack_penalty);
      grade -= penalty;
      reasons.push(`${others.length} more defect(s) take off another ${g(penalty)}`);
    }
    const micro = defects.filter((d) => d.severity === "micro");
    if (micro.length >= rules.micro_stack_count && grade > 9.5) {
      grade = 9.5;
      reasons.push(`${micro.length} micro defects add up`);
    }
    return { grade: Math.max(1, grade), reasons };
  }

  function componentConditions(criteria, a, company) {
    const out = {};
    for (const comp of COMPONENTS) {
      out[comp] = condition(
        criteria, a.defects.filter((d) => locationComponent(d.location) === comp), company,
        SIDES.every((side) => isInspected(a, side, comp)),
      );
    }
    return out;
  }

  function componentConditionsPerSide(criteria, a, company) {
    const out = {};
    for (const side of SIDES) {
      for (const comp of COMPONENTS) {
        out[`${side} ${comp}`] = condition(
          criteria,
          a.defects.filter((d) => d.side === side && locationComponent(d.location) === comp),
          company,
          isInspected(a, side, comp),
        );
      }
    }
    return out;
  }

  function unassessedAreas(a) {
    const out = [];
    for (const side of SIDES) {
      for (const axis of AXES) if (a.centering_evidence[side][axis] === "unread") out.push(`${side} centering (${axisName(axis)})`);
      for (const comp of COMPONENTS) if (!isInspected(a, side, comp)) out.push(`${side} ${comp}`);
    }
    return out;
  }

  function unreadCenteringNote(a) {
    const unread = [];
    for (const side of SIDES) for (const axis of AXES) if (a.centering_evidence[side][axis] === "unread") unread.push(`${side} ${axisName(axis)}`);
    if (!unread.length) return null;
    return `Centering wasn't measured (${unread.join(", ")}), so it counts as ${g(UNREAD_SHARE)}/${g(100 - UNREAD_SHARE)}, ` +
      "just making Gem Mint. That's this lab's convention, not a grading company's rule.";
  }

  const fatalDefects = (criteria, a) => a.defects.filter((d) => defectType(criteria, d.type).fatal);

  function qualifierFlags(criteria, a) {
    const flags = [];
    for (const d of a.defects) {
      const q = defectType(criteria, d.type).qualifier;
      if (q && (d.severity === "moderate" || d.severity === "major") && !flags.includes(q)) flags.push(q);
    }
    return flags;
  }

  /* ---------- graders/base.py ---------- */

  const ALTERED_LABELS = { PSA: "AUTHENTIC ALTERED", BGS: "Authentic Altered", CGC: "Altered", TAG: "Altered" };

  function companyGrade(fields) {
    return Object.assign(
      { complete: true, unassessed: [], subgrades: {}, score: null, qualifiers: [], alternatives: [], limiting_factors: [], notes: [] },
      fields,
    );
  }

  function alteredGrade(criteria, company, a) {
    const fatal = fatalDefects(criteria, a);
    if (!fatal.length) return null;
    return companyGrade({
      company, grade: 0, label: ALTERED_LABELS[company], tier: 99,
      limiting_factors: fatal.map((d) => `${describe(criteria, d)}: altered cards get no numeric grade`),
    });
  }

  // Subgrades to report: null for a component that wasn't assessed (its value is only a ceiling).
  function shownSubgrades(parts, conditions) {
    const out = {};
    for (const [k, v] of Object.entries(parts)) out[k] = k in conditions && conditions[k].grade == null ? null : v;
    return out;
  }

  // graders/base.py finish(): an incomplete grade becomes a ceiling (this project's convention).
  function finish(gr, a) {
    const note = unreadCenteringNote(a);
    if (note) gr.notes.unshift(note);
    const missing = unassessedAreas(a);
    if (!missing.length) return gr;
    gr.complete = false;
    gr.unassessed = missing;
    gr.label = `Up to ${gr.label} · incomplete`;
    gr.tier = null;
    gr.limiting_factors.unshift(`Not assessed yet: ${missing.join(", ")}. Until then this is the best case, not a grade.`);
    gr.notes.push(INCOMPLETE_NOTE);
    return gr;
  }

  const fmtGrade = (v) => (v >= FLAWLESS ? "10 (Pristine)" : g(v));

  function bindingFactors(overall, parts, centeringReasons, conditions) {
    const factors = [];
    const entries = Object.entries(parts).sort((x, y) => x[1] - y[1]);
    for (const [name, value] of entries) {
      if (value > overall) continue;
      if (name === "centering") {
        factors.push(`Centering ${fmtGrade(value)}: ${centeringReasons.join("; ") || "centering"}`);
      } else {
        const cond = conditions[name];
        const detail = cond && cond.reasons.length ? cond.reasons.join("; ") : "";
        factors.push(`${capitalize(name)} ${fmtGrade(value)}` + (detail ? `: ${detail}` : ""));
      }
    }
    return factors;
  }

  const label = (crit, value) => crit.labels[g(value)];

  /* ---------- graders/psa.py ---------- */

  function psaBody(criteria, a, grades) {
    const cond = componentConditions(criteria, a, "PSA");
    const parts = {};
    // An unassessed component counts at its best case, so the overall grade is a ceiling.
    for (const [c, cc] of Object.entries(cond)) parts[c] = floorTo(grades, Math.min(10, ceiling(cc)));
    return { body: Math.min(...Object.values(parts)), parts, cond };
  }

  function gradePSA(criteria, a) {
    const altered = alteredGrade(criteria, "PSA", a);
    if (altered) return altered;
    const crit = criteria.companies.psa;
    const grades = crit.grades.map(Number);
    const cent = centeringGrade(a.centering, crit);
    const { body, parts: bodyParts, cond } = psaBody(criteria, a, grades);
    const parts = { centering: cent.grade, ...bodyParts };
    const overall = floorTo(grades, Math.min(body, cent.grade));

    let qualifiers = qualifierFlags(criteria, a);
    const alternatives = [];
    if (cent.grade < body) {
      qualifiers = ["OC", ...qualifiers];
      alternatives.push(`PSA ${g(body)} OC: PSA may grade the rest of the card and add the off-center qualifier`);
    }
    for (const q of qualifierFlags(criteria, a)) {
      const remaining = a.defects.filter(
        (d) => !(defectType(criteria, d.type).qualifier === q && (d.severity === "moderate" || d.severity === "major")),
      );
      const alt = floorTo(grades, Math.min(psaBody(criteria, { ...a, defects: remaining }, grades).body, cent.grade));
      if (alt > overall) alternatives.push(`PSA ${g(alt)} ${q}: graded with the ${q} qualifier instead of for the flaw`);
    }
    const notes = [];
    if (overall === 10 && Object.values(parts).some((v) => v < 10)) {
      notes.push("PSA 10 still allows slight printing imperfections visible under magnification.");
    }
    return finish(companyGrade({
      company: "PSA", grade: overall, label: label(crit, overall), tier: grades.indexOf(overall),
      subgrades: shownSubgrades(parts, cond), qualifiers, alternatives,
      limiting_factors: overall === 10 ? [] : bindingFactors(overall, parts, cent.limiting, cond),
      notes: [...notes, "PSA doesn't print subgrades. The component values shown are estimates."],
    }), a);
  }

  /* ---------- graders/bgs.py ---------- */

  function bgsSubgrade(value, grades) {
    if (value >= FLAWLESS) return 10;
    return floorTo(grades, Math.min(value, 9.5));
  }

  function bgsOverall(subs, rules, grades) {
    const ordered = [...subs].sort((x, y) => x - y);
    const lowest = ordered[0], second = ordered[1];
    let overall;
    if (ordered.filter((v) => v === lowest).length >= 2) overall = lowest;
    else if (second - lowest >= rules.outlier_gap) overall = Math.min(lowest + rules.outlier_bonus, second);
    else overall = Math.min(lowest + rules.max_above_lowest, second);
    if (overall >= 9.5 && lowest < 9) overall = 9;
    if (overall >= 10 && (subs.filter((s) => s >= 10).length < 3 || lowest < 9.5)) overall = 9.5;
    return floorTo(grades, overall);
  }

  function gradeBGS(criteria, a) {
    const altered = alteredGrade(criteria, "BGS", a);
    if (altered) return altered;
    const crit = criteria.companies.bgs;
    const grades = crit.grades.map(Number);
    const cent = centeringGrade(a.centering, crit);
    const cond = componentConditions(criteria, a, "BGS");
    const subs = { centering: cent.grade };
    for (const [c, cc] of Object.entries(cond)) subs[c] = bgsSubgrade(ceiling(cc), grades);  // best case if unassessed
    const values = Object.values(subs);
    const overall = bgsOverall(values, crit.overall_rules, grades);
    const black = values.every((v) => v === 10);
    let limiting = [];
    if (!black) {
      limiting = bindingFactors(Math.min(...values), subs, cent.limiting, cond);
      if (overall === 10) limiting.unshift("A Black Label needs all four subgrades at 10");
    }
    return finish(companyGrade({
      company: "BGS", grade: overall, label: black ? crit.black_label : label(crit, overall),
      tier: black ? 0 : grades.indexOf(overall) + 1, subgrades: shownSubgrades(subs, cond), limiting_factors: limiting,
      notes: ["Beckett's real overall-grade formula is proprietary. This model follows its published rules."],
    }), a);
  }

  /* ---------- graders/cgc.py ---------- */

  function cgcOverall(subs, rules, grades) {
    const ordered = [...subs].sort((x, y) => x - y);
    const lowest = ordered[0], second = ordered[1];
    let overall;
    if (lowest >= 9.5 || ordered.filter((v) => v === lowest).length >= 2) overall = lowest;
    else overall = Math.min(lowest + rules.max_above_lowest, second, 9.5);
    return floorTo(grades, overall);
  }

  function gradeCGC(criteria, a) {
    const altered = alteredGrade(criteria, "CGC", a);
    if (altered) return altered;
    const crit = criteria.companies.cgc;
    const grades = crit.grades.map(Number);
    const cent = centeringGrade(a.centering, crit);
    const cond = componentConditions(criteria, a, "CGC");
    const subs = { centering: cent.grade };
    for (const [c, cc] of Object.entries(cond)) subs[c] = floorTo(grades, ceiling(cc));  // best case if unassessed
    const values = Object.values(subs);
    const overall = cgcOverall(values, crit.overall_rules, grades);
    return finish(companyGrade({
      company: "CGC", grade: Math.min(overall, 10), label: label(crit, overall), tier: grades.indexOf(overall),
      subgrades: shownSubgrades(subs, cond),
      limiting_factors: overall === 10.5 ? [] : bindingFactors(Math.min(...values), subs, cent.limiting, cond),
      notes: ["CGC subgrades are optional, and a 10.5 subgrade here means Pristine."],
    }), a);
  }

  /* ---------- graders/tag.py ---------- */

  function conditionPoints(value, table) {
    const keys = Object.keys(table).map(Number).sort((x, y) => x - y);
    return Number(table[g(floorTo(keys, value))]);
  }

  function bandFor(score, bands) {
    for (let i = 0; i < bands.length; i++) {
      if (score >= bands[i][0]) return [i, Number(bands[i][1]), bands[i][2]];
    }
    const last = bands[bands.length - 1];
    return [bands.length - 1, Number(last[1]), last[2]];
  }

  function gradeTAG(criteria, a) {
    const altered = alteredGrade(criteria, "TAG", a);
    if (altered) return altered;
    const crit = criteria.companies.tag;
    const bands = crit.bands;
    const areas = {};
    for (const side of SIDES) areas[`${side} centering`] = interpolate(crit.centering_points[side], worst(a.centering[side]));
    const cond = componentConditionsPerSide(criteria, a, "TAG");
    // An unassessed area counts at its best case (1000), so the score is a ceiling.
    for (const [key, cc] of Object.entries(cond)) areas[key] = conditionPoints(ceiling(cc), crit.condition_points);

    let mean = 0;
    for (const side of SIDES) {
      for (const comp of ["centering", ...COMPONENTS]) mean += areas[`${side} ${comp}`] * (crit.side_weights[side] / 4);
    }
    const lowest = Math.min(...Object.values(areas));
    const w = crit.weakest_weight;
    let score = w * lowest + (1 - w) * mean;

    const cent = centeringGrade(a.centering, crit);
    const capIndex = bands.findIndex((b) => Number(b[1]) <= cent.grade);
    if (capIndex > 0) score = Math.min(score, bands[capIndex - 1][0] - 1);
    score = pyRound(Math.max(100, Math.min(1000, score)));
    const [tier, gradeValue, bandLabel] = bandFor(score, bands);

    const limiting = [];
    if (tier > 0) {
      const lowestAreas = Object.entries(areas).sort((x, y) => x[1] - y[1]).slice(0, 3);
      for (const [name, pts] of lowestAreas) {
        if (pts >= 990) break;
        let reason = "";
        const [side, comp] = name.split(" ");
        if (comp === "centering") reason = sideLabel(a.centering[side]);
        else if (cond[name].reasons.length) reason = cond[name].reasons.join("; ");
        limiting.push(`${capitalize(name)} ${pyFixed(pts, 0)} pts` + (reason ? `: ${reason}` : ""));
      }
      if (capIndex > 0 && cent.limiting.length) limiting.push("Centering tolerance: " + cent.limiting.join("; "));
    }
    const subgrades = {};
    for (const [k, v] of Object.entries(areas)) subgrades[k] = pyRound(v);
    for (const [k, cc] of Object.entries(cond)) if (cc.grade == null) subgrades[k] = null;  // only a ceiling
    return finish(companyGrade({
      company: "TAG", grade: Math.min(gradeValue, 10), label: bandLabel, tier, score, subgrades,
      limiting_factors: limiting,
      notes: ["TAG's real score comes from its own imaging. This estimate combines the eight area scores."],
    }), a);
  }

  /* ---------- engine.py ---------- */

  function validate(criteria, a) {
    for (const d of a.defects) {
      locationComponent(d.location);
      defectType(criteria, d.type);
      if (!(d.severity in defectType(criteria, d.type).caps)) throw new Error(`unknown severity '${d.severity}'`);
    }
    for (const [side, comps] of Object.entries(a.inspected)) {
      if (!SIDES.includes(side)) throw new Error(`unknown side '${side}'`);
      for (const c of comps) if (!COMPONENTS.includes(c)) throw new Error(`unknown component '${c}'`);
    }
    for (const side of SIDES) {
      for (const axis of AXES) if (!EVIDENCE.includes(a.centering_evidence[side][axis])) throw new Error("unknown centering evidence");
    }
  }

  // CardAssessment._fill_evidence: missing evidence is "typed" if centering was given, else "unread".
  function fillEvidence(assessment) {
    const given = assessment.centering_evidence || {};
    const fallback = assessment.centering != null ? "typed" : "unread";
    const out = {};
    for (const side of SIDES) {
      out[side] = {};
      for (const axis of AXES) out[side][axis] = (given[side] || {})[axis] || fallback;
    }
    return out;
  }

  function gradeAll(assessment, criteria) {
    const a = {
      card: assessment.card || {},
      centering: assessment.centering || { front: { lr: 50, tb: 50 }, back: { lr: 50, tb: 50 } },
      defects: assessment.defects || [],
      inspected: assessment.inspected || {},
      centering_evidence: fillEvidence(assessment),
    };
    validate(criteria, a);
    a.centering = gradedCentering(a);  // graders/base.py prepare(): unread axes count as 55/45
    const grades = { PSA: gradePSA(criteria, a), BGS: gradeBGS(criteria, a), CGC: gradeCGC(criteria, a), TAG: gradeTAG(criteria, a) };
    const complete = Object.values(grades).every((x) => x.complete);
    const missing = complete ? [] : unassessedAreas(a);
    let bestFit = null, summary;
    if (!complete) {
      // An incomplete grade is only a ceiling, so no company is named as the best fit.
      summary = `Incomplete: not assessed yet: ${missing.join(", ")}. Best case: ` +
        Object.values(grades).map((x) => `${x.company} ${x.label}`).join(", ");
    } else {
      let best = null;
      for (const gr of Object.values(grades)) if (!best || gr.tier < best.tier) best = gr;
      bestFit = best.company;
      summary = best.tier >= 99
        ? "The card appears altered, so no company will give it a numeric grade."
        : `Best fit: ${best.company} ${best.label}. ` + Object.values(grades).map((x) => `${x.company} ${x.label}`).join(", ");
    }
    return { grades, complete, unassessed: missing, best_fit: bestFit, summary, disclaimer: DISCLAIMER };
  }

  return { gradeAll, centeringGrade, interpolate, pyRound, pyFixed, FLAWLESS, UNREAD_SHARE };
});
