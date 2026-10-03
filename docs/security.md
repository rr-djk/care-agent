# Security and privacy stance

Demo-grade auth and transport are described in `docs/api.md`. This page covers what the language model can and cannot do, and what is kept.

## Untrusted data and prompt injection

- Everything read from the page (the handwriting the model transcribes) and everything typed in the chat is **untrusted data**, never instructions. The registry may contain text such as "ignore the rules"; it is stored as a value like any other and flagged by the validators if it does not fit the field.
- **The image analyzer has no tools.** It is one model call per zone that returns `{"cells": [...]}` for cells listed by the server; it cannot read the database, call the API or change a status. The status of a cell is decided by deterministic code (ink, validators, applicability).
- **Every model output is validated** with zod (`parseZoneAnswer`, the chat tool arguments) and then normalized and validated by the field rules. A reading that does not parse is `UNKNOWN`, a value that fails a rule is `NEEDS_REVIEW`; nothing is accepted because the model said so.
- **Chat tools are record-scoped.** In the optional LLM chat engine (`CHAT_ENGINE=strands`) the tools (`get_pending_fields`, `apply_correction`, `confirm_field`, `request_retake`, `start_manual_entry`) are bound server-side to the page of the request. They take a `field_id` only; a `field_id` that is not on that page, a `page_id` other than the bound one, or any `session_id` is refused (`out_of_scope`) and changes nothing. The tools run the same code as the buttons (normalization, validators, audit). The deterministic engine, the default, never calls a model. The "Strands" flag is implemented as a minimal tool-calling loop on Ollama's OpenAI-compatible API (`/v1`, `reasoning_effort: "none"`), not with the Strands SDK.
- **No chat text is stored.** A chat message is interpreted and dropped; only the resulting field change is written, audited like a button press. Chat messages are not in the database, the events or the logs.
- **Logs carry no values**: method, path (ids) and status only; errors log the error name, not its message.
- The midwife sees only her own sessions; the supervisor is read-only. Originals are encrypted at rest and every access is logged (`docs/api.md`).

## PII guard (`apps/server/src/privacy.ts`)

The schemas hold no identifier field (name, husband, CIN, phone, address; enforced by a test). The guard covers identifiers that appear anyway in free text. `maskIdentifiers(text)` replaces each match by `[masqué]` and reports whether anything changed.

| Masked | Rule |
| --- | --- |
| Email | `local@domain.tld` |
| Moroccan phone | `0[5-7]` + 8 digits, or `+212` / `00212` (optional `(0)`) + `[5-7]` + 8 digits; spaces, dots and dashes allowed between digits |
| CIN-like | 1 or 2 letters + 5 to 7 digits, as one token (`AB123456`) |
| Street address | `rue`, `avenue`, `av.`, `bd`, `boulevard`, `lotissement`, `hay`, `derb` (whole word) and the up to 4 words or numbers that follow |

Never masked: clinical values (`120/80`, `12 SA`, `3587 g`, `152 cm`), dates, plain numbers (tests cover both directions).

Applied server-side to: every `short_text` / `free_text` value coming from the model, before it is stored (`vision/analyze.ts`); every `PATCH` value (the response says an identifier was masked); every chat message, before it is parsed or sent to a model.

Known limit: the model answer cache (`data/cache/`, local and git-ignored) keeps the raw model response, before the guard.
