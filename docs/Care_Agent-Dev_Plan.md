# Care Agent — Dev Plan

Oct 3, 2026 · @Eric M.

## Build progress (living section — updated as steps are validated)

The phases below describe *what* to build and *who* owns it. Construction is done in 14 ordered steps, one git branch per step (`feature/step-N-name`), merged into `main` only after validation. Conventional Commits in English.

Decisions taken since this plan was written: Vite + React for the PWA, Hono for the server, npm workspaces (pnpm is not installed), SQLite, Strands only for the conversation agent (template + regex fallback), datasets stay **outside** the repo (`DATASETS_DIR`, default `../datasets`, read-only).

| Step | Content | Status |
| --- | --- | --- |
| 1 | Scaffold, dataset hash guard, latency probe (GO/NO-GO for Gemma 4 E4B on CPU) | **Merged into `main`**: measured with Ollama 0.35.1 + `gemma4:e4b`: strict rule NO-GO (~40 s per zone at best), good reading quality with a row × visit schema. **Validated: GO with a compact output format** (native API, values only in a fixed order, asynchronous analysis) |
| 2 | Shared contracts (`packages/schema`), dedupe, 3-way patient split | **Validated, merged into `main`**: zod contracts (statuses, fields, compact zone answer, lifecycle, entities, NDJSON events), `docs/api.md` v0, 80 unique pages, split tune = patients 2, 3, 4, 8 · calibrate = 1, 5, 7 · verify = 6, 9, 10 (seed 20261003) |
| 3 | Ground truth from the PDF, minimal eval, automatic zones | **Merged into `main`**: ground truth for all 80 pages (6,020 slots, identifiers excluded), zones for pages 2/3/4 (6/13/4 zones, ≤ 24 cells each, previews in `docs/zones-p0*.png`), `make eval` harness (truth = 100 %, empty = 0 % on non-empty slots), labeling guide for the 5 real photos |
| 4 | Page schemas as data: pages 2, 3, 4 | **Merged into `main`**: `packages/schema/pages/{identification,pregnancy,delivery}.json` (77 / 280 / 34 fields), short zone prompts generated from them (50–121 words), compact answer parser, normalizers and validators (ranges, blood pressure, dates, cross-field rules); all 3,910 ground-truth values of pages 2–4 pass the validators |
| 5 | Vertical slice by CLI: crop → model → validated fields with statuses | **Merged into `main`**: `npm run analyze` reads a page end to end (masks, crops with row-label strip, ink detection, Gemma 4 on inked cells only, statuses). Page 19: 8/8 then 23/24 cells right, the wrong one flagged `NEEDS_REVIEW`. Ink detector on 80 pages: text recall ≥ 0.997, checkboxes 1.00. No per-token probabilities from Ollama. Baseline on the tune split (12 pages): 90.8 % of handwritten cells right (identification 92.9 %, pregnancy 89.3 %, delivery 100 %), 100 % of blank cells left blank; after the prompt fix for the null answers (merged, with `--save-crops` to inspect readings): **92.2 %** (identification 92.9 %, pregnancy 91.3 %, delivery 100 %), blank cells still 100 % |
| 6 | Server: API, SQLite, lifecycle, NDJSON, audit, original-image store | **Merged into `main`**: Hono API on SQLite (`make server`), PIN login with midwife/supervisor roles, idempotent upload with SHA-256 re-check, lifecycle persisted before each response, field edits audited, originals AES-256-GCM encrypted with every access logged, NDJSON analysis stream with replay; 25 server tests |
| 7 | PWA shell, chat UI, HTTPS camera | **Merged into `main`**: Vite + React PWA (`make pwa`), French WhatsApp-style chat, login, capture with page type, upload, live analysis with doubtful fields first, field correction and page confirmation; fixture mode. **Phone test over HTTPS pending** (needs mkcert on the laptop) |
| 8 | Review flow and conversation agent, PII guard | **Merged into `main`**: review queue with explicit French doubts, Confirmer / Corriger / Reprendre la photo / Laisser illisible, retake (`SUPERSEDED`), ink-only manual entry, deterministic chat parser (optional LLM tool loop behind `CHAT_ENGINE`), PII guard, `docs/security.md`. Live checks with Ollama pending |
| 9 | Offline: encrypted queue and sync | **Merged into `main`**: PIN-derived AES-GCM key (PBKDF2 310k, memory only), encrypted IndexedDB queue, offline unlock, single sync loop (idempotent session + page upload, sha256-confirmed, backoff, `SYNC_FAILED` + Réessayer), stream reconnect with event dedupe, simulation switch, device wipe; network-cut matrix in `docs/offline.md` |
| 10 | Quality gate (OpenCV.js) and page-quad warp | **Merged into `main`**: shared `packages/quality` (blur per inked tile, exposure, glare, page quad; OK / WARNING / REJECT, French messages), post-capture check in a Web Worker before the offline queue, live camera with A4 guide and auto-capture, `LOW_QUALITY` → fields to review, perspective warp before analysis on the server. Thresholds provisional (step 13). Numbers and findings: `docs/quality.md` |
| 11 | Cover page and patient linking | **Merged into `main`**: cover schema (21 fields, name line masked with no cell, `docs/zones-p01.png`; live read of page 17: 4/4 handwritten fields and both ticks right); linking engine (fiche + facility key, near matches, cross-checks with age/DDR/gravidity/parity/province, never auto-create or merge), `PAT-nnnnnn` counter, `GET /api/patients/candidates`, `POST /api/sessions/:id/link`, `GET /api/patients/:id`, duplicates list, re-digitization choices per field, SYNCED = phone acknowledgement (`/ack`); chat link question with the 4 buttons and a record view; 75 server + 52 PWA tests, scripted e2e on 3 sessions |
| 12 | Remaining pages, checkboxes, real form | **Merged into `main`**: `postpartum_mother` (pages 5 and 7, 53 fields, 7 zones) and `postpartum_newborn` (6 and 8, 44 fields, 5 zones), the mother's name header masked (`docs/zones-p05.png`, `zones-p06.png`); ink thresholds 0.01 text / 0.05 checkbox give precision and recall 1.00 on all 80 pages; `make eval --extractor truth` 100 % on the 6 layouts; live read of pages 13 (mother) and 14 (newborn): every checkbox and every handwritten value right, doubtful cells flagged. Real form: `real_cover` layout (21 fields, zones on the warped photo, `npm run analyze ... --layout real_cover`), hand labels of 1-1 and 1-4 (by the assistant, to be verified), live read of 1-1 shows the gap (checkbox ink false positives, fiche read `164125` for `A64125`); spreads 1-2..1-5 not templated |
| 13 | Degraded variants, tuning, calibration | **Tooling merged into `main`; full runs pending**: `make degrade` (graded variants + manifest, split inheritance enforced), `predict` with signals + gate metrics (`.jsonl`), `make calibrate` (per-category Wilson table stamped with `pipeline_hash`, demotion rule `low_category_confidence`, server loads/refuses/applies it), `make quality-curve`, `make report`, `make eval-full`; zone re-cut experiment at the section bands (tune page 27: 104/115 → 113/115 handwritten cells right, 4× slower) documented in `docs/scaling.md` and not kept (13 zones for processing time). Calibration table, quality thresholds and `docs/results.md` wait for the long runs (`docs/calibration.md`) |
| 14 | Docs, hardening, demo, fallback | Not started |

What exists today: see the README "How to test" (commands, expected outputs) and `AGENTS.md` (layout, invariants, gotchas). In short, `main` runs end to end on a laptop: capture in the PWA (offline queue included) → upload → crop + ink + Gemma 4 → statuses → conversational review → validated page.

Open items for the team:

- Phone test over HTTPS: step-by-step guide in README section 6 (mkcert, trusting the CA on Android/iPhone, firewall, checklist, troubleshooting). Owner: a teammate. Not done yet.
- Prompt fix (merged): the wording `null = illegible` made the model answer null on clearly written zones; with the new wording the tune split went from 90.8 % to 92.2 % of handwritten cells right. Remaining errors: glucosuria/albuminuria still empty on some pages (18 cells, flagged `NEEDS_REVIEW` by the ink check), "Normalux" for "Normaux" (handwriting font), and a few dropped digits caught by validators. Next lever (step 13): zones that do not include the dark section bands, per-category prompt tuning.
- CPU-only laptop (15 GB RAM, no GPU): ~20 s to read a crop, ~7 output tokens/s, a dense page takes several minutes; analysis is asynchronous by design. Gemma 4 E2B stays as a fallback.
- Questions for the organizers (defaults in the table at the end): server on a laptop vs everything on the phone, "N° de la fiche" as the linking code, test-set pages, Arabic/English pages.

## Overview

We build an offline-first, WhatsApp-style PWA that turns photos of a paper maternal registry into a structured, midwife-verified record with a status and confidence per field. The phone captures, checks and stores pages on its own; a laptop on the local Wi-Fi runs Gemma 4 E4B-it and everything else. No internet, no cloud, no paid services.

&#91;embedded content: architecture · phone client + laptop server\]

Stack: TypeScript everywhere · PWA with Vite + React or Svelte · Node + Hono or Express · Gemma 4 E4B-it on Ollama, llama.cpp or LM Studio · SQLite · IndexedDB + WebCrypto · OpenCV.js in a Web Worker · Strands SDK for the conversation agent · Python only for offline scripts.

Principles:

- The model never sees a whole page with a free prompt: rectify → match the template → crop zones → read them against a schema defined as data.
- Everything except reading crops is deterministic code: validators, statuses, linking, lifecycle.
- The midwife never sees a raw "87 %". She sees what is unsure and why; calibrated numbers live in the audit view.
- No identifier field exists anywhere (woman's name, husband's name, CIN, phone, address). Originals are hashed, encrypted, role-restricted and never modified.
- Out of scope: risk prediction, triage, clinical decision support.

| Criterion | Points | Where we win it |
| --- | --- | --- |
| Extraction quality | 30 | Template crops, schema as data, eval on ground truth |
| Uncertainty handling | 20 | Six statuses, per-category calibration, validators override scores |
| Conversational review | 20 | Deterministic state machine + templated messages |
| Offline robustness | 15 | Encrypted queue, idempotent sync, tested with the network cut |
| Linking and privacy | 10 | Fiche-number linking, four-button decision, no identifiers stored |
| Code and docs | 5 | README, reproducible scripts |

## Team split

Four workstreams that can run in parallel from Phase 0, joined by shared contracts frozen on day 0. Swap owners to fit skills.

| Workstream | Owner | Phases |
| --- | --- | --- |
| Laptop server: model runtime, image-analysis agent, validators, lifecycle, sync API | Member 1 | 0, 1, 2, 4 |
| Schemas, ground truth, degraded variants, evaluation, calibration | Member 2 | 1, 4, 5 |
| PWA: capture, OpenCV.js quality gate, encrypted offline queue, sync client | Member 3 | 0, 2, 3 |
| Chat UI, conversation flow, linking UI, README and demo | Member 4 | 1, 2, 3, 6 |

Shared contracts (in `packages/schema`, merged in Phase 0): field definition, extracted field, the six statuses, NDJSON event types, lifecycle state names. Until a piece lands, everyone builds against fixtures: the chat UI starts from a hard-coded extracted page, the server from a saved crop.

## Phase 0 · Setup and smoke tests

Done when: one page-3 crop is read by the model with timings, the camera opens from the real phone, and the contracts are merged.

1. **Repo** (Member 1): `apps/pwa`, `apps/server`, `packages/schema`, `tools/eval`, `docs`. Make `datasets/` read-only and add a check that compares file hashes with `datasets/manifest.json`.
2. **Model runtime** (Member 1): pull Gemma 4 E4B-it on the laptop (Ollama, llama.cpp server or LM Studio). Verify four things and write the answers down:
   - the exact model tag;
   - image input works;
   - output can be constrained to a JSON schema;
   - per-token probabilities are returned. If the first runtime fails on the last two, try llama.cpp's server, which can return token probabilities and constrain output with a grammar.
3. **Smoke test** (Member 1): one crop of specimen page 3, image before text, thinking off. Record latency and memory at visual token budgets 560 and 1120.
4. **HTTPS camera** (Member 3): `mkcert` root certificate installed on the phone, PWA served on the laptop's LAN address, camera opens. Fallback: laptop webcam.
5. **Dedupe** (Member 2): SHA-256 over the 124 PNGs → the list of 80 unique pages.
6. **Contracts** (all): freeze the shared types.

```ts
type Status = 'KNOWN' | 'UNKNOWN' | 'NOT_PROVIDED' | 'ILLEGIBLE' | 'NOT_APPLICABLE' | 'NEEDS_REVIEW';
type FieldType = 'checkbox' | 'date' | 'number' | 'short_text' | 'enum' | 'free_text';

interface FieldDef {
  id: string; label_fr: string; label_en: string;
  type: FieldType; category: string;      // calibration category (Phase 5)
  unit?: string; allowed_values?: string[];
  applicability?: string;                  // rule that makes it NOT_APPLICABLE
  validators: string[];
  zone: string;                            // template crop it is read from
}

interface ExtractedField {
  value: string | boolean | null;
  status: Status;
  confidence_signals: { tokenProb?: number; agreement?: boolean; validatorsPassed: boolean; quality: number };
  calibrated?: number;                     // filled after Phase 5
  source_page: number;
  evidence?: string;                       // crop id shown in review
}
```

## Phase 1 · Vertical slice

Done when: one specimen page goes upload → analysis → fields with statuses in the chat.

1. **Schemas** (Member 2): `p02_identification`, `p03_pregnancy`, `p04_delivery` as JSON, validated with zod. From them, generate the validators, the model instructions, the review form and the ground-truth mapping. No identifier fields at all.
2. **Templates** (Member 2): on the clean 1654×2339 render of each page type, record every zone as fractions of page width and height. Page 3's 9-column visit table is cut by row or column group, never read whole.
3. **Rectify and crop** (Member 1): ORB features + homography to the template, then crop zones with a little padding. OpenCV.js also runs in Node, so the server can share the phone's image code.
4. **Image-analysis agent** (Member 1): one call per zone, no tools. The prompt is generated from the schema; ask for the verbatim text first, then the normalized value; constrain enums to their allowed values; validate with zod and retry once.
5. **Normalize and validate** (Member 1): dates, decimal commas, units; range and cross-field rules. A failed rule forces `NEEDS_REVIEW`.
6. **Stream** (Member 1 → Member 4): NDJSON events `page_received`, `page_read`, `field_flagged`, `record_ready`. Never stream half-parsed JSON.
7. **Chat** (Member 4): page summary with flagged fields first; Confirm / Edit / Retake buttons shown, wired in Phase 2.

Example zone prompt (generated from the schema, image placed before it):

```text
You read one zone of a Moroccan maternal registry page.
Fields: weight_v1 (number, kg), bp_v1 (text, systolic/diastolic), exam_v1 (short text).
For each field return {"verbatim": exactly what is written, "value": normalized or null, "legible": true|false}.
Ignore names, phone numbers, ID numbers and addresses. Never guess a value.
```

## Phase 2 · Review flow, lifecycle and offline

Done when: the demo path works with the network cut midway, and no record is ever lost.

Lifecycle: `CAPTURED → PENDING_AI → AI_PROCESSED → NEEDS_REVIEW → VALIDATED → PATIENT_MATCHED → REGISTERED → SYNCED`, plus `PROCESSING_FAILED`, `SYNC_FAILED`, `DUPLICATE_SUSPECTED`, `MANUAL_REVIEW_REQUIRED` and the `LOW_QUALITY` flag.

1. **State machine** (Member 1): a transition table in code with tests. Persist every transition before acknowledging it.
2. **Capture on the phone** (Member 3): a UUID record ID and a SHA-256 of the original at capture; the original stays untouched at full resolution.
3. **Encrypted store** (Member 3): IndexedDB, AES-GCM, key from the PIN via PBKDF2, non-extractable `CryptoKey`, wiped on logout. Queued pages show as "Pending AI processing" and the midwife keeps working.
4. **Sync** (Member 3 + Member 1): upload keyed by record ID, so a replay changes nothing; the server re-checks the SHA-256. Failed uploads go to `SYNC_FAILED` and retry.
5. **Review** (Member 4): per field Confirm / Edit / Retake; a follow-up question for `ILLEGIBLE`; full manual entry when the AI is unavailable. The agent says what it doubts ("I read 12/04 but the year is unclear") and never presents a guess as certain.
6. **Conversation agent** (Member 4): buttons and fixed templates first. The agent only phrases messages and parses short free-text corrections, through record-scoped tools (`get_pending_fields`, `apply_correction`, `confirm_page`, `request_retake`, `link_decision`, `start_manual_entry`). If small-model tool calling is unstable, fall back to templates + regex.
7. **Audit log** (Member 1): every change with role, old value, new value and time; no staff names.
8. **Offline test** (all): cut connectivity at each lifecycle step and check nothing is lost or duplicated.

## Phase 3 · Quality gate and patient linking

Done when: a blurry or wrong photo is caught on the phone, and a match decision can be demoed.

**Quality gate (Member 3, OpenCV.js in a Web Worker, cached by the service worker)**

1. v1: `<input type=file capture>` + a check on the captured image:
   - blur: Laplacian variance per tile, only on tiles with ink; x/y gradient ratio for motion blur;
   - exposure: luminance histogram, share of clipped (>250) and black (<15) pixels, p5–p95 spread;
   - glare: large saturated blobs, weighted by whether they sit on text;
   - framing: pink page found, four corners in frame, skew, resolution.
2. Three outcomes, never a hard block: OK · Warning ("keep anyway" → `LOW_QUALITY` → `NEEDS_REVIEW`) · Reject (black photo, no paper).
3. Page type by ORB template matching against the 6 layouts and the real form; flags a wrong or duplicate page.
4. v2: live camera with an A4 guide frame, analysis at 3–5 fps on downscaled frames, frame turns green, auto-capture after about 0.5 s of stability, full resolution via `ImageCapture.takePhoto` where available.

Thresholds come from the quality curve in Phase 5, not from guesses.

**Patient linking (Member 1 server, Member 4 UI)**

5. Read the fiche number + facility from the cover. Pages 2–8 inherit the session's fiche number (from the cover or typed by the midwife).
6. Look up `(fiche_number, facility)`:
   - one consistent match → attach, ask only if confidence is low or a check fails;
   - no plausible candidate → create `PAT-000001…` from a server counter;
   - doubt → \[Patient 1\] \[Patient 2\] \[None, create new\] \[I'm not sure\]; "I'm not sure" parks it in `DUPLICATE_SUSPECTED`.
7. Low-confidence fiche read → "I read 2026-823-001 — is this correct?", cross-checked with facility, age and LMP.
8. Never auto-merge. Reviews that arrive after sync go to a "to review" queue.
9. Re-digitization: show the existing record and let the midwife choose, field by field, what to update. Demo it with later visit columns blanked on page 3.

## Phase 4 · Remaining pages

Done when: all 8 pages of a specimen file extract. Only three more schemas are needed, because pages 5/7 and 6/8 share a layout.

1. **Schemas** (Member 2): `p01_cover`, `p05_postpartum_mother` (also page 7), `p06_postpartum_newborn` (also page 8). Add applicability rules, e.g. cesarean indication is `NOT_APPLICABLE` when delivery was vaginal.
2. **Templates** (Member 2): zones for each new layout, plus a template for the real form from `1-1.jpg` and `1-4.jpg`.
3. **Checkboxes** (Member 1): tri-state (checked / unchecked / unclear). Compare VLM reading against OpenCV ink density in the box on the specimens; keep the better one per field. Decide per field whether blank means `NOT_PROVIDED` or "no".
4. **Re-run the eval** (Member 2) so the new pages appear in the accuracy report.

## Phase 5 · Calibration and evaluation with the 80 pages

The 80 pages are for tuning and measuring the pipeline, not for retraining the model. Build the eval harness early (Member 2 starts it during Phase 2) and run it after every prompt, crop or model change.

1. **Ground truth**: `pdftotext` on the specimen PDF → normalize the noise (spaces inside tokens, dropped accents: "N ant" vs "Néant") → map to schema fields. Checkboxes from the PDF's vector drawings or a quick labeling pass. Hand-label the 5 real JPGs.
2. **Split by patient, after dedupe**: 7 patients to tune and calibrate, 3 to verify. Degraded variants stay in the group of their source page. The 5 JPGs are never used for tuning, only to measure the clean-to-real gap.
3. **Degraded variants**: a script applies blur, motion blur, low light, shadow gradient, glare, skew, JPEG compression and resolution loss at graded levels. Originals untouched.
4. **Tune on the 7 patients only**: prompt wording per category, visual token budget (560 vs 1120), crop padding, how the second reading differs, and 1–2 example crops in the prompt for the hardest categories if it measurably helps.
5. **Calibrate per category** (checkbox, dates, vital numbers, administrative numbers, short text, lab results, free text): at most 3 bins, at least 30 examples per bin, Wilson intervals. Final confidence = calibrated value × image-quality factor. Store `pipeline_hash` with the table and refuse a table whose hash doesn't match.
6. **Quality curve**: measured quality → accuracy across degradation levels. It sets the Warning and Reject thresholds in Phase 3 and goes in the README.
7. **Report on the 3 verify patients + the JPGs**: field exact match after normalization, status accuracy, per-category accuracy and calibration, coverage vs accuracy (how many fields auto-accepted at which error rate), latency and memory per page. One command (`make eval`), timestamped JSON results.

Fine-tuning stays a stretch for one member at most: a LoRA on the 7 tuning patients' crops, kept only if it beats the tuned baseline on the verify set. Seven patients is little data, so ask the organizers first whether it's expected.

## Phase 6 · Docs and demo

Done when: a fresh clone runs by following the README, and the demo works twice in a row.

1. **README** (Member 4, with input from all): setup from a fresh clone, design choices, lifecycle diagram, calibration protocol and numbers, quality curve, known limitations, and a note that LMP, age and facility are quasi-identifiers kept in the protected database.
2. **Results slide** (Member 2): accuracy and calibration on the verify set, clean vs real-photo gap.
3. **Demo script** (all): capture pages with the phone in airplane mode → "Pending AI processing" → reconnect → analysis progress → review a field the agent flags as unsure → resolve a possible-match question → record reaches `SYNCED`.
4. **Fallback** (Member 4): a pre-recorded video of the full demo.

## Order of work, cut list and risks

The vertical slice is the gate: until one page goes photo → analysis → chat, nobody starts new features.

&#91;embedded content: order of work · by member and phase\]

Cut in this order if time runs out: dashboard → bilingual UI → live guide frame (keep the post-capture check) → page-type template matching (keep manual page choice) → cover page schema → pages 5–8.

Never cut: schema + statuses, validators, review flow, offline queue + lifecycle, no identifiers stored, original image protection, README.

| Risk | Mitigation |
| --- | --- |
| E4B reads handwriting poorly | Template crops, high visual token budget, validators, double reading, honest README |
| Calibration holds on clean specimens, fails on real photos | JPGs kept out of calibration, gap reported, quality factor, wide bins with Wilson intervals |
| Leakage in evaluation | Dedupe by hash, split by patient, variants grouped with their source |
| Camera blocked without HTTPS | `mkcert` tested in Phase 0; webcam fallback |
| Small-model tool calling or JSON unreliable | zod validation + one retry; templated conversation fallback |
| Wrong patient linked from a misread fiche number | Confirm low-confidence reads; cross-check facility, age, LMP; never auto-merge |
| Real form differs from the specimen layout | Template for the real form from `1-1` and `1-4`; schema-driven extraction |
| Slow on the demo laptop | Measure in Phase 0; sequential queue; cache results by image hash |

## Open questions for the organizers

Work proceeds on the default until answered.

| Question | Default until answered |
| --- | --- |
| Is a laptop server on local Wi-Fi allowed, or must everything run on the phone? | Laptop server |
| Is the "N° de la fiche" the linking code? | Yes, read as a normal cover field |
| Original image holds identifiers: store it intact, encrypted, role-restricted? | Yes, never extract identifiers from it |
| Which pages and values form the test set's ground truth? | Our own PDF-derived ground truth |
| Will Arabic or English pages be tested? | French only until told otherwise |
| Is fine-tuning expected or scored? | No; tuning + calibration only |
| Access rules for midwives | Own patients + a supervisor role |
| UI language | French first, English toggle if time allows |

Technical unknowns to settle in Phase 0: runtime log-probs and JSON-schema output; checkboxes read by the VLM or by ink density; laptop and phone hardware for the demo.

## Sources

- Team PLAN.md (v0.1), the basis for this plan
- [google/gemma-4-E4B model card (Hugging Face)](https://huggingface.co/google/gemma-4-E4B)
- [onnx-community/gemma-4-E2B-it-ONNX model card](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX): visual token budgets, modality order, thinking control
- [Gemma 4 on LM Studio](https://lmstudio.ai/models/gemma-4)
