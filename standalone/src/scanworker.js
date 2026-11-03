/*
 * Runs the heavy photo work (Vision.scan + Inspect.quality / edgesAndCorners, Surface.findMarks, Surface.filter)
 * off the UI thread, in a Web Worker built from a Blob URL of the inlined module sources, so it works the same in
 * the single-file Claude artifact and on the GitHub Pages site. Where a worker can't run (no Worker / Blob /
 * URL.createObjectURL, or the page's security policy blocks it, or it never answers), the same functions run on
 * the main thread instead and `unavailableReason` says why (for the UI to show).
 *
 * API (global ScanWorker, or module.exports in Node):
 *   ScanWorker.create({sources, libs, timeouts, readyTimeoutMs, Worker, Blob, URL}) -> handle
 *     sources          [string] module sources evaluated in the worker, in order (vision.js, inspect.js,
 *                      surface.js); default window.SCAN_WORKER_SOURCES, which scripts/build_standalone.py injects
 *     libs             {Vision, Inspect, Surface} for the main-thread fallback (default: the page's globals)
 *     timeouts         per-kind time caps in ms (default {scan: 20000, marks: 8000, filter: 5000})
 *     readyTimeoutMs   how long the worker may take to answer its first message (default 5000)
 *     Worker/Blob/URL  injectable for tests (default: the globals; pass Worker: undefined to force the fallback)
 *   handle = {
 *     mode: "worker" | "main-thread",          (a getter: it can drop to "main-thread" if the worker never starts)
 *     unavailableReason: string | null,        why the worker isn't used (null in worker mode)
 *     ready: Promise<mode>,                    settles once the worker answered (or the fallback was chosen)
 *     run(kind, payload, {coalesceKey, supersede, transfer, timeoutMs}) -> Promise<result>,
 *     cancel(coalesceKey?), dispose(), stats: {jobs, completed, stale, cancelled, timeouts, restarts, lateIgnored}
 *   }
 *   kinds:
 *     "scan"   {pixels: {width, height, data}, mode, corners, scale, face, printedMask}
 *              -> {scan, quality, check, pixels, inspectError}. With transfer (default for scan) the pixels'
 *              buffer moves to the worker and comes back as result.pixels: keep using result.pixels afterwards.
 *     "marks"  {scan, quality, check, side, revision, printedMask, reference, maxCandidates, timeBudgetMs,
 *              analysisMaxSide} -> Surface.findMarks result (inputs are copied unless transfer: true)
 *     "filter" {src, kind, intensity, reference} -> Surface.filter result (src copied unless transfer: true)
 *   Results' ArrayBuffers are always transferred back (no copy).
 *
 * Scheduling: every job has an id. Per coalesceKey (default: the kind) there is at most one active job plus the
 * latest pending one: a newer request replaces the pending one, which is rejected with {stale: true}. With
 * {supersede: true} the active job is dropped too (rejected {stale: true, superseded: true}); if it was already
 * running in the worker, the worker is terminated and recreated (the only way to stop JS mid-run). Jobs go to the
 * worker one at a time (it is single-threaded anyway), so terminating it never kills another key's job. A result
 * whose id isn't the running job's (it arrived after a cancel / restart) is ignored. A job running past its time
 * cap is rejected with {timeout: true, recoverable: true} and the worker is recreated; run it again to retry.
 * cancel(key) rejects that key's jobs with {stale: true, cancelled: true} (all keys when omitted); dispose()
 * cancels everything, terminates the worker and revokes its object URL. Dropped jobs release their payload.
 * In main-thread mode a job can't be interrupted once it started (it runs to the end within one task), so time
 * caps there only apply to findMarks' own timeBudgetMs; cancel / stale / late-result rules are the same.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ScanWorker = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const G = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {};
  const DEFAULT_TIMEOUTS = { scan: 20000, marks: 8000, filter: 5000 };

  /*
   * The job functions. Serialised with toString() into the worker, so this must not use anything from the
   * surrounding module: only its `libs` argument and standard JS.
   */
  function makeHandlers(libs) {
    const need = (name) => {
      if (!libs || !libs[name]) throw new Error(`${name} isn't loaded, so this job can't run.`);
      return libs[name];
    };
    return {
      scan(p) {
        const Vision = need("Vision"), Inspect = need("Inspect");
        const opts = p.scale ? { scale: p.scale } : {};
        const scan = Vision.scan(p.pixels, p.mode || "auto", p.corners || null, opts);
        let quality = null, check = null, inspectError = null;
        try {
          quality = Inspect.quality(p.pixels, scan);
          const o = { quality, face: p.face || null };
          if (p.printedMask) o.printedMask = p.printedMask;
          check = Inspect.edgesAndCorners(scan, o);
        } catch (err) {
          inspectError = String((err && err.message) || err);
        }
        return { scan, quality, check, pixels: p.pixels, inspectError };
      },
      marks(p) {
        return need("Surface").findMarks(p.scan, {
          quality: p.quality, check: p.check, side: p.side, revision: p.revision, printedMask: p.printedMask,
          reference: p.reference, maxCandidates: p.maxCandidates, timeBudgetMs: p.timeBudgetMs, analysisMaxSide: p.analysisMaxSide,
        });
      },
      filter(p) {
        return need("Surface").filter(p.src, { kind: p.kind, intensity: p.intensity, reference: p.reference });
      },
    };
  }

  // ArrayBuffers inside a result / payload (typed arrays a few levels deep), each once. Also serialised.
  function collectBuffers(value, out, depth) {
    if (!value || typeof value !== "object" || depth > 4) return out;
    if (ArrayBuffer.isView(value)) {
      if (value.buffer && value.buffer.byteLength && out.indexOf(value.buffer) < 0) out.push(value.buffer);
      return out;
    }
    if (value instanceof ArrayBuffer) { if (value.byteLength && out.indexOf(value) < 0) out.push(value); return out; }
    const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
    for (const k of keys) collectBuffers(value[k], out, depth + 1);
    return out;
  }

  function bootstrapSource() {
    return [
      "(function () {",
      "  'use strict';",
      `  var H = (${makeHandlers.toString()})({ Vision: self.Vision, Inspect: self.Inspect, Surface: self.Surface });`,
      `  var collect = ${collectBuffers.toString()};`,
      "  self.onmessage = function (e) {",
      "    var m = e.data || {};",
      "    if (m.type === 'ping') { self.postMessage({ type: 'pong', libs: { Vision: !!self.Vision, Inspect: !!self.Inspect, Surface: !!self.Surface } }); return; }",
      "    if (m.type !== 'job') return;",
      "    var t0 = Date.now();",
      "    try {",
      "      var fn = H[m.kind];",
      "      if (!fn) throw new Error('Unknown job kind: ' + m.kind);",
      "      var result = fn(m.payload);",
      "      self.postMessage({ type: 'result', id: m.id, ok: true, result: result, ms: Date.now() - t0 }, collect(result, [], 0));",
      "    } catch (err) {",
      "      self.postMessage({ type: 'result', id: m.id, ok: false, error: String((err && err.message) || err), ms: Date.now() - t0 });",
      "    }",
      "  };",
      "})();",
    ].join("\n");
  }

  const failure = (message, props) => Object.assign(new Error(message), props || {});

  function create(options = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(options, k);
    const WorkerC = has("Worker") ? options.Worker : G.Worker;
    const BlobC = has("Blob") ? options.Blob : G.Blob;
    const URLC = has("URL") ? options.URL : G.URL;
    const sources = options.sources || G.SCAN_WORKER_SOURCES || null;
    const libs = options.libs || { Vision: G.Vision, Inspect: G.Inspect, Surface: G.Surface };
    const timeouts = Object.assign({}, DEFAULT_TIMEOUTS, options.timeouts || {});
    const readyTimeoutMs = options.readyTimeoutMs || 5000;
    const setT = (fn, ms) => G.setTimeout(fn, ms), clearT = (t) => G.clearTimeout(t);
    const local = makeHandlers(libs);

    let mode = "worker", reason = null, disposed = false;
    let worker = null, blob = null, url = null, workerReady = false, readyTimer = null;
    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; });
    let nextId = 1, running = null;
    const lanes = new Map(), queue = [];
    const stats = { jobs: 0, completed: 0, stale: 0, cancelled: 0, timeouts: 0, restarts: 0, lateIgnored: 0 };

    function fallback(why) {
      mode = "main-thread";
      reason = `${why} Scans run on the page itself instead, so it may pause briefly while a photo is processed.`;
      workerReady = false;
      if (readyTimer) { clearT(readyTimer); readyTimer = null; }
      killWorker();
      if (url && URLC && URLC.revokeObjectURL) { try { URLC.revokeObjectURL(url); } catch (e) { /* ignore */ } }
      url = null; blob = null;
      resolveReady(mode);
      // a job that was handed to the dead worker runs again here
      if (running) { const j = running; running = null; queue.unshift(j); }
      pump();
    }

    function killWorker() {
      if (!worker) return;
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      try { worker.terminate(); } catch (e) { /* ignore */ }
      worker = null;
    }

    function startWorker() {
      workerReady = false;
      try {
        if (!blob) blob = new BlobC([[...sources, bootstrapSource()].join("\n;\n")], { type: "text/javascript" });
        url = URLC.createObjectURL(blob);
        worker = new WorkerC(url);
      } catch (err) {
        fallback(`The background worker couldn't be created here (${(err && err.message) || err}; usually the page's security policy).`);
        return;
      }
      const w = worker;
      w.onmessage = (e) => { if (w === worker) onMessage(e.data || {}); };
      w.onerror = (e) => {
        if (w !== worker) return;
        if (e && e.preventDefault) e.preventDefault();
        onWorkerError((e && e.message) || "worker error");
      };
      w.onmessageerror = () => { if (w === worker) onWorkerError("a message couldn't be read"); };
      readyTimer = setT(() => { readyTimer = null; if (!workerReady && w === worker) fallback("The background worker didn't start (it may be blocked by the page's security policy)."); }, readyTimeoutMs);
      try { w.postMessage({ type: "ping" }); } catch (err) { fallback(`The background worker couldn't be reached (${(err && err.message) || err}).`); }
    }

    function restartWorker() {
      stats.restarts++;
      killWorker();
      if (url && URLC.revokeObjectURL) { try { URLC.revokeObjectURL(url); } catch (e) { /* ignore */ } url = null; }
      if (readyTimer) { clearT(readyTimer); readyTimer = null; }
      if (mode === "worker" && !disposed) startWorker();
    }

    function onWorkerError(message) {
      if (!workerReady) { fallback(`The background worker failed to start (${message}).`); return; }
      const j = running;
      if (j) {
        running = null; clearT(j.timer); finishLane(j);
        settle(j, failure(`The background worker stopped: ${message}`, { error: true, recoverable: true, kind: j.kind }));
      }
      restartWorker();
      pump();
    }

    function onMessage(m) {
      if (m.type === "pong") {
        if (readyTimer) { clearT(readyTimer); readyTimer = null; }
        if (m.libs && !(m.libs.Vision && m.libs.Inspect && m.libs.Surface)) { fallback("The background worker started without its scan code."); return; }
        workerReady = true;
        if (url && URLC.revokeObjectURL) { try { URLC.revokeObjectURL(url); } catch (e) { /* ignore */ } url = null; }  // the script is loaded: release the URL
        resolveReady(mode);
        pump();
        return;
      }
      if (m.type !== "result") return;
      if (!running || running.id !== m.id) { stats.lateIgnored++; return; }  // cancelled / superseded / timed out
      const j = running;
      running = null; clearT(j.timer); finishLane(j);
      if (m.ok) settle(j, null, m.result); else settle(j, failure(m.error || "Job failed.", { error: true, recoverable: true, kind: j.kind }));
      pump();
    }

    function lane(key) {
      let l = lanes.get(key);
      if (!l) { l = { active: null, pending: null }; lanes.set(key, l); }
      return l;
    }

    function settle(job, err, result) {
      if (job.done) return;
      job.done = true;
      job.payload = null;  // release the inputs (image buffers) as soon as the job is over
      if (err) {
        if (err.stale) stats.stale++;
        if (err.cancelled) stats.cancelled++;
        if (err.timeout) stats.timeouts++;
        job.reject(err);
      } else { stats.completed++; job.resolve(result); }
    }

    function finishLane(job) {
      const l = lanes.get(job.key);
      if (!l || l.active !== job) return;
      l.active = l.pending; l.pending = null;
      if (l.active) queue.push(l.active);
    }

    // Drop a job wherever it is; a job running in the worker takes the worker down with it.
    function abort(job, err) {
      const qi = queue.indexOf(job);
      if (qi >= 0) queue.splice(qi, 1);
      if (running === job) {
        running = null; clearT(job.timer);
        if (mode === "worker") restartWorker();
      }
      settle(job, err);
    }

    function pump() {
      if (disposed || running || !queue.length) return;
      if (mode === "worker" && !workerReady) return;  // waits for the pong (or the fallback)
      const job = queue.shift();
      running = job;
      const limit = job.opts.timeoutMs || timeouts[job.kind] || 10000;
      if (mode === "worker") {
        const transfer = job.opts.transfer === undefined ? job.kind === "scan" : !!job.opts.transfer;
        const list = transfer ? collectBuffers(job.payload, [], 0) : [];
        try {
          worker.postMessage({ type: "job", id: job.id, kind: job.kind, payload: job.payload }, list);
        } catch (err) {
          running = null; finishLane(job);
          settle(job, failure(`Couldn't send the job to the background worker: ${(err && err.message) || err}`, { error: true, recoverable: true, kind: job.kind }));
          pump();
          return;
        }
        job.timer = setT(() => {
          if (running !== job) return;
          running = null; finishLane(job);
          restartWorker();
          settle(job, failure(`The ${job.kind} job took longer than ${limit} ms and was stopped. Try again.`, { timeout: true, recoverable: true, kind: job.kind }));
          pump();
        }, limit);
      } else {
        job.timer = setT(() => {
          if (running !== job) return;
          let result, err = null;
          try { result = local[job.kind](job.payload); } catch (e) { err = failure((e && e.message) || String(e), { error: true, recoverable: true, kind: job.kind }); }
          running = null; finishLane(job);
          settle(job, err, result);
          pump();
        }, 0);
      }
    }

    function run(kind, payload, opts = {}) {
      if (disposed) return Promise.reject(failure("This scan worker was disposed.", { disposed: true }));
      if (!local[kind]) return Promise.reject(failure(`Unknown job kind: ${kind}`, { error: true }));
      return new Promise((resolve, reject) => {
        const job = { id: nextId++, key: opts.coalesceKey || kind, kind, payload, opts, resolve, reject, timer: null, done: false };
        stats.jobs++;
        const l = lane(job.key);
        if (!l.active) { l.active = job; queue.push(job); }
        else if (opts.supersede) {
          if (l.pending) settle(l.pending, failure("Replaced by a newer request.", { stale: true }));
          l.pending = null;
          const old = l.active;
          l.active = job; queue.push(job);
          abort(old, failure("Replaced by a newer request.", { stale: true, superseded: true }));
        } else {
          if (l.pending) settle(l.pending, failure("Replaced by a newer request.", { stale: true }));
          l.pending = job;
        }
        pump();
      });
    }

    function cancel(key) {
      const keys = key === undefined || key === null ? [...lanes.keys()] : [key];
      for (const k of keys) {
        const l = lanes.get(k);
        if (!l) continue;
        const { active, pending } = l;
        l.active = null; l.pending = null;
        if (pending) settle(pending, failure("Cancelled.", { stale: true, cancelled: true }));
        if (active) abort(active, failure("Cancelled.", { stale: true, cancelled: true }));
      }
      pump();
    }

    function dispose() {
      if (disposed) return;
      cancel();
      disposed = true;
      if (readyTimer) { clearT(readyTimer); readyTimer = null; }
      killWorker();
      if (url && URLC && URLC.revokeObjectURL) { try { URLC.revokeObjectURL(url); } catch (e) { /* ignore */ } }
      url = null; blob = null;
      resolveReady(mode);
    }

    // Pick the mode.
    if (typeof WorkerC !== "function") fallback("Background processing isn't available in this browser (no Web Worker support).");
    else if (typeof BlobC !== "function" || !URLC || typeof URLC.createObjectURL !== "function") fallback("Background processing isn't available here (Blob URLs aren't supported).");
    else if (!Array.isArray(sources) || !sources.length) fallback("Background processing isn't bundled in this build (no worker sources).");
    else startWorker();

    return {
      get mode() { return mode; },
      get unavailableReason() { return reason; },
      ready,
      run,
      cancel,
      dispose,
      stats,
    };
  }

  return { create, makeHandlers, collectBuffers, bootstrapSource, DEFAULT_TIMEOUTS };
});
