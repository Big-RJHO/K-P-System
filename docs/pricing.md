# Reading the card from the photo, and its prices

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
