"""Build the standalone (no-server) Card Grading Lab.

Outputs:
  standalone/dist/card-grading-lab.html  self-contained page fragment published as the Claude link
  site/                                  GitHub Pages build: index.html + manifest + icons + service worker

Both read the grading criteria from cardgrader/criteria/*.yaml, the same files the Python app uses.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cardgrader import criteria_loader  # noqa: E402

SRC = ROOT / "standalone" / "src"
ICONS = ROOT / "cardgrader" / "web" / "static"


def _g(value) -> str:
    return f"{float(value):g}"


def criteria_json() -> dict:
    """All criteria as plain JSON. Numeric dict keys use Python's :g format ("10", "8.5")."""
    companies = {}
    for name in criteria_loader.COMPANIES:
        data = dict(criteria_loader.company(name))
        if "labels" in data:
            data["labels"] = {_g(k): v for k, v in data["labels"].items()}
        if "condition_points" in data:
            data["condition_points"] = {_g(k): v for k, v in data["condition_points"].items()}
        companies[name] = data
    return {"companies": companies, "defects": criteria_loader.defects()}


def _inline_script(code: str) -> str:
    return code.replace("</script", "<\\/script")


TITLE = "Card Grading Lab"
FONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800'
    '&family=Figtree:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">'
)
# Same small reset the Claude page skeleton provides, for the GitHub Pages build.
SITE_RESET = (
    ":root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
    "img{max-width:100%}[hidden]{display:none!important}"
)


def _site_only(text: str, keep: bool) -> str:
    """Drop /*SITE_ONLY_START*/.../*SITE_ONLY_END*/ (and the HTML-comment form) unless keep.

    The Claude page viewer never allows downloads, so the backup-file download is site-only.
    """
    for start, end in (("/*SITE_ONLY_START*/", "/*SITE_ONLY_END*/"), ("<!--SITE_ONLY_START-->", "<!--SITE_ONLY_END-->")):
        if keep:
            text = text.replace(start, "").replace(end, "")
        else:
            text = re.sub(re.escape(start) + r".*?" + re.escape(end), "", text, flags=re.S)
    return text


def _parts(env: str) -> tuple[str, str, str]:
    keep = env != "artifact"
    body = _site_only((SRC / "index.html").read_text(encoding="utf-8"), keep)
    css = (SRC / "style.css").read_text(encoding="utf-8")
    criteria = json.dumps(criteria_json(), separators=(",", ":"), ensure_ascii=False)
    scripts = [f"window.GRADING_LAB_ENV={json.dumps(env)};window.GRADING_CRITERIA={criteria};"]
    scripts += [_site_only((SRC / name).read_text(encoding="utf-8"), keep) for name in ("grading.js", "vision.js", "inspect.js", "identify.js", "ocr.js", "prices.js", "webprices.js", "cardsight.js", "app.js")]
    script_tags = "\n".join(f"<script>{_inline_script(code)}</script>" for code in scripts)
    return body, css, script_tags


def render_artifact() -> str:
    """Page fragment for a Claude Artifact (the publisher adds <!doctype>, <head> and <body>)."""
    body, css, scripts = _parts("artifact")
    return f"<title>{TITLE}</title>\n{FONTS}\n<style>\n{css}\n</style>\n{body}\n{scripts}\n"


def render_site() -> str:
    """Complete, installable document for GitHub Pages."""
    body, css, scripts = _parts("site")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#e9edf1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1115" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Grading Lab">
<meta name="format-detection" content="telephone=no">
<title>{TITLE}</title>
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" href="icon-192.png">
{FONTS}
<style>{SITE_RESET}</style>
<style>
{css}
</style>
</head>
<body>
{body}
{scripts}
<script>if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {{}}));</script>
</body>
</html>
"""


SERVICE_WORKER = """// Cache-first service worker so the app opens offline after the first visit.
const CACHE = "grading-lab-%(version)s";
const FILES = ["./", "index.html", "manifest.webmanifest", "apple-touch-icon.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  // Card lookups, prices and the text reader go straight to the network: never cached here (price
  // requests carry the user's PriceCharting token).
  if (url.origin !== location.origin && !fonts) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) =>
      hit || fetch(e.request).then((res) => {
        if ((res.ok && url.origin === location.origin) || (fonts && (res.ok || res.type === "opaque"))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
    )
  );
});
"""

MANIFEST = {
    "name": "Card Grading Lab",
    "short_name": "Grading Lab",
    "description": "Theoretical PSA, BGS, CGC and TAG grade estimates for Pokémon / TCG cards",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "orientation": "portrait",
    "background_color": "#0f1115",
    "theme_color": "#0c0e12",
    "icons": [
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
    ],
}


def build(single_out: Path, site_dir: Path) -> None:
    single_out.parent.mkdir(parents=True, exist_ok=True)
    single_out.write_text(render_artifact(), encoding="utf-8")

    if site_dir.exists():
        shutil.rmtree(site_dir)
    site_dir.mkdir(parents=True)
    index = render_site()
    (site_dir / "index.html").write_text(index, encoding="utf-8")
    (site_dir / ".nojekyll").write_text("", encoding="utf-8")
    (site_dir / "manifest.webmanifest").write_text(json.dumps(MANIFEST, indent=2, ensure_ascii=False), encoding="utf-8")
    for icon in ("apple-touch-icon.png", "icon-192.png", "icon-512.png"):
        shutil.copy(ICONS / icon, site_dir / icon)
    version = hashlib.sha256(index.encode()).hexdigest()[:12]
    (site_dir / "sw.js").write_text(SERVICE_WORKER % {"version": version}, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--single", type=Path, default=ROOT / "standalone" / "dist" / "card-grading-lab.html")
    parser.add_argument("--site", type=Path, default=ROOT / "site")
    parser.add_argument("--criteria-only", action="store_true", help="print the criteria JSON and exit")
    args = parser.parse_args()
    if args.criteria_only:
        print(json.dumps(criteria_json(), ensure_ascii=False))
        return
    build(args.single, args.site)
    print(f"wrote {args.single} and {args.site}/")


if __name__ == "__main__":
    main()
