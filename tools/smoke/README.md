# Smoke test: latency gate

1. `python3 tools/smoke/crop.py [x0 y0 x1 y1] [out.png]` crops one zone of specimen page 3 (default box: first rows of the visit table) to `tools/smoke/out/p03_crop.png`. Reads `DATASETS_DIR` (default `../datasets`); never writes there.
2. Start a local OpenAI-compatible runtime (Ollama, llama.cpp server, LM Studio) with Gemma 4 E4B-it.
3. `MODEL=<tag> node tools/smoke/probe.mjs` (or `make smoke`).

## Env vars

| Var | Meaning |
| --- | --- |
| `BASE_URL` | default `http://localhost:11434/v1` (Ollama) |
| `MODEL` | required |
| `API_KEY` | optional bearer token |
| `RUNTIME_PROC` | optional process name; RSS summed via `ps -o rss= -C <name>` |
| `EXTRA_BODY` | optional JSON merged into every request body |
| `BUDGETS` | comma list of labels, default `560,1120`. Labels are only recorded; if `EXTRA_BODY_<label>` (JSON) exists it is merged into that budget's requests |
| `CROP` | optional crop path, default `tools/smoke/out/p03_crop.png` |

The way to set the visual token budget is runtime-specific and unverified. Find the right parameter for your runtime and pass it via `EXTRA_BODY_560` / `EXTRA_BODY_1120`.

Per budget: 1 cold run + 3 warm runs (streaming; total latency, time to first content chunk, tokens/s when usage is returned, JSON validity). Plus one logprobs request and one `json_schema` response_format request. Output: markdown table and `tools/smoke/out/results.json`.

Exit codes: 0 ok, 1 missing MODEL / other error, 2 runtime unreachable.

## Decision rule

GO if one zone takes <= ~30 s warm and a full page (~15 zones) <= ~3 min. Otherwise fallback ladder: fewer/larger crops -> budget 560 -> crop+prompt hash cache -> Gemma 4 E2B. Record results in `docs/runtime-notes.md`.
