# AGENTS.md

## Commands (use Make, not bare npm)

- `make check` — dataset guard + schema typecheck + all tests. Run before opening a PR.
- `make test` — `npm test -w @care-agent/schema` then `node --test tools/`.
- `make pages` — `dedupe.mjs` THEN `split.mjs` (order matters; split reads `tools/eval/data/pages.json`).
- `make smoke` — `crop.py` then `probe.mjs`. Requires a running local runtime + `MODEL=<tag>`.
- Single checks: `npm run typecheck -w @care-agent/schema`; `npm test -w @care-agent/schema`; `node --test tools/<file>.test.mjs`.
- Node >= 20, npm workspaces (`apps/*`, `packages/*`, `tools/*`). Deps pinned exact (`.npmrc` `save-exact=true`).

## Layout — source of truth

- `packages/schema/src/` — zod contracts (status, field, page, zone, lifecycle, entities, NDJSON events). `docs/api.md` v0 mirrors them; keep both in sync. Error shape: `{ code, text }`.
- `apps/pwa`, `apps/server`, `tools/eval` — still stubs (plan steps 3+ not started).
- `tools/check-datasets.mjs` — read-only guard (existence + bytes + sha256 per `manifest.json` entry).
- `tools/eval/{dedupe,split}.mjs` — 80 unique pages; 3-way patient split, `SEED=20261003`, tune 4 / calibrate 3 / verify 3.
- `tools/smoke/{crop.py,probe.mjs}` — CPU latency gate; output to `tools/smoke/out/` (gitignored).

## Datasets — read-only, outside repo

- Located via `DATASETS_DIR` (default `../datasets`). Never write there — `crop.py` refuses paths inside it.
- `check-datasets` resolves each manifest entry under `DATASETS_DIR`, then its parent (`consignes-fr-en.pdf` lives one level above datasets — the fallback is intentional).
- `tools/eval/data/` (`pages.json`, `split.json`) is the one committed exception to the `data/` gitignore. Commit regenerations; nothing else under `data/`, `crops/`, `eval-results/`, `models/`.
- `dedupe.mjs` cross-checks the PDF via `pdftotext` when installed; warns and skips when absent (not a failure).

## Smoke probe quirks (from `docs/runtime-notes.md`)

- Ollama native API: `"think": false` works. OpenAI-compatible `/v1`: `think` is ignored — use `reasoning_effort: none` via `EXTRA_BODY`.
- Ollama exposes no visual-token budget: `BUDGETS=560,1120` labels are only recorded unless `EXTRA_BODY_<label>` (valid JSON) is set.
- Exit codes: 0 ok, 1 missing `MODEL`/bad env/crop, 2 runtime unreachable. Default `BASE_URL=http://localhost:11434/v1`.
- Python is only for offline scripts (`crop.py` needs PIL). TS everywhere else.

## Workflow constraints

- One branch per plan step: `feature/step-N-name`, merged to `main` only after validation. Conventional Commits in English.
- No identifier fields anywhere: woman's name, husband's name, CIN, phone, address. Enforced by schema tests — keep that test green.
- French-first UI/labels; dev plan lives at `docs/Care_Agent-Dev_Plan.md` (steps 1–2 validated/merged).

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
