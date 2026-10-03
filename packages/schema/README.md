@care-agent/schema: the shared source of truth, used by the server, the PWA and the eval tools.

- `src/` — zod contracts (statuses, fields, page types, compact zone answer, lifecycle and transitions, entities, NDJSON events, review queue), page schema contract, zone prompt generator + answer parser (`prompt.ts`), normalizers and validators (`values.ts`).
- `pages/<layout>.json` — one schema per page layout (identification, pregnancy, delivery so far): fields with type, category, unit, validators, applicability, and the ordered zones sent to the model. Hand-edited source of truth.
- `test-fixtures/` — exact prompt snapshots; update them when the prompt wording changes on purpose.
- Main entry is browser-safe; `@care-agent/schema/node` adds `loadPageSchema` (uses `node:fs`).
- Tests: `npm test -w @care-agent/schema`.
