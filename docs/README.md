# Docs

- `Care_Agent-Dev_Plan.md` — project plan (overview, stack, principles, phases) and the living **Build progress** table.
- `runtime-notes.md` — Gemma 4 E4B on Ollama: capabilities (think off, JSON schema, logprobs = first token only), measured latencies on the CPU laptop, GO decision.
- `api.md` — HTTP API contract of the local server (auth, upload, NDJSON analysis stream, review, chat, originals).
- `security.md` — prompt-injection stance, PII guard, what is never stored or logged.
- `offline.md` — offline design (PIN-derived key, encrypted IndexedDB queue, sync rules) and the network-cut test matrix.
- `calibration.md` — step 13: protocol, signals we have and lack, decision rule, degraded variants, long-run commands and durations, tuning experiment.
- `scaling.md` — accuracy vs latency: how a finer zone cut reached 98 % and how to deploy it with more compute (pitch material).
- `results.md` — final report on the verify split (written by `make report ARGS='... --publish'`; absent until the full runs are done).
- `labeling.md` — how to hand-label the 5 real photos (template in `tools/eval/data/`).
- `quality.md` — on-device image quality gate (metrics, provisional thresholds, evaluation on specimens, degradations and real photos, page warp).
- `zones-p01.png` … `zones-p06.png` — crop zones drawn on specimen pages (cover, identification, pregnancy, delivery, postpartum mother, postpartum newborn; identifiers masked).

How to run and test everything: the root `README.md` ("How to test"). Facts and gotchas for contributors and coding agents: `AGENTS.md`.
