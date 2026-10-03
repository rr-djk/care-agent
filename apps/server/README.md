@care-agent/server: vision pipeline (crop, ink, Ollama client, zone analysis) and its CLIs.

- `npm run analyze -w @care-agent/server -- <page.png | page_no> [--layout L] [--zones id1,id2] [--json out.json]`
- `make predict ARGS='--split tune --pages p3 --limit 1'` then `make eval ARGS='--extractor eval-results/predictions-<ts>.json ...'`
- `npm run ink-eval -w @care-agent/server`: ink detector vs the ground truth (no model).
- Env: `OLLAMA_URL` (default `http://localhost:11434`), `MODEL` (default `gemma4:e4b`), `DATASETS_DIR`. Model answers are cached in `data/cache/` (git-ignored).
