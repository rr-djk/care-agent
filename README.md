# care-agent

Offline-first PWA that turns photos of a paper maternal registry into a structured, midwife-verified record.
A phone captures and checks pages; a laptop on the local Wi-Fi runs a local Gemma 4 E4B-it and a Hono/TypeScript server.
No internet, no cloud. Step 1 is a CPU latency GO/NO-GO gate for the model.

## Layout

- `apps/pwa` - Vite + React client (placeholder)
- `apps/server` - local Hono/TypeScript server (placeholder)
- `packages/schema` - schema as data (placeholder)
- `tools/eval` - evaluation (placeholder)
- `tools/check-datasets.mjs` - dataset integrity guard; `tools/smoke/` - latency probe
- `docs/` - plan and runtime notes

## Usage

- `make check` - verify datasets (size + sha256) and run tests
- `make smoke` - crop one zone and probe the local runtime (see `tools/smoke/README.md`)

Plan: [docs/Care_Agent-Dev_Plan.md](docs/Care_Agent-Dev_Plan.md)

Datasets live outside the repo and are located via `DATASETS_DIR` (default `../datasets`).
