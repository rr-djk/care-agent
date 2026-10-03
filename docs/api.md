# HTTP API contract (v0, may change)

Local Hono server on the laptop. Payload shapes are the zod schemas in `packages/schema`. Errors: JSON `{ "code", "text" }` with a 4xx/5xx status.

| Method | Path | Request | Response | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/login` | `{ user_id, pin }` | `{ token, role }` | Public. `401 invalid_credentials` otherwise. See Auth. |
| POST | `/api/sessions` | `{ fiche_number?, facility? }` | Session (`page_ids: []`, server-generated `id`) | Midwife only. |
| POST | `/api/pages` | multipart: `meta` (RecordPage JSON, `id` = UUID created on the phone) + `image` (original file) | `200` RecordPage | Midwife only; `meta.midwife_id` must be the caller and `meta.session_id` one of her sessions (`404 session_not_found`). Idempotent by page id: a replay returns the stored page (its current state) and changes nothing. The server recomputes the SHA-256 and rejects (`409 sha256_mismatch`) a mismatch with `meta.sha256`. The image is stored encrypted, untouched; `meta.state` is ignored: the page is `CAPTURED`, then `PENDING_AI` once queued. |
| GET | `/api/pages/:id` | none | RecordPage + `fields: ExtractedField[]` | Owner midwife or supervisor (`403`/`404` otherwise). `fields` is empty until the analysis ran. |
| GET | `/api/sessions/:id/analysis` | none | NDJSON stream of analysis events (`page_received`, `page_read`, `field_flagged`, `record_ready`) | One JSON object per line, parsed with `parseEvent`. Replays the stored events of the session, then follows live. The stream never closes by itself (a session can receive more pages): it ends when the client disconnects. A `{"type":"ping"}` line is sent after 10 s without events. A page that fails produces the shared `error` event (`code`, `text` = `page <id> failed`, `page_id`), e.g. `page_type_required` (the phone must send `page_type`; template matching comes later), `page_type_unsupported`, `model_unreachable`/`model_http`/`model_timeout`, `analysis_failed`; the page is then `PROCESSING_FAILED`. `record_ready` (`record_id` = session id) is sent when no page of the session is still waiting for the analysis. Flow: `PENDING_AI` -> `AI_PROCESSED` -> `NEEDS_REVIEW`. `field_flagged` is sent for each `NEEDS_REVIEW` or `ILLEGIBLE` field. |
| PATCH | `/api/pages/:id/fields/:fieldId` | `{ value, status? }` | updated ExtractedField | Midwife correction of her own page, while it is `NEEDS_REVIEW`/`MANUAL_REVIEW_REQUIRED` (`409 page_not_editable` otherwise); `value` is a string, boolean or null; `status` defaults to `KNOWN`; unknown field `404`. Audited (actor, role, old and new value+status, time). |
| POST | `/api/pages/:id/confirm` | none | RecordPage | Moves the page to `VALIDATED` if the lifecycle allows it (`409 illegal_transition` otherwise); `409 fields_need_review` with `field_ids` while a field is still `NEEDS_REVIEW`. Idempotent when already validated. |
| GET | `/api/patients/candidates?fiche=&facility=` | query | `Candidate[]` | **Step 11, not implemented.** Looked up by `(fiche_number, facility)`. No personal identifiers are ever returned. |
| POST | `/api/sessions/:id/link` | LinkDecision | `Patient` or `{ status: "not_sure" }` | **Step 11, not implemented.** `create_new` allocates the next `PAT-000001...` from a server counter. |
| POST | `/api/chat` | `{ session_id, message }` | NDJSON stream of chat events (`token`, `ping`, `done`, `error`) | **Step 8, not implemented.** `ping` keeps the connection alive during slow CPU inference. |
| GET | `/api/originals/:pageId` | none | original image bytes | Role-restricted: the `midwife` for her own patients' pages, the `supervisor` for all; every attempt (allowed or not, including unknown pages) is logged in `originals_access`; `403` when denied, `404` for an unknown page. `Content-Type` is sniffed from the bytes (PNG/JPEG). |
| GET | `/api/health` | none | `{ status: "ok", model: string \| null }` | Public on the local network. `model` is null when the analysis is off (`ANALYZER=off`). |

Conventions:

- Streams use `Content-Type: application/x-ndjson`, one event per line, no framing beyond the newline.
- Roles are `midwife` and `supervisor`. A midwife sees and modifies only her own sessions and pages; the supervisor sees everything and modifies nothing.

Auth (demo-grade, not for production: no token expiry, no rate limiting, no TLS):

- `POST /api/login` with `{ user_id, pin }` returns `{ token, role }`; the token is 32 random bytes (hex). Every other `/api/*` route except `/api/health` needs `Authorization: Bearer <token>` (`401 unauthorized` otherwise).
- Users are seeded on first start from `DATA_DIR/users.json` (`[{ "id", "role", "pin" }]`), else the demo set `sf-01`, `sf-02` (midwives) and `sup-01` (supervisor) with random 6-digit PINs printed once on the console. PINs are stored as scrypt hashes with a salt.
- Other errors: `403 forbidden`, `404 not_found`, `400 bad_request`/`invalid_meta`.
