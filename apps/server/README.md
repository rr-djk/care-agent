
## API server

- `make server` (or `npm run dev -w @care-agent/server`): listens on `0.0.0.0:$PORT` (default 8787) so the phone can connect over the LAN. Contract: `docs/api.md`.
- Env: `DATA_DIR` (default `<repo>/data`, git-ignored: `care-agent.db`, `originals/`, `originals.key`, `users.json`), `ORIGINALS_KEY` (64 hex chars; else `DATA_DIR/originals.key` is created with mode 0600), `PORT`, `ANALYZER=off` (skip the analysis, pages stay `PENDING_AI`; no Ollama needed), `ANALYZER=ink` (never call the model: uploaded pages go straight to manual entry, text cells with ink are typed by the midwife), `CHAT_ENGINE=strands` (optional LLM chat engine: tool loop on Ollama's `/v1`, model from `CHAT_MODEL`, else `MODEL`; the default chat engine is a deterministic parser), plus the Ollama variables above.
- Demo users (demo-grade auth, see `docs/api.md`): on first start `sf-01`, `sf-02` (midwives) and `sup-01` (supervisor) are created with random PINs printed once on the console (stored hashed). To choose them, put `[{ "id": "sf-01", "role": "midwife", "pin": "123456" }]` in `DATA_DIR/users.json` before the first start.
- Originals are stored AES-256-GCM encrypted (`originals/<pageId>.bin` = iv | tag | ciphertext) and decrypted in memory only. Losing the key makes them unreadable.
- Review flow: `GET /api/sessions/:id/review` (queue + progress), `PATCH` confirm / correct / leave illegible, `POST /api/pages/:id/manual`, `POST /api/chat`; chat messages and identifiers (PII guard) are covered in `docs/security.md`.
- Before the analysis the page is rectified in memory (`vision/rectify.ts`: perspective warp to 1654×2339 when a page quad is found, see `docs/quality.md`); the stored original is untouched; the log keeps only a counter (`warp: n of m analysed pages rectified since start`). A page uploaded with the `LOW_QUALITY` flag has all its `KNOWN` fields moved to `NEEDS_REVIEW` (`reason: low_quality`).
- Logs hold method, path (ids) and status only, never field values.
- Tests (`npm test -w @care-agent/server`) use a temp `DATA_DIR` and a fake analyzer: no Ollama.
