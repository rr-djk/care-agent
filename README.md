# care-agent

Offline-first PWA that turns photos of a paper maternal registry into a structured, midwife-verified record.
A phone captures and checks pages; a laptop on the local Wi-Fi runs a local Gemma 4 E4B-it and a Hono/TypeScript server.
No internet, no cloud.

## Layout

- `apps/pwa` - Vite + React PWA: login, WhatsApp-style chat in French, photo capture, live analysis, field correction
- `apps/server` - Hono API (SQLite, lifecycle, encrypted originals, NDJSON analysis stream) and image analysis: crop, ink detection, Gemma 4 calls, field statuses (`analyze`, `predict`, `ink-eval` commands)
- `packages/schema` - shared zod contracts, page schemas (`pages/*.json`), zone prompts, normalizers and validators
- `tools/eval` - ground truth from the specimen PDF, crop zones, evaluation harness
- `tools/check-datasets.mjs` - dataset integrity guard; `tools/smoke/` - latency probe
- `docs/` - plan, build progress, runtime notes, API contract, zone previews

Plan and build progress: [docs/Care_Agent-Dev_Plan.md](docs/Care_Agent-Dev_Plan.md). Agent and contributor notes: [AGENTS.md](AGENTS.md).

## How to test

What works today: reading registry pages with the local model (command line, section 3), and the app itself: server + PWA in the browser (section 5) or on a phone (section 6). The chat then walks the doubtful fields one by one (Confirmer / Corriger / Reprendre la photo / Laisser illisible, or type the value), and offers manual entry when the model is unavailable. Not yet: offline queue, image-quality check, patient linking.

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

### 5. Run the app on the laptop (browser)

Two terminals:

```
make server        # API on :8787. First start prints demo users sf-01, sf-02 (midwives), sup-01 (supervisor) and their PINs, once.
make pwa           # PWA on http://localhost:5173 (/api is proxied to the server)
```

To choose the PINs instead, create `data/users.json` before the first start: `[{ "id": "sf-01", "role": "midwife", "pin": "123456" }]`.
Open http://localhost:5173, log in as `sf-01`, tap **Nouvelle session**, pick the page type (2, 3 or 4 are analyzed), tap **Photographier une page** and choose a specimen PNG (e.g. `../datasets/data/Paper Registry/dossiers_specimen_10_patientes-19.png`, page type 3). Expected: "Photo envoyée", "Page reçue, analyse en cours…", then after a few minutes a page summary and the first question (« J'ai lu « … » pour …, mais la valeur semble inhabituelle. Pouvez-vous vérifier ? ») with **Confirmer / Corriger / Reprendre la photo / Laisser illisible**; answer with the buttons or type the value (e.g. `158`, `12/04/2026`, `120/80`, `neg`, `c'est bon`), then the bot asks the next field, and « Tout est vérifié pour la page 3. » + **Confirmer la page** at the end. **Reprendre la photo** uploads a new photo that replaces the page.

- No model at hand? `ANALYZER=off make server`: upload works, analysis never starts.
- No model, but you still want to read pages: `ANALYZER=ink make server` (manual entry: you type the cells that have writing); with the model on, a page whose analysis fails offers **Saisie manuelle**.
- UI only, no server: `VITE_FIXTURES=1 make pwa` replays a canned flow (a doubt, an illegible field, a failed page with manual entry, a retake).
- Optional LLM chat: `CHAT_ENGINE=strands make server` (see `docs/security.md`).

### 6. On a phone (same Wi-Fi as the laptop)

The camera needs HTTPS. Once per machine:

```
mkcert -install            # installs a local root CA (install mkcert first: https://github.com/FiloSottile/mkcert)
make certs                 # certificate for localhost + this machine's LAN IPs, in data/certs/
```

Then trust the root CA on the phone (`mkcert -CAROOT` shows where `rootCA.pem` is; Android: install it as a CA certificate; iOS: install the profile, then enable full trust in Settings > General > About > Certificate Trust Settings). Restart `make pwa`, open `https://<laptop LAN IP>:5173` on the phone. If the phone cannot reach the laptop: guest Wi-Fi often isolates clients (use a phone hotspot instead) and the laptop firewall must allow ports 5173.

### Known limits

- CPU only: ~20 s to read a crop plus ~7 output tokens/s; a full 8-page record takes many minutes. Analysis is designed to run in the background.
- Ollama returns no per-token probabilities for this model, so confidence comes from ink/model agreement and validators.
- Only pages 2, 3 and 4 have schemas so far (identification, pregnancy, delivery).
