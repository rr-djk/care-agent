# Calibration, degraded variants and the final report (step 13)

Goal: say, per category of field, how often a `KNOWN` reading is right, with an honest interval, and use it. Tooling is done on this branch; the full model runs are pending (see "Long runs").

## Protocol

- Pages are deduplicated by sha256 (80 unique pages) and split **by patient**: `tune` = patients 2, 3, 4, 8 (tuning only), `calibrate` = 1, 5, 7 (fits the table), `verify` = 6, 9, 10 (report only). The 5 real JPGs are never used to tune or calibrate; they only measure the gap clean specimen to real photo.
- Degraded variants (`make degrade`) live in the group of their source page: the manifest records `page_no`, `patient`, `group`, and `degrade`, `predict` and the tests refuse any entry whose group or patient differs from the source's (no leakage).
- Per category (`FieldDef.category`: checkbox, date_clinical, date_admin, vital_number, admin_number, short_text, lab_result, free_text): accuracy of the fields that ended `KNOWN`, in at most 3 bins, at least 30 examples per bin (a smaller bin merges into its neighbour), Wilson 95 % intervals.
- Final confidence = calibrated value x quality factor, stored in `ExtractedField.calibrated` with its interval in `ExtractedField.calibration` `{low, high, n}`.
- `pipeline_hash` is stored in the table; a table whose hash differs from the running pipeline is refused.

## Signals we have, and the ones we do not

Ollama returns only the first token's logprob for `gemma4:e4b`: **there is no per-cell probability**. What exists per field (stored in the predictions file under `signals`):

| Signal | Meaning | Varies among `KNOWN` fields? |
| --- | --- | --- |
| `agreement` | the model's emptiness matches the ink (1) or not (0) | No: disagreement is `NEEDS_REVIEW`, so every `KNOWN` text field has 1 |
| `validators_passed` | normalization, validators and type fit passed | No: a failure is `NEEDS_REVIEW` |
| `ink` | ink ratio of the cell | Yes, recorded, not used for bins |
| `quality` | factor from the gate outcome of the image: `OK` 1, `WARNING` / `REJECT` 0.5 (the `LOW_QUALITY` factor of `worker.ts`) | Yes: this is the only binning axis |
| enum match, applicability | part of the status | No |

Consequence: the confidence of a `KNOWN` field is mostly "how reliable is this category at gate-OK quality" (reference bin) times the quality factor. Agreement and validators matter for the **status** (they are why wrong readings get flagged, see doubt recall), not for a score inside `KNOWN`. A per-field score would need the model's token probabilities, which we do not have.

## Decision rule

A category whose `KNOWN` accuracy has a Wilson 95 % **lower** bound below the target (default 0.95, `--target`) has its `KNOWN` fields demoted by the server to `NEEDS_REVIEW` with `reason: low_category_confidence`. The reference accuracy is the best-quality bin after merging. A category whose reference bin has fewer than 30 examples is **insufficient**: no number and no demotion (no evidence either way; the report lists it). Notes: with zero errors the lower bound reaches 95 % at about 73 examples (30 examples give 88.6 %), so a category that is never wrong but rare may be demoted by lack of data above 30 and below ~73 examples; raise the number of calibrate pages and variants rather than the target.

"Doubt recall" = share of **wrong** values whose status is `NEEDS_REVIEW`, `ILLEGIBLE` or `UNKNOWN` (those reach the review queue). A wrong value with `KNOWN`, `NOT_PROVIDED` or `NOT_APPLICABLE` is a silent error. (Slightly stricter than "not KNOWN": a wrong `NOT_PROVIDED` counts as not flagged.)

## What the server does

`apps/server/src/calibration.ts` (shared with the tools):

- `pipelineHash()` = sha256 of: model tag (`MODEL`, default `gemma4:e4b`), the zone prompts as the model receives them (template text and labels), the six layouts + `real_cover` page schemas (zones, fields, masks), the cell boxes (`tools/eval/data/zones/*.json`), every ink constant (`INK_PARAMS` in `vision/ink.ts`) and the crop padding (`PAD_PX` in `vision/crop.ts`). **Any change to the prompt, the zones, the thresholds or the model invalidates the table**: rerun `make predict` on the calibrate split, then `make calibrate`. The retry sentence of `analyze.ts` and the quality gate thresholds are not part of it.
- At start `main.ts` loads `<DATA_DIR>/calibration/table.json` (default `data/calibration/table.json`). Missing: logged, fields not calibrated. Unreadable or wrong hash: logged and ignored. The table is never partially applied.
- `applyCalibration` (model path only): on each `KNOWN` field of a category with a number, `calibrated` = accuracy x quality factor, `calibration` = interval x factor and n; demotion when the category is flagged `demote`. `applyLowQuality` then rescales `calibrated` to the page's `LOW_QUALITY` factor; a field demoted by calibration keeps its own reason.
- The main UI never shows a percentage. The review item carries `detail_fr` (« confiance estimée 91 % [86-94 %] sur 240 exemples ») only when a calibrated value exists, behind the optional **Détails** link of the review card (audit / jury).

## Tools

| Command | Reads | Writes |
| --- | --- | --- |
| `make degrade ARGS='--split calibrate --pages p4,p6 --variants all'` | specimen PNGs (read-only) | `data/degraded/<page_no>/<variant>.png`, `data/degraded/manifest.json` |
| `make predict ARGS='--split calibrate --variants all'` | pages, variants, model | `eval-results/predictions-<ts>.jsonl` |
| `make calibrate ARGS='--pred <file>'` | the calibrate-split predictions | `data/calibration/table.json`, `report.md` |
| `make quality-curve ARGS='--pred <file>'` | predictions on variants | `eval-results/quality-curve-<ts>.md` |
| `make report ARGS='--pred <file>[,photo.jsonl] [--publish]'` | verify-split predictions (+ real photo), the table | `eval-results/report-<ts>.md`, `docs/results.md` with `--publish` |

All outputs are git-ignored except `docs/results.md`. `predict` records one line per image: `page_no`, `variant`, `group`, `pipeline_hash`, `gate` (outcome, quality, blur, isotropy, brightness, glare, framing, spread, clipped, black, skew, messages), `latency` (model seconds as measured by Ollama, also on cache hits; wall seconds), and per field `status`, `verbatim`, `value`, `category`, `type`, `signals`. `make eval --extractor <file>.jsonl` reads the clean pages of it. `calibrate` refuses records of other splits, the real photos, and records read by another pipeline; `report` refuses non-verify pages.

## Long runs (this CPU laptop, `gemma4:e4b`; one at a time, in the background)

Measured here: a cover page ~45 s; pregnancy page 27 (13 zones) 127 s of model time; a zone takes 10-25 s depending on the machine's state. Estimates per page (clean): cover 1 min, identification 3 min, pregnancy 2.5 min, delivery 2 min, postpartum mother 1.5 min, newborn 2.5 min: **about 16 min per patient (8 pages), about 50 min for the 24 calibrate pages, the same for verify**. Variants cost as much as the page they come from.

1. `make degrade ARGS='--split calibrate --pages p4,p6 --variants all'` (1 min, no model). `p4` and `p6` are cheap pages with many handwritten cells.
2. `make predict ARGS='--split calibrate --variants all'`: the 24 clean calibrate pages (about 50 min) plus the variants of the delivery and newborn pages (4.5 min per variant set x 10 variants x 3 patients = 2 h 15): **about 3 h**. Lean option: `--variants blur-s1,blur-s2,blur-s4,dark-0.6,glare,jpeg-q30` on the degrade and the predict lines: about 2 h.
3. `make calibrate ARGS='--pred eval-results/predictions-<that file>.jsonl'` (seconds). Read `data/calibration/report.md`.
4. `make quality-curve ARGS='--pred eval-results/predictions-<that file>.jsonl'` (seconds); decide on thresholds with `docs/quality.md`.
5. `make predict ARGS='--split verify --real 1-1'` (about 50 min + 1.5 min). Run it after calibration: it must not influence it.
6. `make report ARGS='--pred eval-results/predictions-<that file>.jsonl --publish'` (seconds; writes `docs/results.md`).

`make eval-full` chains steps 1-6 (about 4 h with `p4,p6` and every variant); it is documented, not run by `make check`. Never run two model jobs at once. Changing the prompt, zones or ink thresholds after step 2 makes `calibrate` refuse the file (rerun step 2).

## Tuning experiment (tune split only): pregnancy zones — not kept

Cutting the pregnancy table at its dark section bands (7 row groups `[4, 7, 6, 6, 5, 1, 1]`, 22 zones) took tune page 27 from 104/115 (90.4 %) to 113/115 (98.3 %) handwritten cells right, with one new silent error and 4× the model time (127 s → 521 s). Decision: keep the 13 zones for processing time on the CPU laptop. Commit `45d655f` (reverted by the next commit) holds the change; why it works, its cost and how to scale it are in `docs/scaling.md`. The calibration runs below use the 13-zone pipeline.

## Limits

- No per-token probability: no per-field score inside `KNOWN`.
- Variants are synthetic (OpenCV / sharp), not phone photos; the quality factor is a 2-valued function of the gate outcome.
- The real photo (1-1, hand labels by an AI to be verified by a human) is one image: it measures a gap, it does not calibrate.
- Calibrate has 3 patients: categories like `date_clinical` or `free_text` may stay insufficient; the report says so.
