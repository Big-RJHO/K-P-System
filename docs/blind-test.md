# Blind grading tests (PSA and TAG examples)

How well does the system grade a card from photos? Blind agents graded photos of cards whose real grade is known, using
`scripts/photo_grade.py` (the same vision, photo-check and grading rules as the app), and the answers were compared with
the slab grade (`scripts/score_blind_test.py`).

## Test material

| Set | Cards | Source | Card size in photo |
|---|---|---|---|
| PSA | 10 Shadowless Charizards, PSA 1-10 | "PSA Grading Scale in Pokemon" thread, elitefourum.com | ~550 px wide |
| TAG | 30 cards, TAG 1-10 (1, 4.5, 5 x2, 6 x3, 7 x4, 7.5 x2, 8 x5, 8.5 x4, 9 x4, 10 x4); WOTC holos, EX-era gold stars, modern full-art/SAR, Japanese | Vancity CJ Trading Cards shop listings (public Shopify product data, front + back slab photos) | ~500-1250 px wide |

- Every listed TAG grade was checked by eye against the label in the photo before use.
- The slab label (which shows the grade) was cropped off, and files were renamed and shuffled.
- TAG's own DIG reports would have given subgrades, but TAG's public API answered 403, so it wasn't used.
- The photos are third-party images and are not stored in this repository.
- Every photo shows the card inside a slab, which is the hardest realistic case: the card is seen through plastic, with slab rails and reflections along the edges.

## Method
Each round gave every card to a fresh agent: 40 per round, no card twice, a new random assignment each round.
- **Agent step.** The agent ran the scan, looked at the zoomed corner, edge and overlay images, listed what it inspected and the defects it saw, then ran the grade.
- **Automatic-only baseline.** The system alone was also scored, grading only from the detector's own edge and corner candidates.
- **Concurrency.** The platform runs at most 20 agents at once, so each round ran in two overlapping batches.

## Results

### Rounds 1-3 (before the fixes, PSA set only, 30 runs)
- **Accuracy:** 7/30 exact, 15/30 within one grade. The system was about 2.4 grades too generous.
- **Loophole:** 14 reports were firm grades even though the photo check said edges and corners couldn't be assessed.

### Round A (40 cards, after the inspection-loophole fix)
| | exact | within 1 | bias | firm (complete) reports | ceiling ≥ true grade |
|---|---|---|---|---|---|
| PSA set | 3/10 | 5/10 | +2.4 | 0/10 | 10/10 |
| TAG set | 4/30 | 9/30 | +2.0 | **10/30** | 20/20 of the incomplete ones |

- **Firm grades were wrong.** The 10 firm TAG grades were almost all wrong (1 exact, bias +1.9), including a Pristine 10 on a real TAG 7.
- **Why:** every one came from agents ticking "surface inspected" on flat photos, which can't show scratches, print lines or gloss.

### Round B (40 cards, after the surface and slab-reflection fixes)
| | exact | within 1 | bias | firm reports | ceiling ≥ true grade |
|---|---|---|---|---|---|
| PSA set | 2/10 | 4/10 | +2.6 | 0/10 | **10/10** |
| TAG set | 4/30 | 9/30 | +2.0 | 0/30 | **30/30** |

- **Ceilings are now honest.** In this round every report was a best-case ceiling, and every ceiling was at or above the real grade.
- **Agents are consistent.** Across rounds A and B, 28 of the 30 TAG cards got the same answer (mean spread 0.07 grades).
- **The misses are systematic.** Agents can't see the wear that cost these cards their grade, so they report the same too-high number every time.

### The automatic detector alone (same round-B photos, before vs after the fix)
| | exact | within 1 | mean abs error | bias | rank correlation | ceiling ≥ true grade |
|---|---|---|---|---|---|---|
| Before (commit c584678) | 5/30 | 12/30 | 1.97 | −1.00 | 0.03 | 12/30 |
| After (commit 69bb723) | 3/30 | 16/30 | 1.47 | +0.97 | 0.48 | 25/30 |

- **The big false positive is gone.** Before the fix, the detector read slab rails as "major" edge whitening: 24 likely-major candidates across the 40 cards, down to 1 after. Its answers were uncorrelated with the real grade.
- **Caveat:** the thresholds were tuned on these same photos (round A), so the "after" numbers are in-sample.
- **PSA set:** the detector can't assess anything at ~550 px, so it adds nothing there.

### Owner's sample sets (2026-10-27): one card at many grades
Two sets from the owner, each the same card at many grades. The photos aren't in the repo.
- **TAG set:** 16 copies of the Japanese Gym Heroes "Sabrina's Gengar" holo, TAG 2 to 10 including half grades. Front and back slab photos, 3400 px.
- **PSA set:** 10 Shadowless Charizards, PSA 1 to 10. Front and back, 572 px.

**Outline fix.** On about 10 of the 52 photos (all slab backs), `vision.scan` locked onto the slab or label instead of the card. It now retries other outlines and inset starts. A candidate replaces the first outline only when its corners are clearly card-like (rounded-corner score ≥ 0.75, and better than the first). All 52 outlines are now on the card.

**Light printing at the edge.** The old Japanese back has cream rays that reach the edge at the same places on every copy. Each one read as a 1 mm deep "major chip", so every TAG back looked heavily worn, the TAG 10 included.
- Real wear candidates sat 0.17–0.45 mm deep with whiteness scores of 43–77.
- The rays sat 0.5–1.3 mm deep with scores of 25–51.
- So a patch that typically reaches 0.5 mm or more into the card without being bright (score < 55) is now greyed out ("more like light printing meeting the edge than wear"). A bright, deep chip is still reported.

Detector-only grades (the scan's own likely candidates as the only defects, corners and edges counted as inspected, surface unassessed):

| TAG set (n=16) | ceiling ≥ true grade | mean abs error | bias | rank correlation |
|---|---|---|---|---|
| Before the printing rule | 8/16 | 2.50 | +0.12 | −0.21 |
| After | 14/16 | 2.75 | +2.38 | 0.22 |

- **In-sample.** The rule was found and checked on these same 16 backs, so treat the "after" row as optimistic.
- **PSA set unchanged:** 10/10 ceilings at or above the real grade, all 8–10. At 572 px the corners can't be assessed, and edge counts barely track the grade (−0.67 rank correlation with the number of edge candidates, but none are likely).
- **What tracks the grade** (TAG set, rank correlation with the real grade):
  - corner whitening fraction −0.78, which is zero for every TAG 6 and up;
  - number of edge candidates −0.69;
  - corner rounding and front centering ≈ 0, which is noise through slab plastic.
- **The two ceilings still below the real grade (TAG 9 → 8, TAG 10 → 8)** come from short whitening runs next to the slab's inner rail on the back. They are a rail touching the card, not wear, but they're too short and patchy for the rail rule.
- **Still one card design.** These sets say little about other cards, about raw cards, or about photos taken outside a slab.

## What this shows
1. **Photos of slabbed cards can't support a grade.** At 500-1000 px through plastic, neither the detector nor a careful viewer can see the wear that separates TAG 7 from 9 or PSA 3 from 8. The system now says so: every photo-only report is a ceiling, and the ceilings were never below the real grade in round B.
2. **Ordering works; absolute grades don't.** Rank correlation between the system and real grades is 0.6-0.8. Heavily damaged cards (creases, chipping) are recognised; mid-grade cards all look like 9-10.
3. **The ceiling is only as tight as the visible damage.** For clean-looking cards it stays at 9-10 whatever the real grade.
4. **Small sample.** 40 distinct cards, mostly one seller's photos, all in slabs. The numbers say little about raw cards photographed properly.

## Fixed during testing
- A tick in the checklist can no longer override the photo check (`photo_limits`, `inspected_in_hand`).
- Surface is photo-limited unless the capture used angled light (`photo_grade.py scan --angled-light`) or it was checked in hand.
- Left/right centering on the blue WOTC back was unread in 12/30 runs; the frame-edge rule now reads it.
- Slab rails and reflections are no longer reported as edge whitening; corner rounding is judged against the card's own corners.
- The grade printout lists every limit and caution instead of "Photo limits: none", and defect locations are validated.

## Still wrong or missing (seen in the runs)
- Front centering is still unread on many holo or light-border fronts (both axes on some cards).
- The front-edge check calls yellow borders "white border" and skips them.
- One back photo was found at only 295 px (card outline detection failed on the slab).
- Uniform edge wear along a whole edge can now be labelled a reflection (seen once, card c26 in round A).
- A slab's inner rail touching the card's edge for a short stretch reads as whitening (TAG 9 and 10 backs in the owner's set).
- A light label strip less than about 1 mm from the card can still be taken as part of the card (synthetic test, before and after the outline fix).
- "Up to 10" headlines are still easy to misread as grades; agents said so in most runs.

## Steps to improve (in order of value)
1. **Capture guidance and gating.**
   - Ask for raw cards (out of sleeve or slab), at least 1000 px card width, a plain contrasting background, plus one raking-light photo per side.
   - Refuse to give anything but a ceiling otherwise (already the behaviour).
   - This is the only change that can make photo grades accurate; everything else is tuning.
2. **Ground truth with subgrades.**
   - Collect 50-100 raw cards with known TAG DIG subgrades or BGS subgrades, photographed with the guided capture.
   - Measure each component (centering, corners, edges, surface) separately, and tune the detector thresholds on a separate half of the data.
3. **Fix the remaining vision gaps:**
   - holo/light-border front centering, using the printed frame or text box (see `docs/identification.md` for the reference image, which can supply the frame position);
   - the yellow-border "white border" misclassification;
   - slab outline detection on dark slabs.
4. **Report layout.** Lead with "Can't be graded from these photos — best case X" and the list of what's needed, rather than the ceiling number.
5. **Only after 1 and 2:** consider an "expected grade" estimate, calibrated on held-out data, next to the ceiling.

## Reproduce
```
python scripts/photo_grade.py scan FRONT.jpg BACK.jpg --out OUT   # add --angled-light only if the surface was checked under raking light
python scripts/photo_grade.py grade OUT/scan.json OBS.json --json RESULT.json
python scripts/score_blind_test.py KEY.json RESULTS_DIR --list
```
