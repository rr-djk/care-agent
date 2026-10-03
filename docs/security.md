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

## Identifiers and patient linking (step 11)

**What is stored about a woman.** A patient is `patients(id, fiche_number, facility, created_at)`: a generated id, the « N° de la fiche » and the facility. Neither is a direct identifier (a fiche number is a registry sequence like `2026-711-003`; the facility is a place of care). No column anywhere holds a woman's name, her husband's name or job, a CIN, a phone number or an address. A test lists the columns of every table (words `name`, `nom`, `husband`, `cin`, `phone`, `tel`, `address`…) and scans the stored text with the PII guard; the schema test already forbids such a field in the page schemas.

**The cover page.** `packages/schema/pages/cover.json` has the fiche number (category `admin_number`), region, province, facility name, the facility type checkboxes (DR, CSC, CSU, CSCA, CSUA), coverage (fixe, mobile) and the risk checkboxes. The woman's name line (« Nom/Prénom de la parturiente ») has **no field and no cell**; its rectangle is in `masks` and is painted black before any crop is cut, so the name is never sent to the model, never shown in `docs/zones-p01.png` and never written. It stays in the original photo, which is stored encrypted (see above).

**Internal ids.** `PAT-000001`, `PAT-000002`… come from a server counter (`counters` table), allocated in the same transaction as the `patients` row and only after the midwife's decision. They are never computed from the fiche number, the facility, a date or any other value, so an id reveals nothing and cannot be rebuilt from the data.

**Linking never decides.** The engine (`apps/server/src/linking.ts`) proposes candidates and a question; the midwife answers. There is no automatic creation and no automatic merge: even a single exact match asks one question; several, near or contradicting candidates give the four buttons [Patient 1] [Patient 2] [Aucune, créer] [Je ne sais pas]; « Je ne sais pas » parks the pages in `DUPLICATE_SUSPECTED` and creates nothing. A doubtful fiche reading (letters O/I read for 0/1, a shape other than `2026-823-001`) is confirmed with the midwife first (« J'ai lu 2O26-823-OO1, est-ce correct ? »). Candidate cards show only non-identifying facts: fiche, facility, age, DDR, number of visits, date of the last visit, and the French reasons (« Âge différent : … »).

**Who sees what.** A midwife reads `GET /api/patients/:id` only for a patient she has linked a session to (`403` otherwise); the supervisor reads all and modifies nothing, including the duplicates list. The candidate cards of other midwives' patients are visible while linking (needed to catch a duplicate across midwives) but contain no identifier, and the record behind them stays closed until she links.

**Typed values.** The fiche number and facility a midwife types go through the PII guard; a value that looks like an identifier is refused (`400`), not stored masked.

**Re-digitization.** A later photo of a page type already in the record never overwrites silently: where the retained value would change, the midwife chooses per field (« Garder l'ancien » / « Prendre le nouveau »); both photos and both sets of fields stay stored and the record shows which page each retained value comes from.

Known limits: the specimen cover shows a printed « Patiente fictive n°3/10 » mark; it is not read (no cell). The candidate search compares all patients in memory, which is fine for a demo registry only.
