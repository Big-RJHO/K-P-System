"""Packaging: both builds (GitHub Pages site and the single-file Claude artifact) run ScanWorker in a real browser.

Chromium via Playwright (node), offline: every http(s) request is aborted. Skipped when node or Playwright is missing."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import pytest

from synthetic import make_card, place_on_background

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def _has_playwright() -> bool:
    if NODE is None:
        return False
    return subprocess.run([NODE, "-e", "require('playwright')"], capture_output=True).returncode == 0


pytestmark = pytest.mark.skipif(not _has_playwright(), reason="node or Playwright is not installed")

SCRIPT = r"""
const { chromium } = require("playwright");
const fs = require("fs");
const [site, artifact, png, expected] = JSON.parse(fs.readFileSync(0, "utf8"));
(async () => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log(JSON.stringify({ skip: String(e).split("\n")[0] })); return; }
  const dataUrl = "data:image/png;base64," + fs.readFileSync(png).toString("base64");
  const out = {};
  for (const [name, file] of [["site", site], ["artifact", artifact]]) {
    for (const noWorker of [false, true]) {
      const ctx = await browser.newContext();
      await ctx.route(/^https?:\/\//, (r) => r.abort());
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      if (noWorker) await page.addInitScript(() => { window.Worker = undefined; });
      await page.goto("file://" + file);
      const r = await page.evaluate(async ({ src, expected }) => {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height);
        const h = ScanWorker.create();
        await h.ready;
        const t = performance.now();
        const res = await h.run("scan", { pixels: { width: d.width, height: d.height, data: d.data }, mode: "auto" });
        const ms = Math.round(performance.now() - t);
        const marks = await h.run("marks", { scan: res.scan, quality: res.quality, check: res.check, side: "front", revision: 1 });
        const out = { mode: h.mode, reason: h.unavailableReason, ms, width: res.scan.width, verdict: res.quality.verdict, pixelsBack: res.pixels.data.length === d.width * d.height * 4, sentDetached: d.data.length === 0,
          marksStatus: marks.status, sourcesMatch: JSON.stringify(window.SCAN_WORKER_SOURCES) === JSON.stringify(expected),
          globals: ["ScanConfidence", "Surface", "ScanWorker", "Vision", "Inspect"].filter((k) => !window[k]) };
        h.dispose();
        return out;
      }, { src: dataUrl, expected });
      out[name + (noWorker ? "-noworker" : "")] = { ...r, errors };
      await ctx.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
"""


@pytest.fixture(scope="module")
def pages(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("build")
    sys.path.insert(0, str(ROOT / "scripts"))
    from build_standalone import SRC, WORKER_SOURCES, build

    single, site = tmp / "dist" / "card-grading-lab.html", tmp / "site"
    build(single, site)
    wrapped = tmp / "artifact.html"  # the artifact file is a fragment: the Claude publisher adds the document around it
    wrapped.write_text(f'<!doctype html><html><head><meta charset="utf-8"></head><body>\n{single.read_text(encoding="utf-8")}\n</body></html>', encoding="utf-8")
    png = tmp / "card.png"
    cv2.imwrite(str(png), place_on_background(make_card(40, 31, 44, 47, border_bgr=(40, 205, 245)), 3))
    expected = [(SRC / n).read_text(encoding="utf-8") for n in WORKER_SOURCES]
    args = json.dumps([str(site / "index.html"), str(wrapped), str(png), expected])
    res = subprocess.run([NODE, "-e", SCRIPT], input=args, capture_output=True, text=True, timeout=600)
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout.strip().splitlines()[-1])
    if "skip" in out:
        pytest.skip(f"chromium could not start: {out['skip']}")
    return out


@pytest.mark.parametrize("build", ["site", "artifact"])
def test_worker_mode_in_both_builds(pages, build):
    r = pages[build]
    assert r["errors"] == []
    assert r["mode"] == "worker" and r["reason"] is None
    assert r["width"] == 846 and r["verdict"] == "ok" and r["pixelsBack"]
    assert r["sentDetached"]  # the photo's buffer was transferred to the worker (not copied) and came back
    assert r["marksStatus"] == "ok"
    assert r["sourcesMatch"]  # the inlined worker sources survived the HTML escaping byte for byte
    assert r["globals"] == []


@pytest.mark.parametrize("build", ["site", "artifact"])
def test_main_thread_fallback_without_worker(pages, build):
    r = pages[f"{build}-noworker"]
    assert r["errors"] == []
    assert r["mode"] == "main-thread" and "Web Worker" in r["reason"]
    assert r["width"] == 846 and r["verdict"] == "ok" and r["marksStatus"] == "ok"
