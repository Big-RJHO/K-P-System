// Offline Playwright scenarios for the standalone app (driven by tests/test_standalone_ui.py).
// Usage: node ui_harness.js <scenario> <site/index.html> <front.jpg> <back.jpg>
// Prints one JSON object. Every request leaving the page is aborted: nothing goes over the network.
const { chromium } = require("playwright");

const [scenario, html, front, back] = process.argv.slice(2);

// A stand-in for surface.js with the documented API, so the UI paths are deterministic. If the real module is
// in the build, its assignment is kept aside and this one stays in use for the test.
const FAKE_SURFACE = () => {
  const fake = {
    filter(src, opts) {
      const data = new Uint8ClampedArray(src.data);
      for (let i = 0; i < data.length; i += 4) {
        if (opts.kind === "grayscale") { const g = (data[i] + data[i + 1] + data[i + 2]) / 3; data[i] = data[i + 1] = data[i + 2] = g; }
        else if (opts.kind === "invert") { data[i] = 255 - data[i]; data[i + 1] = 255 - data[i + 1]; data[i + 2] = 255 - data[i + 2]; }
      }
      window.__filterCalls = (window.__filterCalls || 0) + 1;
      return { width: src.width, height: src.height, data };
    },
    findMarks(scan, opts) {
      return {
        status: "done", note: "",
        candidates: [
          { id: "m1", side: opts.side, revision: opts.revision, method: "local-contrast", kind: "spot", x: 0.4, y: 0.3, w: 0.05, h: 0.04, score: 0.7, detection: "medium", detectionNote: "stands out from the print around it", reason: "A small light spot", suggestedTypes: ["surface_scratch", "print_spot"], status: "pending" },
          { id: "m2", side: opts.side, revision: opts.revision, method: "local-contrast", kind: "line", x: 0.6, y: 0.7, w: 0.08, h: 0.01, score: 0.4, detection: "low", detectionNote: "faint", reason: "A faint line", suggestedTypes: ["print_line"], status: "pending" },
        ],
        cannotAssess: [{ x: 0, y: 0, w: 0.1, h: 0.1, reason: "glare" }],
      };
    },
    compareReference() { return null; },
  };
  Object.defineProperty(window, "Surface", { configurable: true, get: () => fake, set: (v) => { window.__realSurface = v; } });
};

const KEYS = { gm: "cardGradingLab.gemini.key", pc: "cardGradingLab.pricecharting.token", cs: "cardGradingLab.cardsight.key" };

async function setup({ width = 390, height = 844, fakeSurface = false, init = null } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.stack || e)));
  await context.route(/^https?:\/\//, (r) => r.abort());
  if (fakeSurface) await page.addInitScript(FAKE_SURFACE);
  if (init) await page.addInitScript(init);
  await page.goto("file://" + html);
  return { browser, context, page, errors };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const report = (page) => page.evaluate(() => JSON.stringify({ grades: state.report.grades, complete: state.report.complete, unassessed: state.report.unassessed }));

async function scanBoth(page) {
  await page.setInputFiles("#file-front", front);
  await page.waitForFunction(() => state.scans.front && state.conf.front && state.conf.front.level !== "assessing", null, { timeout: 120000 });
  await page.setInputFiles("#file-back", back);
  await page.waitForFunction(() => !document.querySelector("#review-card").disabled, null, { timeout: 120000 });
}

const scenarios = {
  /** No horizontal overflow on every screen at a narrow width. */
  async layout() {
    const out = {};
    for (const width of [320, 390]) {
      const { browser, page, errors } = await setup({ width, height: 800, fakeSurface: true });
      const r = {};
      r.scan = await overflow(page);
      await scanBoth(page);
      r.scanDone = await overflow(page);
      await page.click("#review-card");
      await page.waitForFunction(() => state.report);
      r.review = await overflow(page);
      for (const pane of ["pane-centering", "pane-edges", "pane-surface", "pane-defects", "prices-panel"]) {
        await page.click(`[data-pane="${pane}"]`);
        r[pane] = await overflow(page);
        await page.click(`#${pane} [data-pop]`);
      }
      await page.click("#open-subgrades");
      r.company = await overflow(page);
      await page.click("#pane-company [data-pop]");
      await page.click("#open-details");
      r.details = await overflow(page);
      await page.click("#done-details");
      await page.click("#open-surface");
      await page.click("#sv-find");
      await page.waitForSelector("#sv-list li");
      r.viewer = await overflow(page);
      await page.click("#sv-done");
      await page.click(".tabbar [data-tab=history]");
      r.history = await overflow(page);
      await page.click(".tabbar [data-tab=settings]");
      r.settings = await overflow(page);
      r.errors = errors;
      out[width] = r;
      await browser.close();
    }
    return out;
  },

  /** Scan confidence: "Not scanned" for a missing side, "Assessing scan…" while processing, never a percentage. */
  async confidence() {
    const { browser, page, errors } = await setup({ fakeSurface: true });
    const r = {};
    r.initial = await page.innerText("#scan-conf").catch(() => "");
    // Slow the scan down so the in-progress state can be seen.
    await page.evaluate(() => {
      const base = runner();
      runnerInstance = { mode: base.mode, unavailableReason: base.unavailableReason, cancel: (k) => base.cancel(k), dispose: () => base.dispose(),
        run: (k, p, o) => new Promise((res) => setTimeout(res, 1500)).then(() => base.run(k, p, o)) };
    });
    await page.setInputFiles("#file-front", front);
    await page.waitForFunction(() => state.conf.front && state.conf.front.level === "assessing");
    r.during = await page.innerText("#scan-conf");
    r.duringReviewDisabled = await page.evaluate(() => document.querySelector("#review-card").disabled);
    await page.waitForFunction(() => state.conf.front && state.conf.front.level !== "assessing", null, { timeout: 120000 });
    await page.waitForTimeout(200);
    r.after = await page.innerText("#scan-conf");
    r.frontLevel = await page.evaluate(() => state.conf.front.level);
    r.live = await page.innerText("#live");
    await page.click("#front-only");
    await page.waitForFunction(() => state.report);
    r.review = await page.innerText("#review-conf");
    await page.click("#review-conf .conf-why summary");
    r.why = await page.innerText("#review-conf .conf-why");
    r.bodyText = await page.evaluate(() => document.body.innerText);
    r.confHtml = await page.evaluate(() => [...document.querySelectorAll(".conf-row")].map((e) => e.outerHTML).join(""));
    // Filters never change the rating.
    const before = await page.evaluate(() => JSON.stringify(state.conf.front));
    await page.click("#open-surface");
    await page.click('#sv-filters [data-kind="grayscale"]');
    await page.waitForTimeout(300);
    await page.click("#sv-done");
    r.confUnchangedByFilter = before === (await page.evaluate(() => JSON.stringify(state.conf.front)));
    r.errors = errors;
    await browser.close();
    return r;
  },

  /** Results of async work for a card that has since been replaced are dropped. */
  async stale() {
    const { browser, page, errors } = await setup();
    const r = {};
    // 1) A scan in flight when the card is reset.
    await page.evaluate(() => {
      const base = runner();
      runnerInstance = { mode: base.mode, unavailableReason: base.unavailableReason, cancel: () => {}, dispose: () => {},
        run: (k, p, o) => new Promise((res) => setTimeout(res, 800)).then(() => mainThreadRunner("").run(k, p, o)) };
    });
    await page.setInputFiles("#file-front", front);
    await page.waitForFunction(() => state.conf.front && state.conf.front.level === "assessing");
    await page.evaluate(() => newScan());
    await page.waitForTimeout(3000);
    r.scanAfterReset = await page.evaluate(() => ({ scan: !!state.scans.front, thumb: !!state.thumbs.front, conf: state.conf.front && state.conf.front.level }));
    // 2) A newer photo for the same side wins over an older one still being measured.
    await page.evaluate(() => { runnerInstance = null; });
    await scanBoth(page);
    await page.click("#review-card");
    await page.waitForFunction(() => state.report);
    // 3) A card lookup that answers after the card was replaced.
    await page.evaluate(() => {
      window.__slowFetch = (url) => new Promise((res) => setTimeout(() => res({ ok: true, status: 200, json: async () => ([]) }), 700));
      window.fetch = window.__slowFetch;
      document.querySelector("#card-number").value = "125/197";
      document.querySelector("#card-set-code").value = "OBF";
      findCard();
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => { resetCard(); });
    await page.waitForTimeout(2000);
    r.lookupAfterReset = await page.evaluate(() => ({ resultsHidden: document.querySelector("#id-results").hidden, status: document.querySelector("#id-row-status").textContent }));
    r.errors = errors;
    await browser.close();
    return r;
  },

  /** Each distinct lookup query and request happens once per read; the read stops at its deadline. */
  async lookup() {
    const { browser, page, errors } = await setup();
    const r = await page.evaluate(async () => {
      const reading = { found: true, name: "Charizard ex", name_key: "charizard", number: "125/197", set_code: "OBF", language: "EN" };
      const queries = CardOCR.queries(reading, "pokemon");
      const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });
      // Without de-duplication (one Identify call per query, as before): count repeated requests.
      const raw = {};
      for (const q of queries) await Identify.candidates(q, { fetch: (u) => { raw[u] = (raw[u] || 0) + 1; return notFound(); } });
      const counts = {};
      const s = lookupSession({ fetchImpl: (u) => { counts[u] = (counts[u] || 0) + 1; return notFound(); } });
      const res = await s.firstMatch([...queries, ...queries]);
      s.close();
      // Deadline: a request that never answers.
      const t0 = Date.now();
      const slow = lookupSession({ deadlineMs: 300, fetchImpl: () => new Promise(() => {}) });
      const timed = await slow.firstMatch(queries);
      slow.close();
      renderCandidates(timed);
      return {
        queries: queries.length, rawMax: Math.max(...Object.values(raw)), rawTotal: Object.values(raw).reduce((a, b) => a + b, 0),
        dedupMax: Math.max(...Object.values(counts)), dedupDistinct: Object.keys(counts).length, rawDistinct: Object.keys(raw).length,
        found: res.candidates.length, timedOut: !!timed.timedOut, elapsed: Date.now() - t0,
        timeoutText: document.querySelector("#id-results").innerText, rowStatus: document.querySelector("#id-row-status").textContent,
      };
    });
    r.errors = errors;
    await browser.close();
    return r;
  },

  /** Old saves, drafts and backups (including "DINGS" wording in notes) still load. */
  async legacy() {
    const oldCard = {
      id: "1700000000000", created_at: "2023-11-14T10:00:00.000Z",
      assessment: {
        card: { game: "pokemon", name: "Old Pikachu", set_name: "Base", number: "58/102", rarity: "Common" },
        centering: { front: { lr: 55, tb: 52 }, back: { lr: 60, tb: 50 } },
        defects: [
          { side: "front", location: "top_left", type: "corner_whitening", severity: "minor", note: "Logged in DINGS" },
          { side: "back", location: "top", type: "edge_whitening", severity: "micro", note: "Photo check, not confirmed", confirmed: false },
        ],
      },
      report: { grades: {} }, front_thumb: null, back_thumb: null,
    };
    const v3Card = JSON.parse(JSON.stringify(oldCard));
    Object.assign(v3Card, { id: "1710000000000", created_at: "2024-03-09T10:00:00.000Z" });
    v3Card.assessment.card.name = "Checked Eevee";
    v3Card.assessment.inspected = { front: ["corners", "edges", "surface"], back: ["corners", "edges", "surface"] };
    v3Card.assessment.photo_limits = { front: ["surface", "edges:top"], back: ["surface"] };
    v3Card.assessment.inspected_in_hand = { front: ["surface", "edges"], back: ["surface"] };
    v3Card.assessment.centering_evidence = { front: { lr: "measured", tb: "typed" }, back: { lr: "measured", tb: "measured" } };
    const draftV2 = { card: { game: "riftbound", name: "Draft Ahri" }, centering: { front: { lr: 51, tb: 50 }, back: { lr: 50, tb: 50 } }, defects: [], thumbs: {} };
    const init = new Function(`if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1");
      localStorage.setItem("cardGradingLab.cards.v1", ${JSON.stringify(JSON.stringify([v3Card, oldCard]))});
      localStorage.setItem("cardGradingLab.draft.v2", ${JSON.stringify(JSON.stringify(draftV2))}); }`);
    const { browser, page, errors } = await setup({ init });
    const r = {};
    r.resume = await page.innerText("#resume");
    await page.click(".tabbar [data-tab=history]");
    r.history = await page.innerText("#history-list");
    await page.click("#history-list li:nth-child(2)");   // the oldest save
    await page.waitForFunction(() => state.report && document.querySelector("#card-name").value === "Old Pikachu");
    r.loaded = await page.evaluate(() => ({ defects: state.defects, complete: state.report.complete, name: document.querySelector("#card-name").value }));
    await page.click('[data-pane="pane-defects"]');
    r.defectsText = await page.innerText("#pane-defects");
    await page.click("#pane-defects [data-pop]");
    await page.click(".tabbar [data-tab=history]");
    await page.click("#history-list li:nth-child(1)");
    await page.waitForFunction(() => document.querySelector("#card-name").value === "Checked Eevee");
    r.v3 = await page.evaluate(() => ({ inHand: state.inHand, limits: state.photoLimits, evidence: state.evidence, complete: state.report.complete, unassessed: state.report.unassessed }));
    r.reviewText = await page.evaluate(() => document.body.innerText);
    // Stored data is untouched by loading.
    r.stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cardGradingLab.cards.v1")));
    // An old backup (a bare array, as early versions exported) restores into an empty History.
    await page.evaluate(() => localStorage.removeItem("cardGradingLab.cards.v1"));
    await page.click(".tabbar [data-tab=settings]");
    await page.fill("#backup-text", JSON.stringify([oldCard]));
    await page.click("#restore-text");
    await page.click(".tabbar [data-tab=history]");
    r.restored = await page.innerText("#history-list");
    r.restoredStored = await page.evaluate(() => JSON.parse(localStorage.getItem("cardGradingLab.cards.v1")).map((c) => c.assessment.defects));
    r.errors = errors;
    await browser.close();
    return r;
  },

  /** Unconfirmed candidates and filters never change grades or completeness; a confirmed defect does. */
  async marks() {
    const { browser, page, errors } = await setup({ fakeSurface: true });
    const r = {};
    await scanBoth(page);
    await page.click("#review-card");
    await page.waitForFunction(() => state.report);
    // Everything checked except the front surface.
    await page.evaluate(() => {
      for (const s of SIDES) for (const c of ["corners", "edges"]) setInspected(s, c, true);
      setInspected("back", "surface", true);
      state.dismissed.front = (state.scans.front.check ? state.scans.front.check.defects : []).map((d) => flagKey({ ...d, side: d.side || "front" }));
      state.dismissed.back = (state.scans.back.check ? state.scans.back.check.defects : []).map((d) => flagKey({ ...d, side: d.side || "back" }));
      runGrade();
    });
    const g0 = await report(page);
    r.unassessed0 = JSON.parse(g0).unassessed;
    await page.click("#open-surface");
    await page.click("#sv-find");
    await page.waitForSelector("#sv-list li");
    r.listText = await page.innerText("#sv-list");
    r.afterFind = (await report(page)) === g0;
    for (const kind of ["grayscale", "invert", "contrast"]) { await page.click(`#sv-filters [data-kind="${kind}"]`); await page.waitForTimeout(150); }
    await page.fill("#sv-intensity", "20");
    await page.waitForTimeout(300);
    r.filterCalls = await page.evaluate(() => window.__filterCalls || 0);
    r.afterFilters = (await report(page)) === g0;
    r.diffDisabled = await page.evaluate(() => document.querySelector('#sv-filters [data-kind="difference"]').disabled);
    // Select mark 2: dismiss. Mark 1: check in hand, then add as a defect.
    await page.click('#sv-list button[data-id="m2"]');
    r.detail = await page.innerText("#sv-detail");
    await page.click("#sv-detail .mark-actions button:nth-child(2)");
    await page.click('#sv-list button[data-id="m1"]');
    await page.click("#sv-detail .mark-actions button:nth-child(3)");
    r.afterDismissAndInHand = (await report(page)) === g0;
    await page.click('#sv-list button[data-id="m1"]');
    await page.click("#sv-detail .mark-actions button:nth-child(1)");
    r.sheetTypes = await page.evaluate(() => [...document.querySelectorAll("#type-chips button")].slice(0, 2).map((b) => b.dataset.type));
    await page.click('#type-chips [data-type="surface_scratch"]');
    await page.click('#sev-seg [data-sev="moderate"]');
    await page.click("#sheet-add");
    r.focusAfterSheet = await page.evaluate(() => document.activeElement && document.activeElement.textContent);
    const g1 = JSON.parse(await report(page));
    r.defect = await page.evaluate(() => state.defects.find((d) => d.region));
    r.unassessed1 = g1.unassessed;
    r.completeAfterAdd = g1.complete;
    await page.click("#sv-done");
    // Front surface checked in hand: now complete, and the defect lowers the grade.
    await page.evaluate(() => setInspected("front", "surface", true));
    const withDefect = JSON.parse(await report(page));
    await page.evaluate(() => { const d = state.defects.find((x) => x.region); state.defects.splice(state.defects.indexOf(d), 1); runGrade(); });
    const without = JSON.parse(await report(page));
    r.tagWith = withDefect.grades.TAG.score;
    r.tagWithout = without.grades.TAG.score;
    r.completeWith = withDefect.complete;
    // A new front photo: candidates are cleared; a confirmed defect is kept and flagged for a re-check.
    await page.evaluate((d) => { state.defects.push(d); runGrade(); }, r.defect);
    await page.setInputFiles("#file-front", front);
    await page.waitForFunction(() => state.conf.front && state.conf.front.level !== "assessing" && !state.marks.front, null, { timeout: 120000 });
    await page.waitForTimeout(300);
    r.afterNewPhoto = await page.evaluate(() => ({ marks: state.marks.front, defect: state.defects.find((d) => d.region) }));
    await page.click('[data-pane="pane-defects"]');
    r.recheckText = await page.innerText("#defect-list");
    // The backup holds no previews, candidates or keys.
    await page.evaluate((k) => { localStorage.setItem(k.gm, "AIzaSyTESTKEYTESTKEYTESTKEYTESTKEY12345"); localStorage.setItem(k.pc, "a".repeat(40)); localStorage.setItem(k.cs, "cs_TESTKEY_0123456789"); }, KEYS);
    await page.click("#pane-defects [data-pop]");
    await page.click("#save-card");
    r.backup = await page.evaluate(() => backupText());
    r.errors = errors;
    await browser.close();
    return r;
  },

  /** End to end: scan → offline identify → inspect → marks → check in hand → grades → save → reload → backup/restore. */
  async e2e() {
    const { browser, context, page, errors } = await setup({ fakeSurface: true });
    const r = { steps: [] };
    const step = (s) => r.steps.push(s);
    await scanBoth(page);
    step("scanned");
    r.scanConf = await page.innerText("#scan-conf");
    await page.click("#review-card");
    await page.waitForFunction(() => state.report);
    await context.setOffline(true);
    await page.click("#open-details");
    await page.click("#read-card");
    await page.waitForFunction(() => /Offline/.test(document.querySelector("#id-row-status").textContent));
    r.offlineSheet = await page.innerText("#id-results");
    await page.click("#done-details");
    r.offlineRow = await page.innerText("#open-details");
    r.focusBack = await page.evaluate(() => document.activeElement && document.activeElement.id);
    step("offline identify");
    await page.fill("#card-name", "Test Card");
    await page.click("#open-surface");
    await page.click('#sv-filters [data-kind="grayscale"]');
    await page.click('[data-sv-view="original"]');
    await page.click('[data-sv-view="filtered"]');
    await page.click("#sv-find");
    await page.waitForSelector("#sv-list li");
    await page.click('#sv-list button[data-id="m1"]');
    await page.click("#sv-detail .mark-actions button:nth-child(1)");
    await page.click('#type-chips [data-type="print_spot"]');
    await page.click('#sev-seg [data-sev="minor"]');
    await page.click("#sheet-add");
    await page.click('#sv-list button[data-id="m2"]');
    await page.click("#sv-detail .mark-actions button:nth-child(2)");
    r.marksList = await page.innerText("#sv-list");
    await page.click("#sv-done");
    step("marks");
    // In-hand surface check on both sides, every other area checked.
    for (const side of ["front", "back"]) {
      await page.click('[data-pane="pane-surface"]');
      await page.click(`#pane-surface .side-seg [data-side="${side}"]`);
      await page.click("#surface-check button");
      await page.click("#pane-surface [data-pop]");
    }
    await page.click('[data-pane="pane-edges"]');
    for (const b of await page.$$("#scancheck-body .sc-cand-btns button:nth-child(2)")) { if (await b.isVisible()) await b.click().catch(() => {}); }
    await page.click("#pane-edges [data-pop]");
    await page.click('[data-pane="pane-defects"]');
    for (let i = 0; i < 6; i++) {
      const box = await page.$("#all-checks input:not(:checked):not(:disabled)");
      if (!box) break;
      await box.check();
    }
    // Any spot still unreviewed on either side: mark it "Not wear".
    await page.evaluate(() => { for (const s of SIDES) state.dismissed[s] = (state.scans[s].check ? state.scans[s].check.defects : []).map((d) => flagKey({ ...d, side: d.side || s })); runGrade(); });
    await page.click("#pane-defects [data-pop]");
    r.grades = await page.innerText("#estimates");
    r.complete = await page.evaluate(() => state.report.complete);
    step("graded");
    await page.click("#save-card");
    await page.reload();
    await page.click(".tabbar [data-tab=history]");
    r.historyAfterReload = await page.innerText("#history-list");
    await page.click("#history-list li");
    await page.waitForFunction(() => document.querySelector("#card-name").value === "Test Card");
    r.reloadedDefects = await page.evaluate(() => state.defects.length);
    step("reloaded");
    await page.click(".tabbar [data-tab=settings]");
    await page.click("#copy-backup");
    await page.waitForTimeout(300);
    r.backup = await page.inputValue("#backup-text");
    await page.evaluate(() => localStorage.removeItem("cardGradingLab.cards.v1"));
    await page.click("#restore-text");
    await page.click(".tabbar [data-tab=history]");
    r.historyAfterRestore = await page.innerText("#history-list");
    step("restored");
    r.errors = errors;
    await browser.close();
    return r;
  },
};

scenarios[scenario]()
  .then((r) => { process.stdout.write(JSON.stringify(r)); })
  .catch((e) => { console.error(e && e.stack || e); process.exit(1); });
