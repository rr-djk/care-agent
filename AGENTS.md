# AGENTS.md

## Current state and next action (read first — updated Oct 3, 2026)

- `main` holds build steps 1–13 (see "Build progress" in `docs/Care_Agent-Dev_Plan.md`). Step 13 tooling is merged; its **full evaluation runs have NOT been done yet**. Step 14 (final docs, hardening, demo script, video fallback) has not started.
- **Next action, before anything else: the long evaluation runs.** They are run by the user (not by an agent: hours of CPU), in the worktree `../care-agent-eval` (a detached checkout of `main` with its own `node_modules`; do not delete it or switch its branch during a run). If you are an agent starting a session: remind the user of this first, give them the commands below, and wait for them to say the runs are finished; then read the outputs yourself (they are on this machine).
- Commands, in a separate terminal, one after another, Ollama running (`curl -s localhost:11434/api/version` prints a version), nothing else heavy open (~3 h total):

  ```
  cd ../care-agent-eval            # from the care-agent repo root
  git status                       # must say "HEAD detached at ..." on the latest main; else: git fetch && git checkout --detach origin/main && npm ci
  make degrade ARGS='--split calibrate --pages p4,p6 --variants blur-s1,blur-s2,blur-s4,dark-0.6,glare,jpeg-q30'   # ~1 min, no model
  make predict ARGS='--split calibrate --variants blur-s1,blur-s2,blur-s4,dark-0.6,glare,jpeg-q30' 2>&1 | tee eval-results/run-calibrate.log   # ~2 h
  CAL=$(ls -t eval-results/predictions-*.jsonl | head -1); echo "$CAL"
  make calibrate ARGS="--pred $CAL"          # seconds -> data/calibration/table.json + report.md
  make quality-curve ARGS="--pred $CAL"      # seconds
  make predict ARGS='--split verify --real 1-1' 2>&1 | tee eval-results/run-verify.log   # ~50 min
  VER=$(ls -t eval-results/predictions-*.jsonl | head -1); echo "$VER"
  make report ARGS="--pred $VER"             # seconds -> eval-results/report-<time>.md
  ```

  A run is complete only when it prints `wrote .../predictions-<time>.jsonl`. `calibrate failed: ... read by another pipeline` means the code changed between predict and calibrate (prompts, zones, ink thresholds or model): do not change those before or during the runs.
- **After the runs** (agent work): read `data/calibration/report.md`, the quality-curve output and `eval-results/report-*.md` in `../care-agent-eval`; set the gate thresholds in `packages/quality/src/thresholds.ts` only if the curve justifies it (procedure in `docs/quality.md`); copy `data/calibration/table.json` into the repo's `data/calibration/` for the server (git-ignored, it stays local); publish the verify report as `docs/results.md` (`make report ARGS="--pred <verify file> --publish"`); update README, this file and the Build progress table; then start step 14.
- Known measured numbers so far: tune split (12 pages) 92.2 % of handwritten cells right, 100 % of blank cells left blank; a finer pregnancy zone cut reached 98.3 % on one page at 4x the time and was not kept (`docs/scaling.md`).
- Open items for humans: phone test over HTTPS (README section 6, owner: a teammate); delete merged branches (the hook blocks agents from deleting branches: give the user `git branch -d ...` / `git push origin --delete ...` commands).

## Commands (use Make, not bare npm)

- `make check` — dataset guard + typecheck (schema, quality, server, pwa) + all tests (schema, quality, server, pwa, tools, python). Run before merging.
- `make server` (API :8787, `ANALYZER=off` skips the model, `ANALYZER=ink` never calls it: uploaded pages go straight to manual entry; `CHAT_ENGINE=strands` = optional LLM chat engine) and `make pwa` (Vite :5173, proxies `/api`; `VITE_FIXTURES=1` = no server). `make certs` needs mkcert (user installs it).
- `make test` — `npm test -w @care-agent/schema` (and quality, server, pwa), `node --import tsx --test tools/` (tsx: the step 13 tools import TypeScript), then `python3 -m unittest discover -s tools/eval`.
- `make pages` — `dedupe.mjs` THEN `split.mjs` (order matters; split reads `tools/eval/data/pages.json`).
- `make truth` — `extract_pdf.py` (ground truth) THEN `zones.py` THEN `zones_preview.py` (regenerates `docs/zones-p0*.png`).
- `make schemas` — bootstrap `packages/schema/pages/*.json` from ground truth + zones. **Overwrites hand edits**: the JSON files are the source of truth now; edit them, don't regenerate.
- `make eval ARGS='--extractor truth|empty|<preds.json> --split tune --pages p3'` — flags go through `ARGS=`; `make eval -- --flag` does not work. Results → `eval-results/` (gitignored).
- Step 13 (`docs/calibration.md`): `make degrade` (variants into `data/degraded/` + manifest), `make calibrate` (table into `data/calibration/`), `make quality-curve`, `make report` (`--publish` copies to `docs/results.md`), each with `ARGS='--pred <predictions.jsonl> ...'`; `make eval-full` chains them (documented, hours, never run by check). All outputs are git-ignored except `docs/results.md`.
- `make smoke` — `crop.py` then `probe.mjs`. Requires a running local runtime + `MODEL=<tag>`.
- `make quality-eval` — gate on the 80 specimens + 5 real photos + synthetic degradations (`tools/quality-eval.mjs`, needs `node --import tsx`), output in `eval-results/quality/` (gitignored). Must report `OK 80`.
- Single checks: `npm run typecheck -w @care-agent/schema`; `npm test -w @care-agent/schema`; `node --test tools/<file>.test.mjs`.
- Node >= 20, npm workspaces (`apps/*`, `packages/*`, `tools/*`). Deps pinned exact (`.npmrc` `save-exact=true`).

## Layout — source of truth

- `packages/schema/src/` — zod contracts (status, field, page, zone, lifecycle, entities, NDJSON events), page schemas (`pageSchema.ts`), zone prompts + answer parser (`prompt.ts`), normalizers + validators (`values.ts`). `docs/api.md` v0 mirrors them; keep both in sync. Error shape: `{ code, text }`.
- `@care-agent/schema` is browser-safe; `loadPageSchema` lives in `@care-agent/schema/node` (uses `node:fs`). Never import `node:*` from the main entry.
- `packages/schema/pages/<layout>.json` — fields (FieldDef), zones (ordered cell ids, `rows`/`columns` for tables, `label_strip`), masks. Done: cover, identification, pregnancy, delivery, postpartum_mother (pages 5 and 7, `page_types: [5,7]`), postpartum_newborn (6 and 8), plus `real_cover` (real registry, hand-written, see below). `applicability` = `"<field id> = <value>"` (no evaluator yet).
- Prompts must stay short (CPU prefill is the bottleneck): snapshot fixtures in `packages/schema/test-fixtures/`, all zones < 130 words (tested). Answer format `{"cells":[...]}`: `""` empty, `null` illegible, checkbox `"x"`/`""`. Ollama `format` uses `anyOf` string|null (not yet run against Ollama).
- `apps/server/src/` (API) — `app.ts` routes per `docs/api.md`, `db.ts` (SQLite + ordered migrations, `data/care-agent.db`), `auth.ts` (demo PIN login, bearer token), `lifecycle.ts` (transition persisted BEFORE responding), `originals.ts` (AES-256-GCM, byte-exact, decrypt in memory only), `stream.ts` (events stored for NDJSON replay), `worker.ts` (one page at a time, resumes `PENDING_AI` after restart; `manual()` = ink-only entry, not queued behind the model), `review.ts` (pure review queue: ordered items, French doubts, progress), `fields.ts` (`applyFieldEdit`: confirm / correct / leave illegible, shared by PATCH and chat; a corrected value that still fails a validator stays `NEEDS_REVIEW`), `chat.ts` (deterministic French intent parser, the default chat engine), `chat-llm.ts` (optional tool loop on Ollama `/v1`, tools bound to the request page), `privacy.ts` (PII guard, see `docs/security.md`), step 11: `linking.ts` (pure engine: link key, candidates, the question), `record.ts` (pure: retained values and re-digitization conflicts), `patients.ts` (DB glue: counter, `linkSession`, record, duplicates, ack); step 14: `stats.ts` (anonymized aggregates for the supervisor dashboard: bands, small cells under 5 hidden, no id; `GET /api/stats`, `/api/stats/reference` from the synthetic CSV under `DATASETS_DIR`; PWA `components/Dashboard.tsx` for the supervisor role). Midwives see only their own sessions (and the records of patients they linked); supervisor is read-only.
- Patient linking (step 11, `docs/api.md`, `docs/security.md`): key = the fiche number (the code written on the registry), narrowed by the facility when both sides have one (a patient created without facility has `facility = ''` and matches any); both normalized for matching only (fiche: upper case, separators → `-`, O/I/L read for 0/1 = low confidence, shape ≠ `dddd-ddd-ddd` = low confidence; facility: no accents, alphanumerics). Fiche (+ optional facility) come from the session (typed/confirmed via `PATCH /api/sessions/:id`, wins) else from the cover fields `p01.n_deg_de_la_fiche` / `p01.nom_de_l_etablissement_sanitaire`; pages 2–8 carry no fiche, a session inherits it. Candidates: exact (0.9), fiche ±1 edit, facility name ≤ 2 edits with the same fiche, same facility + DDR ±7 d + age ±1 (0.5–0.6); −0.3 when age (±1), DDR (±14 d), gravidity, parity or province contradicts. Question: `need_key` / `confirm_fiche` / `propose` (one exact consistent candidate) / `create` (none) / `choose` (the 4 buttons). The server never links or creates without `POST /api/sessions/:id/link`; ids `PAT-nnnnnn` come from the `counters` table. After the decision pages go VALIDATED → PATIENT_MATCHED → REGISTERED (`not_sure` → DUPLICATE_SUSPECTED, settled later with the same endpoint, by the owner midwife; the supervisor only lists). **SYNCED = the phone acknowledged the registered record** (`POST /api/sessions/:id/ack`, called by the PWA after the link result), no other state was added. Re-digitization: `record.ts` keeps the retained value per (page type, field); a conflict exists only when the record holds a usable (KNOWN, non-empty) value and the new page empties it, flags it or changes it; additions are silent; default = new if usable else old; choices live in `redigitization`, pages are never deleted.
- Linking gotchas: the table `counters` column is `id` (not `name`: the no-identifier test forbids column names like that; skip `sqlite_*` tables when scanning). Pages 7/8 reuse the field ids of 5/6, so retained values are keyed by page type. The PWA offers the question with an explicit button « C'était la dernière page » once every page is VALIDATED (the app cannot know which page is the last; linking early would block later pages: a linked session takes no new page). `session_started` resets the page list, review and link state but keeps the chat history and old page views (old summaries still render).
- `packages/quality/src/` — step 10, browser-safe and Node-safe (no `node:*`): `cv.ts` (`loadCv`, `Scope` to free wasm objects), `metrics.ts` (blur per inked tile, exposure, glare), `quad.ts` (page detection), `gate.ts` (`assess` → `QualityResult` + details), `warp.ts` (`warpPage` → 1654×2339), `thresholds.ts` (PROVISIONAL, step 13 recalibrates), `stability.ts` (auto-capture trigger), `synthetic.ts` (degradation helpers, import `@care-agent/quality/synthetic`; tests + eval only). Docs: `docs/quality.md`.
- Quality gotchas: the OpenCV.js module object is THENABLE: `await cv` / returning it from an async function hangs forever, wait for `cv.onRuntimeInitialized` (`loadCv` does). Every `mat.data` access builds a new typed array view: cache it before a pixel loop (a 700 k-pixel loop went from 1.3 s to 0.04 s). Free Mats (`Scope`). The npm file (~11 MB) cannot be imported by a Vite module worker (its UMD wrapper has no `this`): the PWA worker fetches the hashed asset (`?url`) and runs it as a classic script (`loadCv(url)`); Node imports the package. Never `pkill -f <pattern>` with a pattern that also appears in your own shell command (it kills the shell).
- Quality rules: OK / WARNING / REJECT, never a hard block (REJECT only black or no paper; failing check = capture proceeds). « Garder quand même » adds the `LOW_QUALITY` flag; the server then turns every `KNOWN` field of that page into `NEEDS_REVIEW` (`reason: low_quality`, quality signal 0.5, `applyLowQuality` in `worker.ts`). The check runs BEFORE `store.addPage` (offline-safe) and `meta.quality` / `meta.flags` ride in the encrypted queue record. The server rectifies in memory only (`vision/rectify.ts`, counter-only log); originals stay byte-exact. Live camera: the captured image is the WHOLE frame and the guide is drawn in a box with the video's own aspect ratio; `takePhoto` is used only when its aspect matches the frame.
- Calibration (step 13, `apps/server/src/calibration.ts`, `tools/eval/{calibrate,report,quality-curve,degrade}.mjs`, `docs/calibration.md`): the table `data/calibration/table.json` (per category: accuracy of KNOWN fields at gate-OK quality, Wilson interval, `demote`) is loaded by `main.ts` at start and applied on the model path only (`applyCalibration`: `calibrated` = accuracy × quality factor, KNOWN → `NEEDS_REVIEW` with `reason: low_category_confidence` when the lower bound is under 0.95; insufficient n = untouched). **`pipelineHash()` = model tag + zone prompts + page schemas + cell boxes + ink constants (`INK_PARAMS`) + crop `PAD_PX`: any change to the prompt, the zones, the ink thresholds or the model invalidates the table** (the server logs and ignores a stale one, `calibrate` refuses predictions made by another pipeline): rerun `predict` on the calibrate split, then `calibrate`. Gotchas: only the quality factor varies among KNOWN fields (agreement and validators are constant there); `predict` writes `.jsonl` (one record per image, appended page by page; `run.mjs` reads it too); `--limit 0 --real 1-1` reads the real photo alone; variants are rectified like uploads, clean specimens are not; calibrate refuses records outside the calibrate split and report outside verify; never tune on `verify` or the real photos. The pregnancy table stays at 13 zones on purpose (processing time): the 22-zone cut at the section bands (98.3 % vs 90.4 % on tune page 27, 4× slower) is commit `45d655f`, reverted; see `docs/scaling.md`. Rebuilding one layout: regenerate zones, then `build_schemas.mjs --out <scratch>` and copy only that layout; the others must stay byte-identical.
- `better-sqlite3` is pinned to 12.x (13 needs Node 22 and segfaults on Node 20); vitest pinned to 4.x for the same reason.
- `apps/pwa/src/` — `api.ts` (token in memory only, 30 s timeout, `netBlocked()` = no call at all), `offline/` (see Offline), `quality/` (`worker.ts` OpenCV in a Web Worker, `client.ts`, `guide.ts` A4 guide geometry + `cameraAvailable`), `ndjson.ts`, `state.ts` (pure reducer: review walk one item at a time, page list, chat stream), `components/` (UI revamp: `Shell` = bottom tabs Discussions / Patientes / Synchro for a midwife, Statistiques / Patientes for the supervisor, runs the sync engine for the whole app and locks after 5 min idle (`store.lock()` forgets the key, keeps the encrypted token); `Home` = one row per fiche (`home.ts`: status, badge, ticks 1 phone / 2 server / 3 record); `Chat` = one fiche (page chips, page-type sheet, composer); `ReviewCard` = C'est juste / Corriger / Reprendre la photo / Illisible; `PageSummary` = flagged first, then the form's sections (`summary.ts`: zone -> section, tables as grids, pregnancy per trimester); `MatchCard` = the link question with this fiche and each candidate side by side (`compareRows` mirrors the server cross-checks); `Patients` / `Profile` = `GET /api/patients` and the record (`profile.ts`); `SyncView`; `Stats` = the aggregates; `CameraCapture`, `QualityPanel`, `DifferencesCard`).
- Bilingual UI (`apps/pwa/src/i18n.ts`): one `fr` and one `en` table, same keys (TypeScript checks it, `i18n.test.ts` checks placeholders); choice per device in localStorage; `t()` also sets plurals from the number before "(s)". Chat messages store a key + params (`msgText`), so they re-render in the current language; server texts stay French (review doubts are rebuilt from `reason_code` in English, quality-gate and dashboard texts are translated by exact French text: keep `QUALITY_EN` / `dashboard.ts` in sync when the server wording changes). No font or other third-party request (system fonts). Labels come from `packages/schema/pages/*.json`; never import `@care-agent/schema/node` in the PWA. Never display a raw confidence percentage (the one exception: the optional « Détails » link of the review card, `detail_fr`, for the jury).
- Offline (`apps/pwa/src/offline/`, `docs/offline.md`): `crypto.ts` (PBKDF2 310k → non-extractable AES-GCM key in memory, profile = salt + encrypted canary + encrypted token, delay after 5 wrong PINs), `store.ts` (IndexedDB `profiles`/`sessions`/`pages`/`blobs`, bodies sealed with a random IV per record; only ids, owner, order and queue state in clear; also the vault: `enroll`/`unlock`/`logout`/`wipe`), `sync.ts` (one loop, capture order; a page is `UPLOADED` only on a 200 with the same sha256, then its blob is deleted; network/5xx = backoff, 4xx/409 = `SYNC_FAILED` + Réessayer; never auto-drop), `network.ts` (simulation switch, `navigator.onLine`, reachability).
- Offline gotchas: sessions are created on the phone (`POST /api/sessions` with a client `id`, idempotent). The reducer dedupes analysis events by identity because the stream is reopened after a drop and the server replays everything (`record_ready` is keyed with the number of settled pages). Reload = PIN again (key only in memory; no token in sessionStorage). Reloading offline needs the service worker, so use `vite build` + `vite preview`, not the dev server. A 502 from the Vite proxy is "server down", not a refusal. `fake-indexeddb` is the PWA test dependency; generate a fast AES key with `setKey` in tests, the real PBKDF2 costs ~0.2 s. Offline review edits are not queued (captures only).
- `apps/server/src/vision/` — `manual.ts` (ink-only reading for manual entry), `crop.ts` (masks painted black BEFORE cropping; table zones get their `label_strip` on the left), `ink.ts` (ink ratio per cell; thresholds per layout from `ink-eval`), `model.ts` (Ollama native client), `analyze.ts` (statuses), `cache.ts` (`data/cache/`, key = crop + prompt + format + model), `queue.ts` (one model call at a time).
- Analysis rule: only text cells WITH ink are sent to the model, listed explicitly in the prompt (`buildZonePrompt(..., {cells})`). Asked for a whole grid, Gemma packs filled values together and loses positions. Checkboxes are never sent: ink decides. A model `""` on an inked cell → `NEEDS_REVIEW`.
- Commands: `npm run analyze -w @care-agent/server -- <page_no|png> [--zones a,b] [--save-crops name]` (`--save-crops` writes crop PNG + prompt + raw answer per zone under the git-ignored `data/crops/name`), `make predict ARGS='--split tune --pages p3 --limit 1'` then `make eval ARGS='--extractor eval-results/predictions-<ts>.jsonl ...'`, `npm run ink-eval -w @care-agent/server`. Long model runs: run in the background; never two at once (one Ollama, CPU).
- Step 12 (pages 5–8, real form): `postpartum_mother` = 53 fields / 7 zones, `postpartum_newborn` = 44 / 5; keys `p05.*` / `p06.*` are shared by pages 7/8, the analyzer stamps `source_page` with the real page type and `record.ts` keeps values per page type. Pages 5 and 7 print different header options ("7ème et 8ème jour" vs "40ème et 50ème jour", at other positions): the layout holds all four boxes (`zones.py` `EXTRA_TEMPLATE_PAGE_TYPE`), the ones of the other page type are simply unticked. `extract_pdf.py` masks the "MÈRE — <name>" line (it lies outside `BODY_Y`, so it is not an identifier slot). Zones are kept under ~150 words as a full prompt (the 140-word test): a 33-cell zone failed it, hence 7 mother zones. `normalizeValue` ignores the degree sign in units (handwriting often has no "°": "36.8 C" = "36.8 °C"). Temperature 34–42, pulse 40–180, weight kg 30–200 (mother), newborn weight g 400–8000, age 0–90 jours, height cm 30–70, head circumference 20–45; applicability: scar ⇐ césarienne, medication text ⇐ notion de prise, pilule/DIU/autre ⇐ désire une méthode, "pourquoi" ⇐ not désire, référence ⇐ transfert.
- Real form (held out, NEVER tune on it): `REAL_LAYOUTS = ['real_cover']` in `pageSchema.ts` (not in `PAGE_LAYOUTS`, which the specimen tests and `ink-eval` iterate). Its zones/cell boxes (`tools/eval/data/zones/real_cover.json`) are drawn by hand on 1-1.jpg AFTER the `rectify.ts` warp (1654×2339); the CLI warps by itself for a real layout (`loadLayoutImage` in `cli/pages.ts`). Use an absolute photo path (npm runs the CLI from `apps/server`). The real checkboxes are ~40 px with thick borders (specimen 22 px): the ink detector gives checkbox false positives there (see README), to be recalibrated on the calibrate split in step 13, not on the photo. The hand labels `real_photos_labels.json` are by the assistant, to be verified by a human. Spreads (1-2..1-5) have no template (`docs/labeling.md`).
- `tools/eval/data/ground_truth.json` — per PDF page: slots `{key, kind text|checkbox, value, bbox_frac}`. Keys are stable per layout (pages 7/8 reuse `p05`/`p06` keys). Identifier slots never exist; staff names are `<staff>`; at run time `staffRole` (privacy.ts) reduces « Examen fait par » / « Vu par » to the role or `<staff>`, never a name. `extract_pdf.py` aborts if an excluded value would be written.
- `tools/eval/data/zones/<layout>.json` — one zone = one model call (cover = page type 1, plan in `zones.py`; its name line is a mask with no cell; `docs/zones-p01.png`; `make eval` and `make predict` default to `p1..p8`, ink thresholds `TEXT_INK_MIN` have 0.01 for `cover`, `postpartum_mother`, `postpartum_newborn`, `delivery` and `real_cover` because of the dotted « Autres à préciser » lines); `cells` order = order of `ZoneAnswer.cells`. Built from patient 1's geometry; `masks` = identifier rectangles to blank before any crop leaves the device or is shown.
- Comparison rule (`run.mjs` + `normalize.mjs`, mirrored in `normalize.py`): case-fold, strip accents, decimal comma → dot, drop whitespace; also equal once accented letters are dropped (some handwriting fonts lack "é": image shows "N ant" for "Néant").
- `tools/check-datasets.mjs` — read-only guard (existence + bytes + sha256 per `manifest.json` entry).
- `tools/eval/{dedupe,split}.mjs` — 80 unique pages; 3-way patient split, `SEED=20261003`, tune 4 / calibrate 3 / verify 3.
- `tools/smoke/{crop.py,probe.mjs}` — CPU latency gate; output to `tools/smoke/out/` (gitignored).

## Datasets — read-only, outside repo

- Located via `DATASETS_DIR` (default `../datasets`). Never write there — `crop.py` refuses paths inside it.
- `check-datasets` resolves each manifest entry under `DATASETS_DIR`, then its parent (`consignes-fr-en.pdf` lives one level above datasets — the fallback is intentional).
- `tools/eval/data/` (pages, split, ground truth, zones, masks, labeling template) is the one committed exception to the `data/` gitignore. Commit regenerations; nothing else under `data/`, `crops/`, `eval-results/`, `models/`.
- PDF facts: printed text is always Helvetica; handwriting is any other font (one per patient). Checkboxes are 8×8 pt vector squares, ticks are strokes inside. Pages are skewed up to ~±0.45° (≈15 px at 200 dpi) → crops need padding or rectification.
- Page 3 zones of visit columns 2–3 contain no row labels: the cropper must prepend the row-label strip.
- `dedupe.mjs` cross-checks the PDF via `pdftotext` when installed; warns and skips when absent (not a failure).

## Smoke probe quirks (from `docs/runtime-notes.md`)

- Ollama native API: `"think": false` works. OpenAI-compatible `/v1`: `think` is ignored — use `reasoning_effort: none` via `EXTRA_BODY`.
- Prompt wording matters: `null = illegible. Never guess.` made Gemma answer null for every cell of clearly written zones; the current wording keeps null only for writing that cannot be read at all. Any prompt change: update the fixtures and re-run `make predict` + `make eval` on the tune split.
- Ollama logprobs with `gemma4:e4b` return only the FIRST token: no per-cell probability. Don't build on `token_prob`.
- Ollama exposes no visual-token budget: `BUDGETS=560,1120` labels are only recorded unless `EXTRA_BODY_<label>` (valid JSON) is set.
- Exit codes: 0 ok, 1 missing `MODEL`/bad env/crop, 2 runtime unreachable. Default `BASE_URL=http://localhost:11434/v1`.
- Python is only for offline scripts (`crop.py` needs PIL). TS everywhere else.

## Workflow constraints

- One branch per plan step: `feature/step-N-name`, merged to `main` once verified, then pushed. Conventional Commits in English. Progress table: "Build progress" in `docs/Care_Agent-Dev_Plan.md`.
- No identifier fields anywhere: woman's name, husband's name, CIN, phone, address. Enforced by schema tests — keep that test green.
- French-first UI/labels (English available, `i18n.ts`); dev plan lives at `docs/Care_Agent-Dev_Plan.md` (steps 1–13 merged; step 13 full runs pending). Before each merge into `main`: update the README "How to test" section, this file and the "Build progress" table.

---

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes..
