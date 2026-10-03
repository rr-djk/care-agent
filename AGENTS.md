# AGENTS.md

## Commands (use Make, not bare npm)

- `make check` — dataset guard + typecheck (schema, server, pwa) + all tests (schema, server, pwa, tools, python). Run before merging.
- `make server` (API :8787, `ANALYZER=off` skips the model, `ANALYZER=ink` never calls it: uploaded pages go straight to manual entry; `CHAT_ENGINE=strands` = optional LLM chat engine) and `make pwa` (Vite :5173, proxies `/api`; `VITE_FIXTURES=1` = no server). `make certs` needs mkcert (user installs it).
- `make test` — `npm test -w @care-agent/schema`, `node --test tools/`, then `python3 -m unittest discover -s tools/eval`.
- `make pages` — `dedupe.mjs` THEN `split.mjs` (order matters; split reads `tools/eval/data/pages.json`).
- `make truth` — `extract_pdf.py` (ground truth) THEN `zones.py` THEN `zones_preview.py` (regenerates `docs/zones-p0*.png`).
- `make schemas` — bootstrap `packages/schema/pages/*.json` from ground truth + zones. **Overwrites hand edits**: the JSON files are the source of truth now; edit them, don't regenerate.
- `make eval ARGS='--extractor truth|empty|<preds.json> --split tune --pages p3'` — flags go through `ARGS=`; `make eval -- --flag` does not work. Results → `eval-results/` (gitignored).
- `make smoke` — `crop.py` then `probe.mjs`. Requires a running local runtime + `MODEL=<tag>`.
- Single checks: `npm run typecheck -w @care-agent/schema`; `npm test -w @care-agent/schema`; `node --test tools/<file>.test.mjs`.
- Node >= 20, npm workspaces (`apps/*`, `packages/*`, `tools/*`). Deps pinned exact (`.npmrc` `save-exact=true`).

## Layout — source of truth

- `packages/schema/src/` — zod contracts (status, field, page, zone, lifecycle, entities, NDJSON events), page schemas (`pageSchema.ts`), zone prompts + answer parser (`prompt.ts`), normalizers + validators (`values.ts`). `docs/api.md` v0 mirrors them; keep both in sync. Error shape: `{ code, text }`.
- `@care-agent/schema` is browser-safe; `loadPageSchema` lives in `@care-agent/schema/node` (uses `node:fs`). Never import `node:*` from the main entry.
- `packages/schema/pages/<layout>.json` — fields (FieldDef), zones (ordered cell ids, `rows`/`columns` for tables, `label_strip`), masks. Done: identification, pregnancy, delivery. `applicability` = `"<field id> = <value>"` (no evaluator yet).
- Prompts must stay short (CPU prefill is the bottleneck): snapshot fixtures in `packages/schema/test-fixtures/`, all zones < 130 words (tested). Answer format `{"cells":[...]}`: `""` empty, `null` illegible, checkbox `"x"`/`""`. Ollama `format` uses `anyOf` string|null (not yet run against Ollama).
- `apps/server/src/` (API) — `app.ts` routes per `docs/api.md`, `db.ts` (SQLite + ordered migrations, `data/care-agent.db`), `auth.ts` (demo PIN login, bearer token), `lifecycle.ts` (transition persisted BEFORE responding), `originals.ts` (AES-256-GCM, byte-exact, decrypt in memory only), `stream.ts` (events stored for NDJSON replay), `worker.ts` (one page at a time, resumes `PENDING_AI` after restart; `manual()` = ink-only entry, not queued behind the model), `review.ts` (pure review queue: ordered items, French doubts, progress), `fields.ts` (`applyFieldEdit`: confirm / correct / leave illegible, shared by PATCH and chat; a corrected value that still fails a validator stays `NEEDS_REVIEW`), `chat.ts` (deterministic French intent parser, the default chat engine), `chat-llm.ts` (optional tool loop on Ollama `/v1`, tools bound to the request page), `privacy.ts` (PII guard, see `docs/security.md`). Midwives see only their own sessions; supervisor is read-only.
- `better-sqlite3` is pinned to 12.x (13 needs Node 22 and segfaults on Node 20); vitest pinned to 4.x for the same reason.
- `apps/pwa/src/` — `api.ts` (token in memory only, 30 s timeout, `netBlocked()` = no call at all), `offline/` (see Offline), `ndjson.ts`, `state.ts` (pure reducer: review walk one item at a time, page list, chat stream), `components/` (`ReviewCard` = Confirmer / Corriger / Reprendre la photo / Laisser illisible). Labels come from `packages/schema/pages/*.json`; never import `@care-agent/schema/node` in the PWA. Never display a raw confidence percentage.
- Offline (`apps/pwa/src/offline/`, `docs/offline.md`): `crypto.ts` (PBKDF2 310k → non-extractable AES-GCM key in memory, profile = salt + encrypted canary + encrypted token, delay after 5 wrong PINs), `store.ts` (IndexedDB `profiles`/`sessions`/`pages`/`blobs`, bodies sealed with a random IV per record; only ids, owner, order and queue state in clear; also the vault: `enroll`/`unlock`/`logout`/`wipe`), `sync.ts` (one loop, capture order; a page is `UPLOADED` only on a 200 with the same sha256, then its blob is deleted; network/5xx = backoff, 4xx/409 = `SYNC_FAILED` + Réessayer; never auto-drop), `network.ts` (simulation switch, `navigator.onLine`, reachability).
- Offline gotchas: sessions are created on the phone (`POST /api/sessions` with a client `id`, idempotent). The reducer dedupes analysis events by identity because the stream is reopened after a drop and the server replays everything (`record_ready` is keyed with the number of settled pages). Reload = PIN again (key only in memory; no token in sessionStorage). Reloading offline needs the service worker, so use `vite build` + `vite preview`, not the dev server. A 502 from the Vite proxy is "server down", not a refusal. `fake-indexeddb` is the PWA test dependency; generate a fast AES key with `setKey` in tests, the real PBKDF2 costs ~0.2 s. Offline review edits are not queued (captures only).
- `apps/server/src/vision/` — `manual.ts` (ink-only reading for manual entry), `crop.ts` (masks painted black BEFORE cropping; table zones get their `label_strip` on the left), `ink.ts` (ink ratio per cell; thresholds per layout from `ink-eval`), `model.ts` (Ollama native client), `analyze.ts` (statuses), `cache.ts` (`data/cache/`, key = crop + prompt + format + model), `queue.ts` (one model call at a time).
- Analysis rule: only text cells WITH ink are sent to the model, listed explicitly in the prompt (`buildZonePrompt(..., {cells})`). Asked for a whole grid, Gemma packs filled values together and loses positions. Checkboxes are never sent: ink decides. A model `""` on an inked cell → `NEEDS_REVIEW`.
- Commands: `npm run analyze -w @care-agent/server -- <page_no|png> [--zones a,b]`, `make predict ARGS='--split tune --pages p3 --limit 1'` then `make eval ARGS='--extractor eval-results/predictions-<ts>.json ...'`, `npm run ink-eval -w @care-agent/server`. Long model runs: run in the background; never two at once (one Ollama, CPU).
- `tools/eval/data/ground_truth.json` — per PDF page: slots `{key, kind text|checkbox, value, bbox_frac}`. Keys are stable per layout (pages 7/8 reuse `p05`/`p06` keys). Identifier slots never exist; staff names are `<staff>`. `extract_pdf.py` aborts if an excluded value would be written.
- `tools/eval/data/zones/<layout>.json` — one zone = one model call; `cells` order = order of `ZoneAnswer.cells`. Built from patient 1's geometry; `masks` = identifier rectangles to blank before any crop leaves the device or is shown.
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
- Ollama logprobs with `gemma4:e4b` return only the FIRST token: no per-cell probability. Don't build on `token_prob`.
- Ollama exposes no visual-token budget: `BUDGETS=560,1120` labels are only recorded unless `EXTRA_BODY_<label>` (valid JSON) is set.
- Exit codes: 0 ok, 1 missing `MODEL`/bad env/crop, 2 runtime unreachable. Default `BASE_URL=http://localhost:11434/v1`.
- Python is only for offline scripts (`crop.py` needs PIL). TS everywhere else.

## Workflow constraints

- One branch per plan step: `feature/step-N-name`, merged to `main` once verified, then pushed. Conventional Commits in English. Progress table: "Build progress" in `docs/Care_Agent-Dev_Plan.md`.
- No identifier fields anywhere: woman's name, husband's name, CIN, phone, address. Enforced by schema tests — keep that test green.
- French-first UI/labels; dev plan lives at `docs/Care_Agent-Dev_Plan.md` (steps 1–9 merged). Before each merge into `main`: update the README "How to test" section, this file and the "Build progress" table.

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
