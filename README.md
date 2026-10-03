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

What works today: reading registry pages with the local model (command line, section 3), and the app itself: server + PWA in the browser (section 5) or on a phone (section 6). The chat then walks the doubtful fields one by one (Confirmer / Corriger / Reprendre la photo / Laisser illisible, or type the value), and offers manual entry when the model is unavailable. Offline capture with an encrypted queue works too (section 7). Not yet: image-quality check, patient linking.

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
make check
```

`make check` runs the dataset guard, the typecheck of the three packages and every test suite. Success looks like this (excerpt):

```
entries: 132, ok: 132, mismatches/missing: 0          <- every data file matches manifest.json
info: 88 entries share an identical sha256 with another entry   <- normal: duplicate PNGs in the dataset
# pass 34 / # fail 0                                  <- schema tests
# pass 51 / # fail 0                                  <- server tests
      Tests  39 passed (39)                           <- PWA tests
# pass 14 / # fail 0                                  <- eval tools tests
Ran 9 tests ... OK                                    <- Python tests
```

Look at: `mismatches/missing: 0` and every `fail 0`. Failure modes: `MISSING ...` lines mean the data is not where expected (check the layout above or `DATASETS_DIR`); `SHA256 ...` means a data file was modified; `cannot check datasets in ...` means the folder was not found.

```
make eval ARGS='--extractor truth'
```

Feeds the ground truth to the harness as if it were the model, to prove the harness itself is right:

```
layout             non-empty         empty           all
identification    354 100.0%    416 100.0%    770 100.0%
pregnancy        1181 100.0%   1619 100.0%   2800 100.0%
delivery          116 100.0%    224 100.0%    340 100.0%
overall          1651 100.0%   2259 100.0%   3910 100.0%
```

Every cell must be `100.0%`. `non-empty` = cells with handwriting, `empty` = cells left blank on paper. The JSON report goes to `eval-results/` (git-ignored).

### 3. Read one zone with the model (~40 s on a CPU laptop)

Needs Ollama running with `gemma4:e4b`.

```
npm run analyze -w @care-agent/server -- 19 --zones p03.visits.r1c1
```

Page 19 is patient 3's pregnancy page; `p03.visits.r1c1` is the top-left block of the visit table (rows Rendez-vous to État des conjonctives, 1st-trimester visits; see `docs/zones-p03.png`). Output (excerpt):

```
zone               field                              verbatim       status         ink
p03.visits.r1c1    p03.rendez_vous.v1_t1              "03/07/2025"   KNOWN          0.0200
p03.visits.r1c1    p03.rendez_vous.v2_t1              ""             NOT_PROVIDED   0.0000
...
p03.visits.r1c1    p03.poids_kg.v1_t1                 "51,6"         KNOWN          0.0213
  -> p03.visits.r1c1: prefill 17.4 s (342 tok), gen 5.0 s (66 tok), wall 23.0 s
```

How to read it:
- `verbatim` = what the model wrote, exactly; `""` = empty cell, `null` = the model says it cannot read it.
- `status`: `KNOWN` accepted, `NEEDS_REVIEW` the midwife must check (value rejected by a validator, or ink seen but nothing read), `NOT_PROVIDED` empty on paper, `ILLEGIBLE`, `UNKNOWN` (zone not read).
- `ink` = share of ink pixels in the cell: `0.0000` means empty paper, so the model is not even asked.
- `prefill` = time to read the image, `gen` = time to write the answer, `wall` = total.

Success: the 8 visit-1 values `03/07/2025`, `05/06/2025`, `Non`, `8 SA`, `51,6`, `104/78`, `RAS`, `Normales` are `KNOWN` on the `v1_t1` rows, and the 16 other cells are `""` / `NOT_PROVIDED`. Run it again: the zone line ends with `[cache hit]` and `wall 0.0 s` (answers are cached in `data/cache/`, git-ignored). The key safety rule: a wrong value must never be `KNOWN` silently; e.g. on zone `p03.visits.r1c2` the model may read `8 17 SA` for `17 SA`, which must come out `NEEDS_REVIEW`.

Other useful runs:

```
npm run analyze -w @care-agent/server -- 19          # whole page: 13 zones, ~8 minutes on CPU; totals on the last line
npm run analyze -w @care-agent/server -- 20          # delivery page: checkboxes come from ink (no model), only text is asked
npm run ink-eval -w @care-agent/server               # ink detector vs ground truth on 80 pages, no model, ~1 min
```

`ink-eval` prints precision/recall per layout and threshold; at the thresholds used (text 0.002, delivery text 0.01, checkbox 0.05) expect `precision=1.000` and `recall` ≥ `0.997`.

### 4. Measure accuracy on a split (long: plan tens of minutes)

```
make predict ARGS='--split tune --pages p3 --limit 1'
```

Runs the full pipeline on the first pregnancy page of the `tune` patients and prints one line per page (`page 11 (pregnancy): 280 cells`), then `wrote .../eval-results/predictions-<time>.json`. Score it with that file name:

```
make eval ARGS='--extractor eval-results/predictions-<time>.json --split tune --pages p3'
```

Same table as in section 2, now with real percentages. Look at `non-empty` (handwritten cells read correctly) and `empty` (blank cells correctly left empty, expected 100 %). Reference: the first full run on the 12 `tune` pages (pages 2, 3, 4 of patients 2, 3, 4, 8) gave non-empty 90.8 % (identification 92.9 %, pregnancy 89.3 %, delivery 100 %), empty 100 %. Per-field results are in the JSON (`by_key`).

Splits: `tune` (patients 2, 3, 4, 8), `calibrate` (1, 5, 7), `verify` (6, 9, 10). Everything generated stays in `eval-results/` and `data/` (git-ignored).

### 5. Run the app on the laptop (browser)

Two terminals:

```
make server        # API on :8787. First start prints demo users sf-01, sf-02 (midwives), sup-01 (supervisor) and their PINs, once.
make pwa           # PWA on http://localhost:5173 (/api is proxied to the server)
```

First start of `make server` prints (PINs are random, shown once, stored hashed):

```
Demo users created. PINs are shown ONCE (stored hashed):
  sf-01  573194
  sf-02  269719
  sup-01  971041
care-agent server on :8787 (data: .../care-agent/data, analyzer on)
```

Write them down; later starts print only the last line. Lost them? Stop the server, delete `data/care-agent.db` (this also deletes uploaded pages) or use `data/users.json`. `make pwa` prints `Local: http://localhost:5173/` and a `Network:` line with the LAN address for the phone. To choose the PINs instead, create `data/users.json` before the first start: `[{ "id": "sf-01", "role": "midwife", "pin": "123456" }]`.
Open http://localhost:5173, log in as `sf-01`, tap **Nouvelle session**, pick the page type (2, 3 or 4 are analyzed), tap **Photographier une page** and choose a specimen PNG (e.g. `../datasets/data/Paper Registry/dossiers_specimen_10_patientes-19.png`, page type 3). Expected: "Photo envoyée", "Page reçue, analyse en cours…", then after a few minutes a page summary and the first question (« J'ai lu « … » pour …, mais la valeur semble inhabituelle. Pouvez-vous vérifier ? ») with **Confirmer / Corriger / Reprendre la photo / Laisser illisible**; answer with the buttons or type the value (e.g. `158`, `12/04/2026`, `120/80`, `neg`, `c'est bon`), then the bot asks the next field, and « Tout est vérifié pour la page 3. » + **Confirmer la page** at the end. **Reprendre la photo** uploads a new photo that replaces the page.

What to check in the browser: the analysis takes several minutes on CPU, the « Page reçue, analyse en cours… » bubble stays until then (the server terminal shows `POST /api/pages 200` then nothing while the model works). The page summary counts `lu / à vérifier / illisible / non lu`; every « à vérifier » field comes back as a question with the reason, and **Confirmer la page** is refused (list of fields) while a field is still to check. Never expected: a percentage shown to the midwife, or a doubtful value accepted without a question.

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

### 7. Offline demo (encrypted queue, sync)

Needs the service worker so the app reloads offline: `npm run build -w @care-agent/pwa`, then `npx vite preview` in `apps/pwa` (port 4173, `/api` proxied like `make pwa`). Or skip the reload part and use the dev server.

1. Log in online once (this derives the device key from the PIN and stores the encrypted token). A reload now shows « Déverrouiller »: the PIN is asked again.
2. **Nouvelle session**, then go offline: airplane mode on the phone, or on the laptop the switch **Mode hors ligne (simulation)** under the header (no network call at all while it is on), or DevTools > Network > Offline. Badge: **Hors ligne**.
3. **Photographier une page** twice. Each page is stored encrypted on the device and listed as « En attente de traitement IA ». Reload the page while offline: « Serveur injoignable : déverrouillage hors ligne », type the PIN (a wrong PIN is refused, 5 failures add a delay), the queue is still there.
4. Reconnect (or switch the simulation off): badge **Synchronisation (n)**, the pages go « Envoi en cours… » then « Envoyée — analyse en cours », then the analysis arrives (with `ANALYZER=ink`: the manual-entry questions).
5. Try also: kill the server during an upload and restart it (the page stays queued, no loss, no duplicate); a refused page shows « Échec d'envoi : … » and **Réessayer**.
6. **Effacer les données de l'appareil** (under the header, and on the unlock screen) deletes the local database, queued pages included.

What proves it works: (a) while offline, the server terminal shows no request and the pages stay « En attente de traitement IA » even after a reload; (b) after reconnecting, the server terminal shows one `POST /api/pages 200` per queued page, and each page appears once in the chat (no duplicate bubble); (c) after a kill/restart of the server during an upload, the page is still sent once (the server answers the replay with the stored page). Failure would be: a page vanishing from the queue without « Envoyée », two copies of a page, or the queue empty after an offline reload.

Design, failure table and the network-cut matrix: [docs/offline.md](docs/offline.md). Tests: `npm test -w @care-agent/pwa`.

### Known limits

- CPU only: ~20 s to read a crop plus ~7 output tokens/s; a full 8-page record takes many minutes. Analysis is designed to run in the background.
- Ollama returns no per-token probabilities for this model, so confidence comes from ink/model agreement and validators.
- Only pages 2, 3 and 4 have schemas so far (identification, pregnancy, delivery).
- Offline, only captures are queued; reviewing (corrections, confirmations) needs the server.
