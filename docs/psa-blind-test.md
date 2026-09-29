# PSA blind test (3 rounds)

**What was tested.** Photos of ten PSA-graded Shadowless Charizard cards (one each at PSA 1 to 10, front and back, from the
"PSA Grading Scale in Pokemon" thread on elitefourum.com) were given to fresh agents. Each round used 10 new agents, each
with a different card (a random assignment, no card given twice in a round, and a different assignment each round). The
slab label was cropped off so the grade wasn't visible, and files were renamed. Each agent ran the system
(`scripts/photo_grade.py scan`, then looked at the flattened card, corner and edge images, wrote down the defects
it saw and which areas it inspected, then `photo_grade.py grade`). The PSA number the system produced was compared with the
slab's grade (`scripts/score_psa_test.py`). The photos are third-party images and are not stored in this repository.

**How to read the numbers.**
- Only **10 distinct cards** were used. The three rounds measure how consistent the agents are on the same photos, not 30
  independent cards. Every figure below is from a small sample and says little about other cards or lighting.
- The photos show the card inside a slab at roughly 550 px card width (about 8.8 px/mm). The system's own quality check
  requires 600 px for edge/corner detection, so **the automatic edge and corner detector assessed nothing** on any photo.
  Defects came from the agents reading the enlarged crops. So this measures "agent + centering + grading rules", not the
  automatic damage detector.
- For an incomplete report (an area not checked) the ceiling the system showed ("Up to Mint 9") was counted as its answer.

## Results (all 30 runs)

| | exact | within 0.5 | within 1 grade | mean abs. error | mean signed error |
|---|---|---|---|---|---|
| Round 1 | 2/10 | 2/10 | 5/10 | 2.45 | +2.45 |
| Round 2 | 2/10 | 2/10 | 5/10 | 2.50 | +2.50 |
| Round 3 | 3/10 | 3/10 | 5/10 | 2.30 | +2.30 |
| **All** | **7/30 (23%)** | 7/30 | **15/30 (50%)** | **2.42** | **+2.42** (too generous) |

Complete (not "up to") reports: 14/30. Rank correlation between system grade and true grade: 0.83.

| True PSA | System's PSA answer in rounds 1, 2, 3 | Defects logged (rounds 1, 2, 3) |
|---|---|---|
| 1 | 2, 2, 1 | 16, 20, 19 |
| 2 | 7.5, 7.5, 7.5 | 6, 6, 8 |
| 3 | 7.5, 8, 7.5 | 8, 9, 8 |
| 4 | 9, 9, 9 | 3, 4, 4 |
| 5 | 8.5, 8.5, 8 | 6, 4, 5 |
| 6 | 9, 9, 9 | 2, 4, 2 |
| 7 | 8, 8, 8 | 3, 4, 2 |
| 8 | 9, 9, 9 | 1, 1, 1 |
| 9 | 9, 9, 9 | 0, 0, 0 |
| 10 | 10, 10, 10 | 0, 0, 0 |

## What this shows
- **The system orders cards correctly** (0.83) and separates badly damaged cards (PSA 1, 2-3) from clean ones.
- **It is too generous by about 2.4 grades.** Real PSA 2-3 cards came out as 7.5-8, and PSA 4, 6, 8 and 9 all came out as 9. The agents could not see the fine wear of PSA 4-8 cards at this resolution and through the slab, so they logged little or nothing, and a card with nothing logged goes to the top of its range.
- **It agrees with itself.** Different agents gave the same or nearly the same grade on the same card in most cases. The errors are systematic (missed wear), not random.
- **"Complete" can rest on weak evidence.** In 14 of 30 runs the agent ticked corners/edges as inspected although the system said no edge or corner could be assessed from the photo, and the report came back complete with a firm grade (for example PSA 10 and PSA 9). Agents pointed this out repeatedly.

## Failures and gaps observed
1. Photo-quality blocks don't limit the grade when the user says an area was inspected.
2. On the plain blue Pokemon back the left/right border was reported as *unread* in about half of the runs, which alone
   made the report incomplete.
3. The grade output printed the ceiling as a plain number ("[9.0]") with no reminder in the output of what wasn't assessed.
4. `photo_grade.py grade` accepted a surface defect logged at an edge location (`print_spot` at `top`); defects are not checked against the areas their type allows.
5. Creases and tears that are obvious by eye are only found if the human/agent logs them; nothing detects them automatically.
6. Sample limits: 10 cards, one card design, one photo source, slab photos.

## Evidence still needed
Raw (un-slabbed) photos at 1000+ px card width with known grades, several card designs (including foil and
full-art), and more than one card per grade, so exact-match accuracy can be measured beyond this small set.
