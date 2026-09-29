# Reading the card from the photo, and its prices

Reading the card: Gemini when a Gemini key is saved (section 5, 31/31 on the test photos), otherwise the on-phone reader (section 1, 15/31).

Price sources in the app:
- **Pokémon:** CardSight sales (section 4).
- **Riftbound:** TCGplayer market prices from a daily file (section 6), ungraded only.
- **Web search (Gemini):** graded prices for Riftbound, and optionally for Pokémon (section 3). Needs billing on the Gemini key.
- **PriceCharting:** only with your own subscription token (section 2).
- **TCGdex:** free ungraded Pokémon prices, as a fallback.

Two steps run after a scan:

1. **Read.** The app reads the card's name and collector number from the front photo.
2. **Price.** It looks the card up and fetches PriceCharting prices for the ungraded card and for the grade this report gives.

Code is in `standalone/src/ocr.js` and `standalone/src/prices.js`, wired up in `app.js`. Everything was checked on 2026-09-29.

## 1. Reading the card (`ocr.js`)

### How it works
- **Text reader.** It uses tesseract.js 5.1.1 in the browser. The library comes from cdnjs, the engine and English data from jsDelivr. That's about 7 MB, downloaded the first time only and cached by the browser afterwards.
- **What's sent.** Only the text it reads (name, number, set code) goes to the card database. Photos never leave the phone.
- **Where it reads.** It crops from the original photo at full resolution, following the scanned card outline, not the 750 px flattened copy, where the number is only about 12 px tall.
  - The name is read at the top of the card.
  - The number is read in the bottom corners: bottom right on WOTC-to-DP era cards, bottom left from Black & White on and on Riftbound.
- **Two methods for the number, which vote:**
  - *Rows.* Find rows of character-sized marks, keep only those marks (black on white), and read each row alone. This copes with holo patterns and art behind the text.
  - *Plain.* Read the whole corner crop. This works on clean borders.
- **Parsing.** Numbers and set codes are taken from the text, allowing for common misreads: `O`/`0`, `I`/`1`, `5V` for `SV`, and `+` or `*` for the bullet in "VEN · SP3/006 · EN".

### What happens with the reading
- It fills the details form.
- It runs the card lookup, most specific first:
  1. set + number;
  2. number, with the name as a check;
  3. the full name;
  4. the longest word of the name.
- **Nothing is used until the user taps "This is my card"** next to the database picture, the same as for typed details. A misread digit therefore can't silently pick a different card.
- It runs automatically once when the report opens for a new scan, as long as the name and number are still empty. The **Read from photo** button runs it again.

### Measured on real photos
- **Test set:** the 30 TAG-slabbed Pokémon cards from the blind test (`docs/blind-test.md`), plus the real Riftbound photo.
- **Truth:** the name and number are known from each listing.
- **Conditions:** photos 1,160–1,510 px wide, all cards inside slabs.
- **Runtime:** Node, same code as the app.

| | Result |
|---|---|
| Collector number read correctly | 15 / 31 |
| Number read wrong | 1 / 31 (111/115 read as 11/115; the lookup then offered a different card at 45%, for the user to reject) |
| Name read (English cards) | 21 / 27 (no Japanese reading: English data only) |
| Name or number read | 26 / 31 |
| **Right card shown first** by the lookup that follows | **16 / 31** |
| **Right card among the options shown** | **18 / 31** |
| Reading time (Node, per card) | median 1.1 s, max 2.5 s |

- **Browser check:** in a headless iPhone-sized Chromium, a slabbed Base Set Blastoise went from **Get report** to the candidate list in 5–6 s, including the lookup. The text reader's files were served locally in that test.

### Where it fails
- Numbers printed on dark or grey panels (2006 gold-star cards).
- Legendary Collection reverse-holo "fireworks".
- Cards where the slab outline was taken for the card.
- Japanese cards: the name isn't read at all, and English TCGdex doesn't list Japanese numbering.
- Raw cards photographed flat and sharp should do better than slabs, but that hasn't been measured.

## 2. Prices (`prices.js`)

### Source: PriceCharting API
- **Endpoints:** `https://www.pricecharting.com/api/products?t=TOKEN&q=…` and `/api/product?t=TOKEN&id=…`.
- **Access:** needs the user's own **paid PriceCharting subscription token** (40 characters, from their Subscription page → API/Download). Without one, the API answers `{"status":"error","error-message":"Unknown access token"}`. No token was bought or used for this work.
- **Format:** responses carry `Access-Control-Allow-Origin: *`, so the phone app can call it directly. Prices are whole cents.
- **Rate limit:** one call per second. The app spaces calls 1.1 s apart and caches each answer for 24 h (PriceCharting regenerates prices daily).
- **Licence:** "internal use only". Sharing the data with others needs PriceCharting's commercial licence, and data must be purged when the subscription ends.
  - The app therefore uses each person's own token, kept only on their phone.
  - The token is never in backups, History or drafts, and is sent only to pricecharting.com.
  - **Remove** deletes the token and every cached price.
  - The service worker doesn't touch cross-site requests.
- **Checks:** the API documentation and the "Unknown access token" reply were checked live. The app's own calls were tested with a stand-in server returning the documented shape. **They have not been tested against the real API**, because that needs a paid token.

### Finding the right product
- **Search text:** built as PriceCharting names cards, e.g. `Charizard #4 Pokemon Base Set` or `Ahri, Inquisitive #SP3 Riftbound Vendetta`.
- **Ranking:** results are ranked by matching number, then name, then set.
- **Versions:** bracketed versions ("[1st Edition]", "[Shadowless]", "[Reverse Holo]", "[Foil]", "[Prize Pack]"…) rank below the plain card unless the finish entered matches.
- **When other versions exist,** the panel says so and offers a version picker, because they differ a lot in price. For Base Set Charizard #4, the ungraded 1st Edition sells for over 25 times the unlimited card.

### Grade → PriceCharting price
From PriceCharting's key list for cards:

| Grade | PriceCharting price |
|---|---|
| Ungraded | `loose-price` |
| 1, 2, 3, 4, 5, 6 | `condition-9`, `-10`, `-13`, `-14`, `-15`, `-16-price` |
| 7 / 7.5 | `cib-price` |
| 8 / 8.5 | `new-price` |
| 9 | `graded-price` |
| 9.5 | `box-only-price` |
| PSA 10 | `manual-only-price` |
| BGS 10 (Pristine) / BGS Black Label | `bgs-10-price` / `condition-20-price` |
| CGC 10 (Gem Mint) / CGC Pristine 10 | `condition-17-price` / `condition-19-price` |
| TAG 10 | `condition-21-price` (one TAG 10 price, Gem Mint and Pristine together) |

- **Grades 1–9.5** are PriceCharting's price for that grade from *any* grading company. The panel says so.
- **Half grades 1.5–6.5** use the whole grade below, with a note.

### How prices are shown
- **Ceilings stay ceilings.** When the report is incomplete, each row reads "PSA up to …". A warning says these are the most the card could fetch at those grades, not what it's worth.
- **No PriceCharting token:**
  - The panel links to PriceCharting's own search page for the card, which the user opens themselves; nothing is scraped.
  - For Pokémon, it shows the free ungraded market prices from the TCGdex card record: TCGplayer (USD) and Cardmarket (EUR).
  - For Riftbound, it links to the card's TCGplayer page.

### Not available
- Graded prices without a PriceCharting subscription. Scrydex also needs a paid key, and TCGdex has ungraded prices only.
- Sales history: PriceCharting's API gives current values only.

## 3. Web search for prices (`webprices.js`, Gemini)

PriceCharting's terms don't allow its data in this app without a subscription and permission. So the app can instead ask Google's Gemini to search the web and report what the card recently sold for.

### How it works
- **Trigger:** runs only when you tap **Search the web for prices** (Prices panel). It needs a confirmed card name.
- **Key:** it uses your own Gemini API key, which you get at aistudio.google.com.
  - The key is stored only on the phone, never in backups, History or drafts.
  - It is sent only to `generativelanguage.googleapis.com`, in the `x-goog-api-key` header, never in the URL.
- **Request:** one `generateContent` call with the `google_search` tool (Grounding with Google Search). The prompt gives:
  - the card's name, set, number, finish and language;
  - the grades wanted: ungraded, each company at this report's grade, plus PSA 10 and PSA 9.
- **What the prompt asks for:**
  - completed sales from the last 12 months;
  - the exact version of the card;
  - no invented numbers;
  - no pricecharting.com;
  - one JSON reply.
- **What the app keeps from the reply:**
  - prices with a number, one of the grades asked for, and a source site;
  - PriceCharting figures are dropped even if Gemini returns them;
  - a price whose site isn't among the pages Google returned for this search is shown in amber with "check it".
- **When nothing is shown:** if Gemini answered without searching, or its reply can't be read, no prices appear.
- **What's shown with the prices:** the source links Google returned, and Google's search-suggestion box.
  - Google's terms require showing the search-suggestion box with the results.
  - It is shown in a sandboxed frame, where no scripts run and links open in a new tab.
- **Nothing is saved.** Google's terms don't allow caching these results, so they disappear when the card changes or the app closes.
- **Labelling:** the panel says the prices are an AI summary of a search, can be wrong or pick the wrong version, and are best-case when the grade is only a ceiling.
- **No scraping:** the app never fetches the source pages itself. Google's terms also forbid using the results to find pages to crawl or scrape.

### Cost and access
Checked on the Gemini API pricing and model pages, 2026-09-29.

| Model (chosen under Prices → Web search access) | Search | Notes |
|---|---|---|
| `gemini-3.5-flash-lite` (default) | needs billing on the key: 5,000 searches a month free, then $14 per 1,000 | Tokens about $0.30 in / $2.50 out per million, so a fraction of a cent per lookup. |
| `gemini-2.5-flash` | free, up to 500 searches a day | Older accounts only: Google refuses it to new users. |

- **Live check (2026-09-29, a new free key in the newer `AQ.` format):**
  - A plain request to `gemini-3.5-flash-lite` worked.
  - Google search on `gemini-3.5-flash-lite` and `gemini-3.8-flash` answered 429 "You exceeded your current quota, please check your plan and billing details": the free tier includes no searches.
  - `gemini-2.5-flash` answered 404 "no longer available to new users".
  - So web search needs billing enabled on the key's project. The app says so when it gets that answer.

- **Errors:** the app explains refusals (bad key, billing needed, model not available to the key, quota used up) and never switches models on its own.
- **Browser access:** the endpoint allows calls from the app's pages (CORS checked from the GitHub Pages origin).

### Tested
- **Offline:** `tests/test_standalone_webprices.py` covers the request shape, the key only in a header, price checks, dropping PriceCharting, flagging unconfirmed sources, empty or unsearched answers, and the error messages.
- **In a browser:** a phone-sized Chromium with a stand-in Gemini reply showed the results, sources and suggestions, stored nothing, and kept the key out of backups.
- **Against the real Gemini API:** only the error paths so far (see the live check above). A successful grounded search needs a key with billing.

## 4. Recent sales from CardSight (`cardsight.js`, Pokémon)

CardSight AI (cardsight.ai) sells access to trading-card data, including sale prices and graded prices from eBay, Fanatics Collect, COMC and other marketplaces. Pokémon is covered; Riftbound isn't, so Riftbound cards use the Gemini web search instead.

### How it works
- **When it runs:** automatically when you confirm a Pokémon card, and again when you tap **Update**.
- **Two calls:**
  1. `GET /v1/catalog/search?q=<name number set>&type=card` finds the card. Results are ranked by number, name and set; entries outside the Pokémon segment are left out; and a picker is offered when several entries look alike.
  2. `GET /v1/pricing/{card_id}?period=1y&listing_type=auction` fetches completed auction sales from the last year, raw and graded, grouped by company and grade.
- **What's shown:**
  - for the ungraded card and for each company at this report's grade: the median sale, the number of sales, the price range, and the latest sale with a link to the listing;
  - an "All graded sales" list;
  - a version picker when parallels (1st Edition, reverse holo, …) appear in the sales. The base card is shown by default.
- **Labelling:** grades that are only a ceiling are marked "up to", with the same warning as the other prices. Pristine or Black Label 10s can't be told apart from a plain 10 in the sales data, and the panel says so.

### Access and terms
Checked on CardSight's OpenAPI spec, pricing page and terms, 2026-09-29.
- **API:** `https://api.cardsight.ai`, with the key in the `X-API-Key` header. Browser calls are allowed (`Access-Control-Allow-Origin: *`).
- **Free plan:** 750 calls a month and 4 a second. Usage stops at the cap, so it never charges. Paid plans start at $14.95 a month for 5,000 calls.
- **Calls used:** about 2 per card, and answers are cached for 24 hours.
- **Terms on the key:** it is personal and must not be shared. So each person enters their own, it stays on their phone, and it is never in backups, drafts, History or the published app.
- **Terms on caching:** only short-term caching is allowed. Answers are kept 24 hours, and all cached CardSight data is deleted when the key is removed.

### Tested
- **Offline:** `tests/test_standalone_cardsight.py` uses stand-in responses built from the spec. It covers the request shape, the key only in a header, card ranking (other segments dropped), the grade summaries and version split, 24-hour caching and purging, and the error messages.
- **In a browser:** a phone-sized Chromium with a stand-in CardSight showed the sales table, made two calls, kept the key out of backups, and cleared the cache on **Remove**. It also hid the section for Riftbound.
- **Not tested against the real CardSight API:** no key was used here.

### Not used yet
- **Photo identification:** CardSight can identify a card from the photo (`POST /v1/identify/card`, 1 call). That would likely beat the on-phone text reading for Pokémon, but it isn't wired in.
- **Population reports:** CardSight also offers free PSA population reports.

## 5. Reading the card with Gemini (`geminiid.js`)

With a Gemini key saved, **Read from photo** sends the flattened front of the card to Gemini and gets back the name, collector number, set code and set name, language, and version. The request is a JPEG about 1,000 px tall, sent to `gemini-3.5-flash-lite` with a JSON response schema.

### How it's used
- **Same path as the on-phone reader:** the reading goes through the same card lookup and **This is my card** confirmation.
- **Fallback:** if Gemini fails (offline, over its limit), the app falls back to the on-phone reader and says so.
- **Wrong game:** if Gemini sees a different game than the one selected, the app suggests switching.

### Privacy and cost
- **Your photo leaves the phone:** the front photo is sent to Google. On Google's free tier, content may be used to improve their products. The key's settings box says so.
- **Cost:** plain image requests work on a free key; no billing is needed for this part. Only Google search (section 3) needs billing.

### Measured
Live, 2026-09-29, with a new free key, on the 31 real photos from `docs/blind-test.md`:

| | Gemini | On-phone reader |
|---|---|---|
| Collector number right | **31 / 31** | 15 / 31 |
| Name right | **30 / 30** | 21 / 27 (English) |
| Set name given | 29 / 31, correct where checked | — |
| Time per card | about 2 s | about 1 s |

- **Test set:** 30 TAG-slabbed Pokémon cards, including Japanese cards and gold stars, plus the raw Ahri (Riftbound) card.
- **Near misses:** one Legendary Collection card was read as 2/18 instead of 2/110. The number was right; the lookup still needs the name.
- **Full browser run:** Gemini, then the live card databases, then confirming the card.
  - Ahri was read as "Ahri · SP3/006 · VEN" and the right card came first at 100% match, in about 6 s.
  - The Lugia slab was read as "Lugia · 9/111 · Neo Genesis" and the right card came first.

## 6. Riftbound prices from TCGplayer (`rbprices.js`, `scripts/fetch_riftbound_prices.py`)

TCGplayer's own API isn't open to new developers. tcgcsv.com republishes its product and price data once a day, and its FAQ invites programmatic downloads. Its files don't allow cross-site reads from a browser, so:

- **Daily file:** the Pages workflow runs `scripts/fetch_riftbound_prices.py` once a day, at 21:37 UTC, after tcgcsv's 20:00 UTC update, and on every deploy.
  - It makes about 27 requests, 0.3 s apart, with an identifying User-Agent.
  - It writes `riftbound-prices.json` next to the app: single cards only, with each printing's market, low and mid price.
  - On 2026-09-29 that was 1,510 cards (1,447 with prices), 470 KB.
- **Where the app reads it:** from its own site. The Claude-hosted copy reads the GitHub Pages copy, which allows cross-site reads.
- **Service worker:** always tries the network first for this file, so it isn't stuck on an old day, and falls back to the cached copy offline.
- **Matching:** by the TCGplayer product id Riftcodex gives for the confirmed card, otherwise by set code and collector number, with the name as a check.
  - Example: Ahri, Inquisitive (VEN SP3/006) is TCGplayer product 705996, Foil, market $76.22.
- **What's shown:** the market price (recent sales), lowest listing and mid price for each printing, the update date, and a link to TCGplayer.
- **Ungraded only:** TCGplayer doesn't list graded cards, so graded Riftbound prices come from the web search (section 3), which needs billing on the Gemini key.
- **Public file:** the price file is public on the Pages site, as tcgcsv's own files are. It holds only the Riftbound subset needed by the app.
- **Tests:** `tests/test_standalone_rbprices.py` covers matching, loading, printings and the download script (offline). The browser run above showed the price after confirming the card.
