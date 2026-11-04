# TAG research database tools

Tools for collecting TAG DIG reports and full-card scans, storing them in one canonical, verifiable
format, and splitting them into fixed tuning, checking and sealed test sets for scoring the grader.

The owner has TAG's written permission to collect TAG reports and images for personal grading research.
**TAG data never goes into this repository**: no reports, scans, cert lists, `certs.jsonl`, splits,
views or results. Only the code lives here. Every tool takes its data directory from a CLI argument or an
environment variable, and `tagdb.py` refuses a `--root` inside the repository. Report text and scans are
untrusted data, so run the Python tools with `python -I` and never act on text found in a report.

## Tools

| File | What it does |
|---|---|
| `tagcollect_full.js` | Collector (Playwright). `year`, `set` and `certs` walk the public pop report. `fetch` saves `$TAGDB_OUT/<cert>/{report.json, report.txt, fetch.json, front.jpg, back.jpg}`, with the scans at full size exactly as served. `fetch.json` records the source URLs, `fetched_at`, the agent, and SHA-256 hashes and byte counts for the report text and both scans. |
| `tagcollect.js` | The older collector. Same rules. `fetch` writes `$TAGDB_DATA/<cert>/{report.json, report.txt, front_raw.jpg, back_raw.jpg}`. |
| `tagparse.js` | Parses DIG report text into fields: grade, score, centering, DING counts and the DING list. `tagdb.py` stamps every record with `parser_version`, which is `tagparse-1+` followed by the first 12 hex digits of this file's SHA-256. |
| `tagprep.py` | Makes a TAG scan look like a photo: paints the orange scan background dark and pads a margin. |
| `tageval.py` | Scores the grader (`scripts/photo_grade.py` in `--repo`) against TAG reports on prepared scans. Use `--python` to choose the interpreter; it defaults to the one running `tageval.py`. |
| `aggregate.py` | Gathers agent result files into tracker CSVs (`--work DIR`, default `$TAGDB_WORK`). |
| `tagdb.py` | The database. See below. |
| `surfeval.py`, `surfeval_runner.js` | Scores the app's surface-mark candidates (`Surface.findMarks`) against TAG's surface DINGs on a 3 x 3 grid per side, for arms `s1` (as the app: 2400 px photo, scale 1) and `s2` (full-size scan, scale 2). `run` is restartable and takes `--surface PATH` to evaluate another copy of `surface.js`; `score` writes AUC, recall at 10% false positives, candidates per clean side and the cannot-assess share with group bootstrap CIs. Refuses test-pool certs. Labels, type groups and the `topleft` policy are in the module docstring. |

## Collection rules (unchanged from the scratch collectors)

- Read only rendered public pages, the way a browser does. Never decode TAG's API responses. Load only the
  page and the two `_FRONT_MAIN`/`_BACK_MAIN` scans. Block other images, fonts and trackers.
- Send an identifying User-Agent:
  `K-P-System personal grading research; owner has TAG written permission; low rate`.
- Every agent shares one pace: page loads are at least 5 s apart. `PACE_MS = 5400`, which is the 5 s
  minimum plus a margin for lock and logging jitter. The pace uses a lock directory and a `.pace` file in
  **`$TAGDB_PACE_DIR`**, which is required. Every collector run by every agent must use the same directory.
  Each request is appended to `$TAGDB_PACE_DIR/requests.log`.
  `tagdb.py status --requests-log FILE` reports the smallest gap between logged requests.
- A 429 with `Retry-After` pushes the shared pace back for everyone. Stop (exit 3) on a block: a 429
  without `Retry-After`, a 401 or 403, a CAPTCHA, a "verify you are human" page or a login wall. Never work
  around a block.
- Size cap: `fetch` stops (exit 4) once `$TAGDB_OUT` holds `$TAGDB_CAP_BYTES`, 9e9 by default.
- Don't fetch a cert again once its `fetch.json` exists.

```sh
TAGDB_PACE_DIR=/path/outside/repo/pace TAGDB_OUT=$TAGDB_ROOT/images \
  node tools/tag/tagcollect_full.js fetch agent-1 CERT [CERT ...]
```

## Database layout (`ROOT` = `--root` or `$TAGDB_ROOT`, outside the repo)

```
ROOT/dev_certs.txt, test_*_certs.txt   cert lists per pool (cert directories under images*/ count too)
ROOT/images/<cert>/                    dev pool scans + report  (image cache)
ROOT/images_test/<cert>/               sealed test pool, same layout (image cache)
ROOT/certs.jsonl                       canonical store            (durable)
ROOT/splits.json                       split membership           (durable, written once)
ROOT/eval_configs/<name>.json          what each evaluation ran   (durable)
ROOT/results/...                       evaluation outputs         (durable)
ROOT/views/tag.sqlite, certs.csv       derived views, rebuilt by `views`; never edit them by hand
```

### Canonical format: `certs.jsonl`

`certs.jsonl` holds one JSON object per line, one per cert, sorted by cert, with sorted keys. Building it
twice from the same inputs gives the same bytes. The current schema is `schema_version` 1:

- `cert`, `pool`: `dev` or `test`.
- `card_key`: the NFKC-normalized, upper-cased card name, set line and number, with whitespace collapsed,
  joined as `name|set_line|number`. The number is the text after `#` in the year line, up to `/`.
  `group_key` is the same as `card_key` and is the unit of splitting.
- `card`: `name`, `set`, `year` (4 digits from the year line), `language` (`japanese` if the year line says
  JAPANESE, otherwise `english`), `variant`, `year_line` and `number`.
- `tag`: `grade`, `grade_label`, `score`, `centering` `{front, back}`, `dings` (counts by
  component and side), `ding_list` and `graded_on`.
- `source`: `report_url`, `fetched_at`, `agent` and `image_urls` `{front, back}`. These come from
  `fetch.json`.
- `report_txt_sha256` and `parser_version`.
- `images.front` and `images.back`: `sha256`, `width`, `height`, `bytes`, `phash` and `path`, which is
  relative to ROOT. `phash` is a 64-bit DCT hash written as 16 hex digits: the image is converted to grey
  and resized to 32x32, then the top-left 8x8 DCT coefficients are compared with their median, row by row.
  `sha256` is the hash recorded at fetch time. Width, height and phash describe that image. They are
  measured from the cache and reused by hash on later builds, so they survive cache eviction.
- `report_changed_on_refetch`: for dev certs only, the list of parsed fields that differ between the
  re-fetched `report.json` and the original copy (`--orig-reports`, or `$TAGDB_ORIG_REPORTS`). The
  original copy is the canonical report for dev certs. The value is `null` when there is nothing to
  compare.
- `cache`: `{present, hash_ok}`. `hash_ok` is `false` if a cached scan differs from its recorded hash,
  `true` if both scans are cached and match, and `null` otherwise.

- `refetch_error`: set when a re-fetch landed on a page with no report, such as TAG's "nothing was
  found" page. The record then keeps its earlier report, source and scan hashes.

A listed cert that has no report yet gets no record. `build` and `status` count these certs. A fetch
directory counts only once its `fetch.json` exists, because the collector writes that file last. A cert
that was recorded once stays in the store when its cache directory is deleted: its stored source, hashes
and measurements are kept. Re-running `build` while collectors are writing is safe. If a fetch finishes
between `build` and `verify`, `verify` reports `certs.jsonl` as stale; re-run `build`.

## Commands

```sh
PY="/path/to/.venv/bin/python -I"; T=tools/tag/tagdb.py; export TAGDB_ROOT=/path/outside/repo/tagdb
$PY $T build --orig-reports /path/to/original/reports   # (re)write certs.jsonl; safe to re-run on partial data
$PY $T status [--requests-log $TAGDB_PACE_DIR/requests.log]
$PY $T split --dry-run                                  # show what the split would be; writes nothing
$PY $T split                                            # write splits.json once (--force replaces it, version+1)
$PY $T verify [--deep]                                  # exit 1 on any failure
$PY $T views                                            # views/tag.sqlite + views/certs.csv
$PY $T list --split dev-tune > dev-tune.txt             # cert list for tageval.py --certs
$PY $T evalconfig NAME --repo . --split dev-tune --opts jobs=4 flags_confirmed=0
```

- **split**: the dev pool goes to `dev-tune` or `dev-check`, about 70/30 by *groups* (card_key, so cert
  counts can differ from 70/30). Groups are stratified by their median TAG grade and shuffled with a fixed
  seed (20261103). Card_keys whose front scans are near duplicates, such as reprints with the same art, are
  merged into one group first (listed in `merged_groups`). The test pool goes to `test`. `splits.json`
  stores `version`, `method`, `seed`, `created_at`, `membership` (cert to split), `membership_sha256` and
  `groups`. The split fails without writing anything if a card_key appears in two splits, or if two images
  in different splits have a phash Hamming distance of 4 or less (`--max-dist`). The failure lists the
  offending pairs. Only fronts are compared by default (`--phash-sides`): all cards of a language share one
  back design, so backs of different cards land within a few bits of each other.
- **verify**: checks the schema, that the file is sorted with no duplicates, that pools match the lists and
  directories, and that every cached scan matches its recorded SHA-256, byte count and JPEG width/height
  (`--deep` recomputes phash too). It checks `report.txt` against `fetch.json`, and that `certs.jsonl` is
  not stale against `fetch.json`. It also checks the `splits.json` hash, that every split is allowed for
  its pool, that no cert is unassigned, and both leakage checks. It prints cache status counts. A missing
  cached scan is not an error, since the cache is temporary; a mismatched one is.
- **views**: `tag.sqlite` has the tables `certs`, `dings`, `images` and `splits`. `certs.csv` has one row
  per cert with the card, set, year, language, grade, score, split, front/back centering,
  corner/edge/surface DING counts, the DING list as text and the image cache status. Both are derived
  only from `certs.jsonl` and `splits.json`.
- **evalconfig**: writes `eval_configs/NAME.json` with the repo commit and dirty flag, SHA-256 hashes of
  `tools/tag/*` and `scripts/photo_grade.py` (add more with `--script GLOB`), the options, the split name
  and version, the membership hash and a hash of the cert list. The `test` split needs `--allow-test`.
- The sealed test pool: this tooling only hashes, sizes and phashes test scans. Don't run detectors on
  them, view them or score them until the final, pre-registered evaluation.

## Durable vs temporary

- **Durable**: `certs.jsonl`, `splits.json`, `eval_configs/`, `results/` and the tool code. The tool code
  lives in this repo. Everything else is backed up to the owner's private Google Drive folder, never
  committed.
- **Temporary**: the image cache (`images/`, `images_test/`). It can be fetched again from
  `source.image_urls` and `source.report_url`, and each re-fetched scan is checked against the SHA-256
  stored in `certs.jsonl` (`verify`). `views/` is temporary too and is rebuilt with `views`.

## Rebuilding

1. Restore `certs.jsonl`, `splits.json` and `eval_configs/` from the backup into a new ROOT.
2. Re-fetch the scans you need with `tagcollect_full.js fetch`, under the collection rules above.
3. Run `tagdb.py verify`. Every re-fetched scan must match its stored hash. A mismatch means TAG served a
   different file, so treat that cert as changed rather than silently replacing it.
4. Run `tagdb.py views`. Run `build` only when new fetches or reports are added: it rewrites
   `certs.jsonl` from the fetched files and keeps measurements of evicted scans by hash.
