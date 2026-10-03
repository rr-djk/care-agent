# HTTP API contract (v0, may change)

Local Hono server on the laptop. Payload shapes are the zod schemas in `packages/schema`. Errors: JSON `{ "code", "text" }` with a 4xx/5xx status.

| Method | Path | Request | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/pages` | multipart: `meta` (RecordPage JSON, `id` = UUID created on the phone) + `image` (original file) | `200` RecordPage | Idempotent by page id: a replay returns the stored page and changes nothing. The server recomputes the SHA-256 and rejects (`409`) a mismatch with `meta.sha256`. |
| GET | `/api/pages/:id` | none | RecordPage + `fields: ExtractedField[]` | |
| GET | `/api/sessions/:id/analysis` | none | NDJSON stream of analysis events (`page_received`, `page_read`, `field_flagged`, `record_ready`) | One JSON object per line, parsed with `parseEvent`. Replays the events already produced, then follows live. |
| PATCH | `/api/pages/:id/fields/:fieldId` | `{ value, status? }` | updated ExtractedField | Midwife correction; audited (role, old value, new value, time). |
| POST | `/api/pages/:id/confirm` | none | RecordPage | Moves the page to `VALIDATED` if the lifecycle allows it; idempotent when already validated. |
| GET | `/api/patients/candidates?fiche=&facility=` | query | `Candidate[]` | Looked up by `(fiche_number, facility)`. No personal identifiers are ever returned. |
| POST | `/api/sessions/:id/link` | LinkDecision | `Patient` or `{ status: "not_sure" }` | `create_new` allocates the next `PAT-000001...` from a server counter. |
| POST | `/api/chat` | `{ session_id, message }` | NDJSON stream of chat events (`token`, `ping`, `done`, `error`) | `ping` keeps the connection alive during slow CPU inference. |
| GET | `/api/originals/:pageId` | none | original image bytes | Role-restricted: the `midwife` for her own patients' pages, the `supervisor` for all; every access is logged. |
| GET | `/api/health` | none | `{ status: "ok", model: string \| null }` | Public on the local network. |

Conventions:

- Streams use `Content-Type: application/x-ndjson`, one event per line, no framing beyond the newline.
- Roles are `midwife` and `supervisor`; the mechanism that identifies the caller is not decided yet.
