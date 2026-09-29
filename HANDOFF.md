# Handoff: Card Grading Lab (K-P-System)

State as of 2026-09-29. `main` is at `f584de6` (PR #4 merged). Everything below is live unless marked otherwise.

## What it is

A pre-grading tool for Pokémon and Riftbound cards. You photograph the front and back, and it:
1. finds and flattens the card;
2. measures centering and checks the photo's quality;
3. flags likely edge and corner wear;
4. estimates PSA, BGS, CGC and TAG grades from each company's published standards;
5. identifies the card and shows prices.

It never claims a firm grade from photos alone. Anything the photos can't show stays "not checked", and the grade becomes a best-case ceiling ("Up to 9 · incomplete").

| Where | URL | Notes |
|---|---|---|
| Phone app (GitHub Pages) | https://big-rjho.github.io/K-P-System/ | Installable (Add to Home Screen) and works offline. Deployed by `.github/workflows/pages.yml` on every push to `main` and daily at 21:37 UTC. |
| Phone app (Claude link) | https://claude.ai/artifact/6Kb2mGoimCu2Zv7Kxd61VB | Private to the owner. Republished by hand (see Deploy). |
| Python app | `python -m cardgrader.web` | Older FastAPI UI. Same grading engine and criteria. |

## Repository map

| Path | What |
|---|---|
| `cardgrader/criteria/*.yaml` | **Single source of the grading rules**: per-company scales, centering tables and defect caps. Python and the phone app both read these. |
| `cardgrader/` | Python engine (`engine.py`, `condition.py`, `graders/`), OpenCV vision (`vision/`), FastAPI app (`web/`). |
| `standalone/src/grading.js` | JS port of the Python graders. `tests/test_standalone_parity.py` checks 400 random cards grade identically in both. |
| `standalone/src/vision.js` | Card finding and flattening. It uses a rounded-corner test to tell the card's edge from a sleeve or slab edge, then measures centering. |
| `standalone/src/inspect.js` | Photo-quality gate (blur, glare, resolution, cut-off, tilt, sleeve) and edge/corner wear candidates. |
| `standalone/src/identify.js` | Card lookup: TCGdex (Pokémon) and Riftcodex (Riftbound). |
| `standalone/src/geminiid.js` | Reads the card from the front photo with Gemini (user's key). |
| `standalone/src/ocr.js` | On-phone fallback reader (tesseract.js, loaded from a CDN on first use). |
| `standalone/src/cardsight.js` | Pokémon sale prices, raw and graded, from CardSight (user's key). |
| `standalone/src/rbprices.js` | Riftbound TCGplayer prices from the daily `riftbound-prices.json`. |
| `standalone/src/webprices.js` | Gemini with Google Search grounding: web price search (user's key; needs billing). |
| `standalone/src/prices.js` | PriceCharting API (user's paid token only), plus TCGdex's free ungraded prices. |
| `standalone/src/app.js`, `index.html`, `style.css` | The phone UI. |
| `scripts/build_standalone.py` | Builds `standalone/dist/card-grading-lab.html` (Claude link) and `site/` (Pages), including the service worker. |
| `scripts/fetch_riftbound_prices.py` | Downloads Riftbound prices from tcgcsv.com into `site/riftbound-prices.json` (run by the Pages workflow). |
| `scripts/photo_grade.py`, `scripts/score_blind_test.py` | Command-line scan and grade, and blind-test scoring. |
| `docs/blind-test.md` | Accuracy study: what photo-only grading can and can't do. **Read this first.** |
| `docs/pricing.md` | Card reading and every price source: access, cost, terms, what was tested. |
| `docs/identification.md` | Card-database sources and the reference-image mask. |
| `Ho's System.app.zip` | A macOS app bundle uploaded by the owner on 2026-09-03 (commit `47efb4e`). Not used by this project, and its purpose is unknown. Ask before touching it. |

## How a scan flows (phone app)

1. **Photos:** `vision.scan()` finds the outline, then `resolveEdges` iterates until the outline stops moving, then the card is warped to 750×1048 and the borders are measured.
2. **Checks:** `inspect.js` quality gate. What a photo can't show becomes `photo_limits`. Surface is always photo-limited unless it was checked in hand.
3. **Grade:** `Grading.gradeAll(assessment, criteria)`. Unchecked areas make the grade a ceiling. The user can tick "checked in hand" to override a photo limit.
4. **Identify:** Gemini reads the photo if a key is saved (otherwise on-phone OCR). Then TCGdex or Riftcodex is searched, and the **user confirms** the card with "This is my card". Nothing is used unconfirmed.
5. **Prices:** chosen by game:
   - **Pokémon:** CardSight (if key saved), with TCGdex as a fallback.
   - **Riftbound:** TCGplayer via the daily file.
   - **Both:** optional Gemini web search; PriceCharting only with a token.

## Keys and outside services

**No key is ever in the repo or the published page.** Each user pastes their own key in the Prices panel. Keys are stored in the phone's `localStorage` only and excluded from backups, drafts and History.

| Service | Used for | Cost | Terms that shaped the code | Live-tested? |
|---|---|---|---|---|
| Gemini API (`generativelanguage.googleapis.com`) | Card reading (`gemini-3.5-flash-lite`, image and JSON schema) | Free tier works | On the free tier Google may use the photos; the UI says so | **Yes**: 31/31 numbers, 30/30 names on the test photos |
| Gemini, Google Search grounding | Web price search | **Needs billing on the key**: 5,000 searches a month free, then $14 per 1,000 | Must show Google's search suggestions; results can't be cached; can't be used to find pages to scrape | Only the error paths (free key gets 429 "check your plan and billing"). `gemini-2.5-flash` is refused to new users (404). |
| CardSight AI (`api.cardsight.ai`) | Pokémon raw and graded sale prices | Free plan: 750 calls a month, hard cap. The app uses 2 calls per card. | Key is personal and can't be shared. Short-term caching only, so 24 h, purged on key removal. | **No**: built from their OpenAPI spec. The first real lookup may need tweaks (set naming, grade values). |
| tcgcsv.com | Riftbound TCGplayer prices, ungraded | Free | FAQ invites programmatic downloads; we send an identifying User-Agent, about 27 requests a day | **Yes**: the Pages build fetched 1,510 cards |
| TCGdex, Riftcodex | Card lookup, reference images, TCGdex ungraded prices | Free, no key | — | Yes |
| PriceCharting API | Raw and graded prices | Paid subscription token | Data is for the subscriber's internal use only. **Don't scrape PriceCharting or relay it through Gemini**: its terms forbid its prices in apps without written permission. Its figures are filtered out of the web search. | No (no token) |

**Security note:** the owner's Gemini key was pasted into the chat that built this. It's not in the repo, but it should be deleted in Google AI Studio and replaced.

## Build, test, deploy

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
pytest                                   # 144 passed, 2 skipped; JS tests need node
python scripts/build_standalone.py       # -> standalone/dist/card-grading-lab.html and site/
python scripts/fetch_riftbound_prices.py # optional locally: -> site/riftbound-prices.json
```

- **GitHub Pages:** automatic on merge to `main` and daily. The Riftbound download step is `continue-on-error`, so a tcgcsv outage doesn't block a deploy.
- **Claude link:** build from `main`, then republish `standalone/dist/card-grading-lab.html` to the artifact URL above. It has to be published from a claude.ai session with access to that artifact.
- **Service worker:** cache-first for the app itself, versioned by a build hash. It skips cross-site requests (APIs, CDN), and fetches `riftbound-prices.json` network-first.
- **Branches:** work has been done on `claude/card-grading-system-dn1d8q` and merged by PR (#1–#4). After a merge, restart that branch from `main` for new work.

## What's been measured

- **Grading from photos** (`docs/blind-test.md`):
  - Tested on 10 PSA-graded and 30 TAG-graded slab photos.
  - Since the evidence fixes, every report is an honest ceiling, and every ceiling was at or above the real grade in the last round.
  - Absolute grades from slab photos are not reliable (bias about +2). The ranking of cards correlates with real grades at about 0.6–0.8.
  - Heavily damaged cards are recognised; mid-grade cards look like 9–10 in photos.
- **Card reading:** Gemini 31/31 versus the on-phone reader 15/31 on the same photos.

## Known gaps and next steps (in priority order)

1. **Try CardSight with a real key.** Fix set-name matching or grade parsing if needed. Then consider its photo identification endpoint for Pokémon.
2. **Guided capture.** Raw card, at least 1,000 px wide, plus a raking-light photo per side. This is the only thing that can make photo grades accurate (see `docs/blind-test.md`).
3. **Ground truth.** 50–100 raw cards with known TAG or BGS subgrades, to tune the detector per component on held-out data.
4. **Vision gaps:**
   - holo and light-border front centering;
   - yellow borders misread as "white border";
   - slab outline on dark slabs;
   - uniform edge wear sometimes filtered as a reflection.
5. **Report wording:** lead with "Can't be graded from these photos — best case X" rather than the number.
6. **Graded Riftbound prices** only exist through Gemini web search, which needs billing. There's no free source.
7. **Claude link unchecked:** it's untested whether the claude.ai page is allowed to call Gemini, CardSight and the CDN. GitHub Pages is known to work.
8. **Python web app UI** lags the phone app: no identification, no prices, older inspection flow.

## Ground rules kept so far

- **Reference cards:** never transfer a reference card's grade or defects to the user's card. References only mask printed white.
- **Evidence:** nothing counts as flawless without evidence. A checklist tick can't override what the photo check says it couldn't see, except "checked in hand".
- **Access:** use only permitted access. No scraping where terms forbid it, no working around CORS or API blocks, and cite price sources.
- **Two engines:** keep the Python and JS engines identical (the parity test) and the YAML criteria as the single source of rules.
- **Keys:** keep keys out of the repo, builds, backups and logs.
