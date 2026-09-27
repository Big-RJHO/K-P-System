# Card Grading Lab

An in-house pre-grading tool for Pokémon / TCG cards. You scan a card and log what you see. It then estimates the grade the card would receive from **PSA, Beckett (BGS), CGC and TAG**, based on each company's published grading standards. It also explains what is holding the card back at each company.

> These are theoretical estimates. The tool is not affiliated with or endorsed by PSA, Beckett, CGC or TAG, and real grades depend on each company's own inspection.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
python -m cardgrader.web          # opens on http://127.0.0.1:8000
```

## How it works

1. **Card.** Enter the name, set and number (optional, used for your history).
2. **Centering.** Upload a scan or a straight-on photo of the front and the back.
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
pytest               # grader rules, centering vision on synthetic scans, API round-trip
```

Code layout: `cardgrader/vision` handles card detection and border measurement, `cardgrader/graders` has one module per company, `cardgrader/condition.py` turns defects into component condition, and `cardgrader/web` holds the FastAPI app and UI.
