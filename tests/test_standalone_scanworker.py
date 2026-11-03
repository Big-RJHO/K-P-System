"""ScanWorker (standalone/src/scanworker.js): job ids, coalescing, cancel / supersede, time caps and the
main-thread fallback, driven with a fake Worker class in node; plus the real worker bootstrap evaluated in a vm."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "standalone" / "src"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")

SCRIPT = r"""
const SW = require(%(sw)s), Surface = require(%(surface)s), fs = require("fs"), vm = require("vm");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settled = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: { message: e.message, stale: !!e.stale, superseded: !!e.superseded, cancelled: !!e.cancelled, timeout: !!e.timeout, recoverable: !!e.recoverable, error: !!e.error, disposed: !!e.disposed } }));

// A controllable stand-in for Worker: records what it is sent, answers pings, and replies when told.
class FakeWorker {
  constructor(url) {
    if (FakeWorker.throwOnCreate) throw new Error("Refused by Content-Security-Policy");
    this.url = url; this.posted = []; this.terminated = false;
    FakeWorker.instances.push(this);
  }
  postMessage(m, transfer) {
    this.posted.push({ type: m.type, id: m.id, kind: m.kind, n: m.payload && m.payload.n, transfer: (transfer || []).length });
    if (m.type === "ping" && FakeWorker.pong) setTimeout(() => this.emit({ type: "pong", libs: { Vision: true, Inspect: true, Surface: true } }), 1);
    if (m.type === "job" && FakeWorker.auto) setTimeout(() => this.reply(m.id, { echo: m.payload.n }), FakeWorker.delay);
  }
  reply(id, result) { this.emit({ type: "result", id, ok: true, result }); }
  emit(data) { if (!this.terminated && this.onmessage) this.onmessage({ data }); }
  terminate() { this.terminated = true; }
  jobs() { return this.posted.filter((p) => p.type === "job"); }
}
const reset = (o = {}) => { FakeWorker.instances = []; FakeWorker.pong = true; FakeWorker.auto = false; FakeWorker.delay = 2; FakeWorker.throwOnCreate = false; Object.assign(FakeWorker, o); };
const urls = { created: 0, revoked: 0 };
const SpyURL = { createObjectURL: (b) => { urls.created++; return URL.createObjectURL(b); }, revokeObjectURL: (u) => { urls.revoked++; URL.revokeObjectURL(u); } };
const make = (o = {}) => SW.create({ sources: ["/* vision */", "/* inspect */", "/* surface */"], Worker: FakeWorker, URL: SpyURL, libs: { Surface }, ...o });
const last = () => FakeWorker.instances[FakeWorker.instances.length - 1];
const out = {};

(async () => {
  // basic round trip, worker mode, URL released once the worker answered
  reset({ auto: true });
  let h = make();
  out.basic = { mode0: h.mode, reason: h.unavailableReason };
  out.basic.ready = await h.ready;
  out.basic.result = await h.run("filter", { n: 1 });
  out.basic.urls = { ...urls };
  out.basic.firstPost = FakeWorker.instances[0].posted[0].type;
  h.dispose();

  // coalescing: one active + latest pending; older pending rejected stale
  reset();
  h = make(); await h.ready;
  const p1 = settled(h.run("filter", { n: 1 })), p2 = settled(h.run("filter", { n: 2 })), p3 = settled(h.run("filter", { n: 3 }));
  await sleep(5);
  const w = last();
  out.coalesce = { postedBefore: w.jobs().map((j) => j.n) };
  w.reply(w.jobs()[0].id, "r1"); await sleep(5);
  w.reply(w.jobs()[1].id, "r3");
  out.coalesce.results = [await p1, await p2, await p3];
  out.coalesce.posted = w.jobs().map((j) => j.n);
  out.coalesce.ids = w.jobs().map((j) => j.id);
  out.coalesce.stats = { ...h.stats };
  h.dispose();

  // supersede: the running job is dropped, the worker terminated and recreated, the new job runs there
  reset();
  h = make(); await h.ready;
  const s1 = settled(h.run("scan", { n: 1, pixels: { width: 1, height: 1, data: new Uint8ClampedArray(4) } }));
  await sleep(5);
  const w1 = last();
  const s2 = settled(h.run("scan", { n: 2, pixels: { width: 1, height: 1, data: new Uint8ClampedArray(4) } }, { supersede: true }));
  await sleep(10);
  const w2 = last();
  out.supersede = { first: await s1, workers: FakeWorker.instances.length, w1Terminated: w1.terminated, w2Jobs: w2.jobs().map((j) => j.n), transfer: w1.jobs()[0].transfer };
  w1.onmessage && w1.onmessage({ data: { type: "result", id: w1.jobs()[0].id, ok: true, result: "late" } });  // can't: handler removed
  w2.reply(w1.jobs()[0].id, "late from old id");  // a late result for the superseded id: ignored
  w2.reply(w2.jobs()[0].id, "r2");
  out.supersede.second = await s2;
  out.supersede.stats = { ...h.stats };
  h.dispose();

  // different keys: superseding a queued job of another key doesn't touch the running one
  reset();
  h = make(); await h.ready;
  const a = settled(h.run("filter", { n: "a" }, { coalesceKey: "a" }));
  const b1 = settled(h.run("filter", { n: "b1" }, { coalesceKey: "b" }));
  const b2 = settled(h.run("filter", { n: "b2" }, { coalesceKey: "b", supersede: true }));
  await sleep(5);
  let wk = last();
  wk.reply(wk.jobs()[0].id, "ra"); await sleep(5);
  wk.reply(wk.jobs()[1].id, "rb2");
  out.keys = { a: await a, b1: await b1, b2: await b2, posted: wk.jobs().map((j) => j.n), restarts: h.stats.restarts, transfer: wk.jobs()[0].transfer };
  h.dispose();

  // cancel(key): active and pending rejected, running work stopped by recreating the worker, late result ignored
  reset();
  h = make(); await h.ready;
  const c1 = settled(h.run("marks", { n: 1 })), c2 = settled(h.run("marks", { n: 2 }));
  await sleep(5);
  const cw1 = last();
  h.cancel("marks");
  await sleep(10);
  last().reply(cw1.jobs()[0].id, "late");
  out.cancel = { c1: await c1, c2: await c2, oldTerminated: cw1.terminated, workers: FakeWorker.instances.length, stats: { ...h.stats } };
  FakeWorker.auto = true;
  out.cancel.after = await h.run("marks", { n: 3 });
  h.dispose();

  // time cap: recoverable timeout, worker recreated, the next run works
  reset();
  h = make({ timeouts: { filter: 30 } }); await h.ready;
  const t1 = await settled(h.run("filter", { n: 1 }));
  await sleep(10);
  FakeWorker.auto = true;
  out.timeout = { t1, workers: FakeWorker.instances.length, firstTerminated: FakeWorker.instances[0].terminated, retry: await h.run("filter", { n: 2 }), stats: { ...h.stats } };
  h.dispose();

  // worker error after start: recoverable error, worker recreated
  reset();
  h = make(); await h.ready;
  const e1 = settled(h.run("filter", { n: 1 }));
  await sleep(5);
  last().onerror({ message: "out of memory" });
  out.workerError = { e1: await e1, workers: FakeWorker.instances.length };
  h.dispose();

  // dispose: everything rejected, worker gone, no more runs
  reset();
  h = make(); await h.ready;
  const d1 = settled(h.run("filter", { n: 1 })), d2 = settled(h.run("filter", { n: 2 }));
  await sleep(5);
  h.dispose();
  out.dispose = { d1: await d1, d2: await d2, terminated: last().terminated, after: await settled(h.run("filter", { n: 3 })) };

  // fallbacks: no Worker; construction refused (CSP); no answer to the first message
  const img = { width: 2, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]) };
  reset();
  h = SW.create({ sources: ["x"], Worker: undefined, libs: { Surface } });
  out.noWorker = { mode: h.mode, reason: h.unavailableReason, ready: await h.ready, result: await h.run("filter", { src: img, kind: "invert" }) };
  out.noWorker.expected = Surface.filter(img, { kind: "invert" });
  const n1 = settled(h.run("filter", { src: img, kind: "invert" })), n2 = settled(h.run("filter", { src: img, kind: "grayscale" })), n3 = settled(h.run("filter", { src: img, kind: "red" }));
  out.noWorker.coalesced = [await n1, await n2, await n3].map((r) => (r.ok ? Array.from(r.v.data).slice(0, 4) : r.e));
  out.noWorker.missingLib = await settled(h.run("scan", { pixels: img }));
  h.dispose();
  reset({ throwOnCreate: true });
  h = make();
  out.csp = { mode: h.mode, reason: h.unavailableReason };
  reset({ pong: false });
  h = make({ readyTimeoutMs: 40 });
  const early = settled(h.run("filter", { src: img, kind: "invert" }));
  out.noPong = { mode0: h.mode, ready: await h.ready, mode: h.mode, reason: h.unavailableReason, early: await early, terminated: FakeWorker.instances[0].terminated };
  h.dispose();
  out.noSources = { mode: SW.create({ Worker: FakeWorker, URL: SpyURL }).mode };
  out.noBlobUrl = { mode: SW.create({ sources: ["x"], Worker: FakeWorker, URL: {} }).mode };

  // the real worker side: sources + bootstrap evaluated in a sandbox with its own `self`
  const posted = [];
  const self = { postMessage: (m, transfer) => posted.push({ m, transfer }) };
  const ctx = vm.createContext({ self, Date, Math, JSON, Error, ArrayBuffer, Uint8Array, Uint8ClampedArray, Float32Array, Float64Array, Int32Array, Uint16Array, Object, Array, String, Number, Infinity, NaN, Map, Set, WeakMap, Promise, console });
  const src = [fs.readFileSync(%(vision)s, "utf8"), fs.readFileSync(%(inspect)s, "utf8"), fs.readFileSync(%(surface)s, "utf8"), SW.bootstrapSource()].join("\n;\n");
  vm.runInContext(src, ctx);
  self.onmessage({ data: { type: "ping" } });
  self.onmessage({ data: { type: "job", id: 7, kind: "filter", payload: { src: img, kind: "invert" } } });
  self.onmessage({ data: { type: "job", id: 8, kind: "nope", payload: {} } });
  out.bootstrap = {
    libs: !!(ctx.self.Vision && ctx.self.Inspect && ctx.self.Surface),
    pong: posted[0].m,
    result: { id: posted[1].m.id, ok: posted[1].m.ok, data: Array.from(posted[1].m.result.data), transfers: posted[1].transfer.length },
    unknown: { id: posted[2].m.id, ok: posted[2].m.ok, error: posted[2].m.error },
  };
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
"""


@pytest.fixture(scope="module")
def out():
    paths = {k: json.dumps(str(SRC / f)) for k, f in (("sw", "scanworker.js"), ("surface", "surface.js"), ("vision", "vision.js"), ("inspect", "inspect.js"))}
    res = subprocess.run([NODE, "-e", SCRIPT % paths], capture_output=True, text=True, timeout=120)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_worker_round_trip(out):
    b = out["basic"]
    assert b["mode0"] == "worker" and b["reason"] is None and b["ready"] == "worker"
    assert b["result"] == {"echo": 1}
    assert b["firstPost"] == "ping"
    assert b["urls"]["created"] == 1 and b["urls"]["revoked"] == 1  # the Blob URL is released once the worker is up


def test_latest_pending_only(out):
    c = out["coalesce"]
    assert c["postedBefore"] == [1]  # one job at a time
    r1, r2, r3 = c["results"]
    assert r1 == {"ok": True, "v": "r1"}
    assert not r2["ok"] and r2["e"]["stale"] and not r2["e"]["superseded"]
    assert r3 == {"ok": True, "v": "r3"}
    assert c["posted"] == [1, 3]  # the dropped request never reached the worker
    assert c["ids"][1] > c["ids"][0]
    assert c["stats"]["stale"] == 1 and c["stats"]["completed"] == 2 and c["stats"]["restarts"] == 0


def test_supersede_terminates_and_recreates(out):
    s = out["supersede"]
    assert not s["first"]["ok"] and s["first"]["e"]["stale"] and s["first"]["e"]["superseded"]
    assert s["w1Terminated"] and s["workers"] == 2 and s["w2Jobs"] == [2]
    assert s["second"] == {"ok": True, "v": "r2"}  # the late result for the old id was ignored
    assert s["stats"]["lateIgnored"] == 1 and s["stats"]["restarts"] == 1
    assert s["transfer"] == 1  # scan pixels are transferred, not copied


def test_keys_are_independent(out):
    k = out["keys"]
    assert k["a"] == {"ok": True, "v": "ra"}
    assert not k["b1"]["ok"] and k["b1"]["e"]["superseded"]
    assert k["b2"] == {"ok": True, "v": "rb2"}
    assert k["posted"] == ["a", "b2"] and k["restarts"] == 0  # b1 was only queued: no worker restart needed
    assert k["transfer"] == 0  # filter inputs are copied by default (the UI keeps showing them)


def test_cancel(out):
    c = out["cancel"]
    for r in (c["c1"], c["c2"]):
        assert not r["ok"] and r["e"]["cancelled"] and r["e"]["stale"]
    assert c["oldTerminated"] and c["workers"] == 2
    assert c["stats"]["lateIgnored"] == 1 and c["stats"]["cancelled"] == 2
    assert c["after"] == {"echo": 3}


def test_timeout_is_recoverable(out):
    t = out["timeout"]
    assert not t["t1"]["ok"] and t["t1"]["e"]["timeout"] and t["t1"]["e"]["recoverable"]
    assert t["firstTerminated"] and t["workers"] == 2
    assert t["retry"] == {"echo": 2}
    assert t["stats"]["timeouts"] == 1


def test_worker_error_and_dispose(out):
    e = out["workerError"]
    assert not e["e1"]["ok"] and e["e1"]["e"]["error"] and e["e1"]["e"]["recoverable"] and "out of memory" in e["e1"]["e"]["message"]
    assert e["workers"] == 2
    d = out["dispose"]
    assert not d["d1"]["ok"] and not d["d2"]["ok"] and d["terminated"]
    assert not d["after"]["ok"] and d["after"]["e"]["disposed"]


def test_main_thread_fallback(out):
    n = out["noWorker"]
    assert n["mode"] == "main-thread" and n["ready"] == "main-thread"
    assert "Web Worker" in n["reason"] and "page itself" in n["reason"]
    assert n["result"] == n["expected"]
    first, second, third = n["coalesced"]
    assert first == [245, 235, 225, 255] and second["stale"] and third == [10, 10, 10, 255]  # same coalescing rules
    assert not n["missingLib"]["ok"] and "Vision" in n["missingLib"]["e"]["message"]
    assert out["csp"]["mode"] == "main-thread" and "security policy" in out["csp"]["reason"]
    p = out["noPong"]
    assert p["mode0"] == "worker" and p["ready"] == "main-thread" and p["mode"] == "main-thread"
    assert "didn't start" in p["reason"] and p["terminated"]
    assert p["early"]["ok"] and p["early"]["v"]["data"]["0"] == 245  # a job sent while waiting runs on the main thread
    assert out["noSources"]["mode"] == "main-thread" and out["noBlobUrl"]["mode"] == "main-thread"


def test_real_bootstrap_in_a_sandbox(out):
    b = out["bootstrap"]
    assert b["libs"] and b["pong"]["type"] == "pong" and all(b["pong"]["libs"].values())
    assert b["result"] == {"id": 7, "ok": True, "data": [245, 235, 225, 255, 215, 205, 195, 255], "transfers": 1}
    assert b["unknown"]["id"] == 8 and not b["unknown"]["ok"] and "Unknown job kind" in b["unknown"]["error"]
