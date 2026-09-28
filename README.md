# Card Grading Lab

An in-house pre-grading tool for Pokémon and Riftbound (League of Legends TCG) cards, and other standard 63 × 88 mm TCG cards. You scan a card and log what you see. It then estimates the grade the card would receive from **PSA, Beckett (BGS), CGC and TAG**, based on each company's published grading standards. It also explains what is holding the card back at each company.

> These are theoretical estimates. The tool is not affiliated with or endorsed by PSA, Beckett, CGC or TAG, and real grades depend on each company's own inspection.

## Standalone app (no computer needed)

There is also a version that runs entirely on your phone. Pick **Pokémon** or **Riftbound** on the scan screen. The grading rules are the same, because PSA, BGS, CGC and TAG apply the same standards to all TCG cards. The photo tips, hints and example card change with the game. For Riftbound's black-bordered fronts and black Legend/Battlefield backs, photograph on a light, plain surface so the card edge stands out. Grading, centering measurement and your saved cards all stay in the browser, with no server.

- **Claude link:** a private page on your claude.ai account. Open it in Safari on the iPhone while signed in to claude.ai.
- **GitHub Pages:** a normal web address that also works offline. In Safari, tap **Share → Add to Home Screen** to open it full-screen like an app. One-time setup, which you can do from the GitHub app or github.com on your phone:
  1. Merge this branch into `main`.
  2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**. On a free GitHub plan the repository must be public for Pages to work.
  3. The **Deploy standalone app to GitHub Pages** workflow publishes the site at `https://<your-user>.github.io/<repo>/`. You can re-run it any time from the **Actions** tab.

Photos don't have to be perfectly square to the card: the app finds the card (even in a sleeve on a busy desk), straightens it, and fits it to the judging frame. If the outline is still off, open **Centering measurements → Adjust outline**, drag the four corners onto the card's corners and tap **Apply**; the card is re-flattened from your photo and re-graded. For full-art cards (no plain border), line the pink guides up with the printed frame.

Saved cards live only in the browser that saved them. Use **History → Copy backup** now and then (paste the text into Notes), and **Restore pasted backup** to bring them back or move them to another device.

The standalone app's source is in `standalone/src/`:
- `grading.js` is a JavaScript port of the Python graders.
- `vision.js` is a pure-JavaScript port of the OpenCV centering measurement.
- `app.js`, `style.css` and `index.html` are the page.

`python scripts/build_standalone.py` embeds the same `cardgrader/criteria/*.yaml` rules. It writes `standalone/dist/card-grading-lab.html` for the Claude link and `site/` for GitHub Pages. `tests/test_standalone_parity.py` checks that the JavaScript engine grades 400 random cards exactly like the Python one.

## Quick start (Python app)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python -m cardgrader.web          # opens on http://127.0.0.1:8000
```

## Using it on an iPhone

The app runs on your computer, and your iPhone opens it in Safari over your home Wi-Fi.

1. Start the app with LAN access:
   ```bash
   python -m cardgrader.web --lan
   ```
   The terminal prints the address to open on the phone, for example `http://192.168.1.20:8000`.
2. On the computer, click **On iPhone** in the top bar to show a QR code. Point the iPhone camera at it, or type the address into Safari. The iPhone must be on the same Wi-Fi.
3. In Safari, tap **Share → Add to Home Screen**. It then opens full-screen like an app, with its own icon.

On the phone, **Camera** takes the photo directly and **Photos** picks one from your library. Photos are resized and converted to JPEG on the phone before upload, which also handles HEIC. Drag the centering guides with a finger; a magnifier shows the line under your finger. The bar at the bottom always shows the four estimated grades, and tapping it jumps to the details.

For good centering from a phone photo: put the card on a dark, plain background, hold the phone parallel to the card, fill most of the frame, and avoid glare on holo cards.

> `--lan` makes the app reachable by any device on your network, with no login. Only use it on a network you trust, such as your home Wi-Fi.

## How it works

1. **Card.** Enter the name, set and number (optional, used for your history).
2. **Centering.** Upload a scan, or take a straight-on photo of the front and the back.
   - The card is found, perspective-corrected, and its border widths are measured with OpenCV.
   - Blue dashed guides mark the card edge and pink guides mark the inner frame. Drag any guide to correct it; a magnifier appears while you drag.
   - For full-art cards, or when you have no scan, type the L/R and T/B ratios directly.
   - If the image is already cropped to the card edge, tick **Already cropped**.
3. **Corners, edges & surface.** Click a zone on the card map and pick a defect type and severity:
   - **Micro** means visible only under magnification or angled light. It rules out Pristine but not Gem Mint.
   - **Minor** means visible on close naked-eye inspection.
   - **Moderate** means obvious at arm's length.
   - **Major** means heavy damage.
4. **Results** update live and show:
   - **PSA**: a single grade (PSA has no 9.5), with qualifiers (OC, ST, PD, OF, MK, MC) and "graded with a qualifier" alternatives.
   - **BGS**: four subgrades and the overall grade from Beckett's published rules: at most 0.5 above the lowest subgrade, tied lowest subgrades set the grade, and the Gem Mint 9.5, Pristine 10 and Black Label requirements apply.
   - **CGC**: subgrades, with the overall grade split between Pristine 10 and Gem Mint 10.
   - **TAG**: eight area sub-scores combined into a 100–1000 TAG Score, mapped to TAG's grade bands, with its TCG centering tolerances applied as hard limits.
   - A **best-fit** summary names the company where the card lands closest to that company's top label.
5. **Save card** stores the assessment and results in `data/cards.db`, and **History** reloads saved cards.

## Tuning the criteria

All thresholds live in `cardgrader/criteria/*.yaml`. You don't need to change any code to adjust them.

| File | Contents |
| --- | --- |
| `psa.yaml`, `bgs.yaml`, `cgc.yaml`, `tag.yaml` | Centering tables, grade labels, overall-grade rules, TAG score bands and weights. Each file lists its sources and a `last_verified` date. |
| `defects.yaml` | Each defect type, the highest condition grade each severity allows, stacking rules, and PSA qualifiers. |

Published BGS centering tables vary between sources, so check them against your own submission results and adjust. After editing, restart the app or `POST /api/criteria/reload`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/scan` | Multipart `file` (+ `mode=auto\|cropped`). Returns the warped image, guide positions, borders and centering. |
| `POST` | `/api/grade` | Takes a `CardAssessment` as JSON and returns the four company grades. |
| `GET/POST` | `/api/cards` | List or save graded cards. |
| `GET/DELETE` | `/api/cards/{id}` | Load or delete one saved card. |
| `GET` | `/api/criteria` | Returns the defect catalog and sources. |

## Development

```bash
pytest               # grader rules, centering vision, API round-trip, and JS-vs-Python parity (needs node)
```

Code layout: `cardgrader/vision` handles card detection and border measurement, `cardgrader/graders` has one module per company, `cardgrader/condition.py` turns defects into component condition, and `cardgrader/web` holds the FastAPI app and UI.
