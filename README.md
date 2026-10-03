# care-agent

Offline-first PWA that turns photos of a paper maternal registry into a structured, midwife-verified record.
A phone captures and checks pages; a laptop on the local Wi-Fi runs a local Gemma 4 E4B-it and a Hono/TypeScript server.
No internet, no cloud.

## Layout

- `apps/pwa` - Vite + React client (placeholder)
- `apps/server` - image analysis: crop, ink detection, Gemma 4 calls, field statuses (`analyze`, `predict`, `ink-eval` commands)
- `packages/schema` - shared zod contracts, page schemas (`pages/*.json`), zone prompts, normalizers and validators
- `tools/eval` - ground truth from the specimen PDF, crop zones, evaluation harness
- `tools/check-datasets.mjs` - dataset integrity guard; `tools/smoke/` - latency probe
- `docs/` - plan, build progress, runtime notes, API contract, zone previews

Plan and build progress: [docs/Care_Agent-Dev_Plan.md](docs/Care_Agent-Dev_Plan.md). Agent and contributor notes: [AGENTS.md](AGENTS.md).

## How to test

What works today: reading registry pages with the local model, from the command line. There is no phone app yet (it comes with step 7).

### 1. Prerequisites

- Node.js 20 and npm.
- Python 3.12 with `PyMuPDF`, `numpy`, `opencv-python` and `Pillow` (`pip install pymupdf numpy opencv-python pillow`, in a venv if your system refuses global installs). Needed by `make test` and to regenerate ground truth.
- `pdftotext` (package `poppler-utils`), used by `make pages`.
- The challenge data, laid out like this (the repo never modifies it):

  ```
  DayOne/
    consignes-fr-en.pdf          # the guard also checks this file
    datasets/                    # manifest.json + data/Paper Registry/...
    care-agent/                  # this repo
  ```

  Elsewhere? Set `DATASETS_DIR=/path/to/datasets`.
- For the model: [Ollama](https://ollama.com) and the model tag `gemma4:e4b` (`ollama pull gemma4:e4b`, ~6.6 GB). Ollama must be running (`curl localhost:11434/api/version`).

### 2. Install and check (no model needed)

```
npm ci
make check                              # datasets 132/132 ok + typecheck + all tests
make eval ARGS='--extractor truth'      # harness sanity check: overall 100.0%
```

### 3. Read one zone with the model (~40 s on a CPU laptop)

```
npm run analyze -w @care-agent/server -- 19 --zones p03.visits.r1c1
```

Page 19 is patient 3's pregnancy page. Expected: a table where the 8 visit-1 values (`03/07/2025`, `05/06/2025`, `Non`, `8 SA`, `51,6`, `104/78`, `RAS`, `Normales`) are `KNOWN` in the right cells and the 16 empty cells are `NOT_PROVIDED`. Run it again: `[cache hit]`, instant.

Other useful runs:

```
npm run analyze -w @care-agent/server -- 19                     # the whole page (13 zones, several minutes on CPU)
npm run analyze -w @care-agent/server -- 20                     # a delivery page (checkboxes are read by ink, not by the model)
npm run ink-eval -w @care-agent/server                          # ink detector vs ground truth, 80 pages, no model
```

What to look at: `status` (`KNOWN`, `NEEDS_REVIEW`, `NOT_PROVIDED`, `ILLEGIBLE`, `UNKNOWN`) and `ink`. A value the validators reject (for example `8 17 SA`) must come out `NEEDS_REVIEW`, never `KNOWN`.

### 4. Measure accuracy on a split (long: plan tens of minutes)

```
make predict ARGS='--split tune --pages p3 --limit 1'          # writes eval-results/predictions-<time>.json
make eval ARGS='--extractor eval-results/predictions-<time>.json --split tune --pages p3'
```

Splits: `tune` (patients 2, 3, 4, 8), `calibrate` (1, 5, 7), `verify` (6, 9, 10). Results stay in `eval-results/` (git-ignored); model answers are cached in `data/cache/`.

### Known limits

- CPU only: ~20 s to read a crop plus ~7 output tokens/s; a full 8-page record takes many minutes. Analysis is designed to run in the background.
- Ollama returns no per-token probabilities for this model, so confidence comes from ink/model agreement and validators.
- Only pages 2, 3 and 4 have schemas so far (identification, pregnancy, delivery).
