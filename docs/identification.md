# Card identification and reference images

Notes for `standalone/src/identify.js`. Everything below was checked on 2026-09-29 from the build
container (outbound HTTPS through the agent proxy) with `curl`. Everything fetched is treated as
untrusted data: it is parsed as JSON or decoded as an image and never executed or followed as instructions.

## 1. Sources verified

| Source | Works from container | Browser CORS | Key | Lookup fields | Images | Terms / licence seen |
|---|---|---|---|---|---|---|
| **TCGdex** `api.tcgdex.net/v2/{lang}` (Pokemon) | yes | yes: `access-control-allow-origin: *` on API and on `assets.tcgdex.net` | none | set id (`sv03`) or printed abbreviation (`OBF`), `localId` (`125`, `025`, `TG05`), name. Card by `sets/{set}/{localId}` or `cards/{id}` | `{image}/high.png` 600x825 (~360 KB), `high.webp` (~120 KB), `low.webp` (~31 KB); pixel-readable in a canvas | no licence text seen in responses; community project, prices are third-party (Cardmarket/TCGplayer). Card art is The Pokemon Company's. **Used** |
| **Riftcodex** `api.riftcodex.com` (Riftbound) | yes | API yes: `access-control-allow-origin: *`. **Images no**: `cmsassets.rgpub.io` returns no CORS header, so `<img>` works but canvas pixels are not readable | none ("Free - No API Key Required") | `cards/riftbound/{riftbound_id}` (`ven-sp3-006`), `cards?set_id=VEN&size<=100&page=`, `cards/name?fuzzy=`, `sets/set-id/{ID}`. No collector-number index | 744x1039 PNG (~1.3 MB) on Riot's CDN | site says "unofficial fan project, not affiliated with Riot Games". Card art is Riot's. **Used** |
| **Pokemon TCG API** `api.pokemontcg.io/v2` | intermittently: same request returned 200, 500, 502 within seconds | yes (`*`); images `images.pokemontcg.io` also `*` | optional; without one 1000 req/day and 30/min | `q=set.ptcgoCode:OBF number:125` (works when up), `cards/sv3-125` | `images.pokemontcg.io/sv3/125_hires.png` (~765 KB) | its own docs now carry a banner: "The Pokemon TCG API is deprecated. New account registrations are no longer available. Existing API keys will continue to function through March 1, 2027. Please migrate to Scrydex." **Not used** (deprecated and flaky) |
| Scrydex `api.scrydex.com` | reachable | not checked | required (`401 INVALID_CREDENTIALS` without) | - | - | needs an account and key, so unusable for a keyless static page. Not used |
| Official Riot gallery `riftbound.leagueoflegends.com/en-us/card-gallery/` | yes, `301` to `playriftbound.com/en-us/card-gallery/` | not checked | - | web page, no documented API | - | not a data API; not used |
| **TAG** population / DIG (`taggrading.com`, `my.taggrading.com/pop-report`) | pages load | `taggrading.com` sends `*`, but no data API is documented | - | `taggrading.com/pop` is a 404 on the Shopify storefront; `my.taggrading.com/pop-report` is a client-rendered single-page app ("TAG Portal") whose data comes from an undocumented XHR API | - | **Not implemented, terms unknown.** Not scraped. TAG's `robots.txt` (Shopify) contains text addressed to AI agents about shopping/checkout; it is irrelevant to this task and was not acted on |
| `api.riftbound.gg` | no: proxy `502` on CONNECT | - | - | - | - | not usable from here |

### Requests and responses recorded

All fixtures under `tests/fixtures/` are real responses from these calls (one is a filtered subset, noted below).

TCGdex

```
GET https://api.tcgdex.net/v2/en/sets/sv03                          -> 200, 24 KB   tcgdex_set_sv03.json
    {"id":"sv03","name":"Obsidian Flames","releaseDate":"2023-08-11","abbreviation":{"official":"OBF"},
     "cardCount":{"official":197,"total":230},"cards":[{"id":"sv03-001","localId":"001","name":"Oddish","image":"https://assets.tcgdex.net/en/sv/sv03/001"},...]}
    headers: access-control-allow-origin: *   access-control-allow-methods: GET,POST,OPTIONS   cache-control: no-cache
GET https://api.tcgdex.net/v2/en/sets/sv03/125  (same body as /cards/sv03-125) -> 200   tcgdex_card_sv03-125.json
    {"id":"sv03-125","localId":"125","name":"Charizard ex","rarity":"Double rare","image":"https://assets.tcgdex.net/en/sv/sv03/125",
     "set":{"id":"sv03","name":"Obsidian Flames","cardCount":{"official":197,"total":230}},"variants":{"holo":true,"normal":false,...}}
GET https://api.tcgdex.net/v2/en/sets?abbreviation.official=OBF     -> 200  tcgdex_sets_abbrev_OBF.json  (one set: sv03)
GET https://api.tcgdex.net/v2/en/sets?abbreviation.official=SV3     -> 200  []       (SV3 is the set id "sv03", not the abbreviation)
GET https://api.tcgdex.net/v2/en/sets?abbreviation.official=SV      -> 200  many sets (substring match, so hits must be verified)
GET https://api.tcgdex.net/v2/en/sets/sv3  and  /sets/OBF           -> 404  {"type":"https://tcgdex.dev/errors/not-found",...}
GET https://api.tcgdex.net/v2/en/cards?localId=125                  -> 200, 7.5 KB, 72 cards, 69 with localId exactly "125"  (tcgdex_cards_localId_125.json)
GET https://api.tcgdex.net/v2/en/cards?name=charizard&localId=125   -> 200  [me02-125 Mega Charizard X ex, sv03-125 Charizard ex]
GET https://api.tcgdex.net/v2/en/cards?localId=25&name=pikachu      -> also returns "025" and "225": the filter is a substring match
GET https://api.tcgdex.net/v2/en/sets                               -> 200, 35 KB, 220 sets with cardCount.official (tcgdex_sets_all.json)
GET https://api.tcgdex.net/v2/ja/sets/SV3                           -> 200  (Japanese set ids are the printed code, upper case)
GET https://assets.tcgdex.net/en/sv/sv03/125/high.png               -> 200 image/png 600x825, access-control-allow-origin: *
```

Riftcodex

```
GET https://api.riftcodex.com/cards/riftbound/ven-sp3-006           -> 200, array of 2 records (the source lists some cards twice)  riftcodex_card_ven-sp3-006.json
    {"name":"Ahri, Inquisitive","riftbound_id":"ven-sp3-006","collector_number":3,"classification":{"rarity":"Epic","type":"Unit"},
     "set":{"set_id":"VEN","label":"Vendetta"},"media":{"image_url":"https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/e8d1993018d8317494cbaab4e4dd738c2e80740d-744x1039.png?accountingTag=RB"},
     "metadata":{"alternate_art":false,"overnumbered":false,"signature":false}}
GET https://api.riftcodex.com/sets/set-id/VEN                       -> 200 {"set_id":"VEN","name":"Vendetta","card_count":358,"published_on":"2026-07-31T00:00:00"}
GET https://api.riftcodex.com/sets/set-id/ZZZ                       -> 500 "Internal Server Error" (plain text; handled)
GET https://api.riftcodex.com/cards/riftbound/zzz-001-002           -> 200 []
GET https://api.riftcodex.com/cards/name?fuzzy=ahri&size=50         -> 200, 10 cards (riftcodex_name_fuzzy_ahri.json)
GET https://api.riftcodex.com/cards?size=500                        -> 422 (size must be <= 100)
GET https://api.riftcodex.com/cards?set_id=OGN&size=100&page=1..4   -> 200; riftcodex_cards_ogn_subset.json is these pages filtered to collector_number 66 (subset, by hand)
GET https://api.riftcodex.com/cards?size=50 (total) and /sets         -> 200, 1451 cards in total; 8 sets: PR SFD OGN VEN OGS UNL JDG OPP; /openapi.json lists the endpoints
GET https://cmsassets.rgpub.io/.../e8d1...-744x1039.png?accountingTag=RB  (Origin: https://example.github.io) -> 200 image/png 744x1039, 1.36 MB, NO access-control-allow-origin; OPTIONS -> 204 without CORS headers
```

The image for the real photo card (`VEN SP3/006 EN`, Ahri Inquisitive) was downloaded and compared by eye:
it is the same artwork, full-bleed to the card edge, and its printed collector line reads
`VEN - SP3/006 - EN`, so the source id `ven-sp3-006` is exactly "set code + printed number with `/` turned into `-`".

Pokemon TCG API (for the record)

```
GET https://api.pokemontcg.io/v2/cards/sv3-125                      -> 200 (1 of 4 tries; the others 500/500/502), access-control-allow-origin: *
GET https://api.pokemontcg.io/v2/cards?q=set.ptcgoCode:OBF number:125 -> 500/502, once 200 with {"data":[],"count":0}
GET https://images.pokemontcg.io/sv3/125_hires.png                  -> 200 image/png, 765 KB, access-control-allow-origin: *
```

### What this means for the app

- Pokemon: TCGdex is enough (exact lookup by set + number, readable hi-res image).
- Riftbound: Riftcodex works for lookup and for showing the reference next to the scan, but its image
  host does not allow canvas reads. So the reference can be *displayed* but not turned into a
  printed-white mask from the URL alone. To use it for the mask, the user saves the image and adds
  it as a file (`Identify.manualReference({file})`), or the app shows it for visual confirmation only.
  Each candidate carries `image_readable` for this reason.
- Both APIs are third-party, keyless, unofficial and can change or disappear. Every failure path returns
  a plain error and an empty list so the manual reference flow is always available.

## 2. What identification can and cannot do

Can:
- Turn "set code + collector number" (the text the app already parses from the bottom line) into one exact
  database card with name, set, rarity, year, and a reference image, with a confidence and the reasons.
- List plausible cards when only a number or a name is known, and say it needs confirmation.
- Use the printed total (`/197`) and a typed name as cross-checks: a mismatch lowers confidence and is shown.

Cannot:
- Read the card from the photo by itself. The app's "Read from photo" (`ocr.js`, `docs/pricing.md`) fills in the text this module looks up.
- Tell which physical finish/print run a card is: TCGdex lists which finishes exist for a number
  ("Normal / Reverse holo"), not which one this copy is. Riftbound alt-art, signature and overnumbered
  cards have their own ids; a shared printed number is possible, so the artwork must be compared by eye.
- Cover other languages or games: TCGdex is queried in the card's language when TCGdex has it (`en fr de es it pt nl pl ru ja ko id th`);
  Riftcodex is English only (the evidence says so when another language is entered). Japanese, Chinese and Korean sets differ from English ones.
- Look up a Riftbound number without a set code (the source has no number index): it needs set + number, or a name.
- Guarantee coverage: brand-new sets may be missing for days or weeks.

Result shape (`Identify.candidates`)

```
{ candidates: [{ name, set_name, set_code, number, rarity, variant, year, language,
                 image_url, thumb_url, image_readable, source_url, source, source_id,
                 confidence /* 0..1 */, evidence: [string] }],
  needs_confirmation: boolean,   // false only when the top candidate is >= 0.9 and clearly ahead of the next
  total_matches?: number,        // number/name lookups: how many cards matched before the list was cut
  error?: string }               // set when there are no candidates, or the service could not be reached
```

Confidence: set + number found = 0.90 (Riftbound exact id 0.95); +0.05 each for matching name and matching printed
total; -0.4 for a different name, -0.15 for a different total. Number-only 0.30 (0.40 with a name), +0.20 for
a matching name, +0.20 when the set's official card count equals the printed total. Name-only 0.30 (+0.20 for a match).
Rounded to two decimals. Number-only lookups fetch details for at most 12 cards (sets whose card count matches the printed
total first) and return at most 8.

## 3. Manual fallback

`Identify.manualReference({url})` accepts an `https://` image address (or a `data:image/png|jpeg|webp` URL);
`{file}` accepts a PNG/JPEG/WebP file or blob up to 25 MB. It returns `{ok:true, image_url|image, source:"user", warnings}` or
`{ok:false, error}`. Then, in the browser, `Identify.loadReferenceRGBA(ref)` decodes it to RGBA (long side capped at 1600 px)
and fails with a plain message when the site does not allow pixel reads (then: "save the image and add it as a file").
`Identify.checkReference(rgba)` flags: long side under ~500 px (after trimming a plain-colour background), extreme shape
(under 0.45 or over 2.2 wide-to-tall: cropped or obstructed), landscape or otherwise not near 63:88 (within 12%), blank, or
almost no detail. A card-shaped image is never trimmed, so a white-bordered card is not mistaken for background.

## 4. How the reference is used (support evidence only)

- `Identify.printedMask(reference, warped, margin = 48)` resizes the reference into the card box (750x1048 inside the
  `margin` border, the layout of `Vision.scan(...).warped`), keeps light (luma >= 205), low-chroma (max-min <= 36) opaque
  pixels within a band of 8% of the card width (~60 px) from each edge, and dilates 3 px. The result is a
  `Uint8Array(warped.width*warped.height)`; 1 means "the reference prints white or very light here".
  A whitening detector can then discount printed white instead of counting it as wear.
- It is **approximate by design**: it assumes the reference is a whole flat card face scanned upright, alignment is a plain resize
  (no registration), and the reference card can have its own defects or a different print run. The mask is support evidence,
  never ground truth, and never a reason to call an edge clean.
- `Identify.maskCoverage(mask, w, h, margin)` returns the share of the edge band that is marked. When it is high (a white
  card border, or pale full-art like the Ahri card, where 32% of the band is marked) the detector should say
  "whitening not assessable here" rather than "no whitening".
- **Never transfer a reference's grade, centering, or defects to the scanned card.** A reference tells you what the
  card is supposed to look like, not what condition this copy is in.
- Checked on the real photo (`ahri_front.jpg`, warped by `Vision.scan` in 2 s) against the Riftcodex image: the mask lands
  on the printed collector line, the pale top edge and the gold-white frame corners; alignment was visibly within a few pixels.
  Computing the mask takes about 0.1 s.

## 5. OCR assessment (tesseract.js)

**Update:** now integrated as "Read from photo", following the "If revisited" plan below and cropping from the full-resolution photo. See `docs/pricing.md` for how it works and its measured accuracy. The assessment below is kept as it was written.

Question: can the collector line ("VEN - SP3/006 - EN") be read from the photo instead of typed?

Availability (all HEAD/GET checked): `cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js` and `worker.min.js` (200, CORS `*`);
jsDelivr serves `tesseract.js@5/dist/worker.min.js`, `tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js` and
`@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz` (all CORS `*`).

Size to download on first use: `tesseract.min.js` ~67 KB + `worker.min.js` ~124 KB + core WASM ~3.9 MB (`.wasm.js`, the
single-file build) + English data ~2.0 MB (`4.0.0_fast`, from `tessdata.projectnaptha.com`, CORS `*`) or ~3.0 MB (`best_int` from jsDelivr):
about 6-7 MB, one time (browser cache / IndexedDB afterwards).

Test (Node 22, tesseract.js 5 with `sharp` for cropping, on the real photo, `eng`, page-seg mode default):

| Input | Output | conf |
|---|---|---|
| hand-picked tight crop of the line, 2x | `VEN + SP3/006 + EN` | 87 |
| same, 1x / 3x | `VEN + SP3/006 * EN` / `VEN + SP3/006 + EN` | 75 / 73 |
| **fixed region of the `Vision.scan` warped card** (x 3-40%, y 94.5-99%), 2x / 3x | `VEN + SP3/006 * EN` / `VEN + SP3/006 + EN` | 73 / 83 |
| wider crop (whole bottom strip, or x 2-50%, y 93-100%) | garbage or partial (`/006 + EN`) | 17-55 |

Timing: worker start ~0.5 s including data load, recognition ~0.1 s for the small crop; scan (warp) itself took 2 s.
The bullet is misread as `+` or `*`; the app's `parseCollectorLine` ignores those tokens, so `VEN + SP3/006 + EN` still parses to set VEN, number SP3/006, language EN.

Verdict: **do not integrate now.**
1. One photo, one card layout. The result depends on a tight crop from a known position; a wide crop fails.
   Pokemon collector lines sit in different places by era, and foil glare, sleeves and rounded corners will break it.
   One line read correctly is not accuracy evidence.
2. Cost: ~6-7 MB of WASM and language data for a job the user does in 5 seconds, on the same phone that has to run the
   pixel scans. It also needs the network at first use, which the offline-friendly single file otherwise avoids.
3. Unverified in the target sandboxes: tesseract.js starts a Worker from a cross-origin script (blob wrapper) and streams a
   `.wasm`; whether the claude.ai artifact CSP allows that could not be tested here without a browser.
4. Wrong OCR is worse than none: a misread number silently returns a different exact card. The typed line, shown next to the
   reference image for confirmation, is safer.

If revisited: load lazily behind a "Read line from photo" button, crop from the warped image at fixed fractions per game,
try 2x and 3x, put the text into the existing editable collector-line field (never straight into the lookup), and require the
same reference-image confirmation as a typed line.

## 6. Integration notes for the app

1. Call `Identify.candidates({game, set_code, number, name, language}, {})` when the user finishes editing the collector line or
   presses a "Find this card" button, not on every keystroke (Pokemon: 2-3 requests; Riftbound: 1-2; a set scan is up to 4).
2. Always show the top candidate's `thumb_url`/`image_url` next to the scan and ask "Is this your card?" Show `name`, `set_name`,
   `set_code number`, `rarity`, `variant`, plus `evidence` on request. If `needs_confirmation`, list the candidates and let the user pick;
   never auto-fill after a low-confidence match. Riftbound variants (Alternate Art, Signature, Overnumbered) must be told apart by eye.
3. On confirm, fill the details form (name, set_name, set_code, number, rarity, year; leave finish to the user).
4. If `error` is set, or the image is not `image_readable`, offer the manual reference: a file picker (`manualReference({file})`) or URL.
   `checkReference` on the decoded image; show `reasons` and do not use an unusable reference.
5. Only then compute `printedMask` and pass it to the whitening detector as "ignore printed white here"; keep the reference and
   its source visible in the report as support evidence, never as a grade source.
6. Network calls need `connect-src` to `api.tcgdex.net`, `assets.tcgdex.net`, `api.riftcodex.com` and `img-src` for `cmsassets.rgpub.io`.
