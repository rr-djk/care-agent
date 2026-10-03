# Offline-first: encrypted queue and sync (step 9)

A midwife can capture pages with no connection. Each page is encrypted on the phone, queued, and sent when the laptop is reachable. Nothing is dropped automatically.

## Device crypto (`apps/pwa/src/offline/crypto.ts`, WebCrypto only)

- **Key**: at an ONLINE login, PBKDF2-SHA256 (310 000 iterations, random 16-byte salt kept per user on the device) turns the PIN into an AES-GCM 256 `CryptoKey`, **non-extractable** and kept **in memory only**. The key (and the PIN) are never written anywhere.
- **Records**: every body is sealed with AES-GCM, a fresh random 12-byte IV per record (stored in front of the ciphertext), and the record id as additional data (a record cannot be swapped for another). In clear, only: ids, the owner id, an order number and the queue state (`CAPTURED` / `UPLOADED` / `SYNC_FAILED`). Page meta, session details, image bytes, MIME type, sha256, error codes: all encrypted.
- **Profile** (per user, in the `profiles` store): salt, an encrypted canary and the encrypted bearer token. Offline unlock = derive the key from the typed PIN and decrypt the canary; a wrong PIN fails to decrypt, nothing opens. After 4 wrong PINs, every further failure locks the unlock for a growing delay (30 s, 1 min, 2 min... capped at 1 h); the counter is stored, so reloading does not reset it.
- **Reload**: the token is no longer mirrored in `sessionStorage`. After any reload the device asks for the PIN (online or not), because the key only lived in memory.
- **Logout** forgets the key and deletes the stored token (queued pages stay, encrypted; logging in again online with the same PIN reopens them). A PIN the device does not know never replaces a key that still guards queued pages (`device_pin_mismatch`).
- **« Effacer les données de l'appareil »** (header bar and unlock screen) deletes the whole IndexedDB database after a confirmation that counts the unsent pages.
- Limits: demo-grade like the rest of the auth. A 6-digit PIN is guessable offline by anyone who copies the database (the iteration count only slows that down); the key is not hardware-backed; the service worker and app code are not encrypted.

## Quality check before queueing (step 10)

The on-device quality gate (`docs/quality.md`) runs before `addPage`, entirely on the phone (OpenCV.js is precached by the service worker), so it works with no connection. The verdict (`meta.quality`, and `LOW_QUALITY` in `meta.flags` after « Garder quand même ») is part of the page meta, sealed like the rest and uploaded with the page. The original bytes are still never re-encoded.

## Store (`store.ts`)

Object stores `profiles`, `sessions`, `pages` (meta), `blobs` (image bytes). At capture: `crypto.randomUUID()` page id, SHA-256 of the **original** bytes (never re-encoded), state `CAPTURED`, attempts 0. Sessions are created on the phone with a client UUID (`POST /api/sessions` accepts it and is idempotent, `docs/api.md`).

## Sync (`sync.ts`)

One loop (`kick()` while running = ask for another pass). Triggers: `online`, tab visible, connectivity change (simulation switch, probe), a 30 s timer, after each capture, « Réessayer ». For each `CAPTURED` page, in capture order: create its session if needed (idempotent), upload the page (multipart, idempotent by page id). **Only a 200 whose sha256 equals the local one** marks the page `UPLOADED` and deletes its blob (same transaction); the meta stays with the server state until the page is confirmed (`VALIDATED`, then deleted).

| Failure | Result |
| --- | --- |
| network error, 30 s timeout, abort, 5xx (also the dev proxy answering 502 when the server is down) | stays `CAPTURED`, `attempts + 1`, backoff 1 s, 2 s, 4 s... cap 60 s with jitter (half to full delay); the pass stops (order kept) |
| 401 | queue paused, the app returns to the login; nothing marked failed |
| 409 `sha256_mismatch` or another 4xx | `SYNC_FAILED` + the code (French text in the queue strip) + « Réessayer »; the bytes stay; the next pages go on |
| answer 200 with another sha256 | treated as `sha256_mismatch` |

Connectivity: `navigator.onLine`, the « Mode hors ligne (simulation) » switch (header bar: no network call at all while on), any failed fetch (`reachable = false`) and a `/api/health` probe before the next pass. Header badge: `Hors ligne` / `Synchronisation (n)` / `En ligne`.

**Analysis stream**: the `follow` loop reopens `/api/sessions/:id/analysis` after a drop (backoff 1 s to 15 s, woken by connectivity changes and by an upload, idle watchdog 30 s since the server pings every 10 s). The server replays the stored events; the reducer dedupes them by identity (`page_id + type`, plus field id / error code; `record_ready` also by the number of settled pages), so a replay creates no second bubble.

## Queue labels

« Enregistrée sur l'appareil (chiffrée) » (just captured, online) · « En attente de traitement IA » (offline or after a failed attempt) · « Envoi en cours… » · « Envoyée — analyse en cours » · « Échec d'envoi : … » + **Réessayer**. After the analysis the usual page labels take over.

## Network-cut matrix

Automated unit tests (`apps/pwa/src/offline/*.test.ts`, fake server behind a fake `fetch`, `fake-indexeddb`) and a browser run: real server (`ANALYZER=ink`, temp `DATA_DIR`), `vite build` + `vite preview` (service worker needed to reload offline), Chromium via playwright-core, `context.setOffline`, server killed with SIGKILL. Counts are read from the server SQLite DB and the originals folder.

| Scenario | Expected | Observed |
| --- | --- | --- |
| Login online | chat opens, badge En ligne, vault enrolled | ok |
| Reload online | PIN asked again (nothing readable at rest), chat back | ok |
| Capture 2 pages with `setOffline(true)` | 2 pages « En attente de traitement IA », badge Hors ligne, nothing on the server | 2 waiting; server sessions 0, pages 0, originals 0 |
| Reload while offline, wrong PIN, then right PIN | wrong PIN refused; queue still there | « Code PIN incorrect. »; session and 2 pages restored, still waiting |
| `setOffline(false)` | both pages uploaded in order, ink-mode analysis arrives (manual items) | sessions 1, pages 2, originals 2; 2 « Page reçue » bubbles |
| Server killed while a page upload is in flight | page stays queued, badge Hors ligne, no loss | page « En attente de traitement IA »; server pages 2 |
| Server restarted | page uploaded once, stream reconnects, replay adds no duplicate bubble | sessions 1, pages 3, originals 3; 3 « Page reçue » bubbles |
| Simulation switch on, capture a page | zero `/api` request while on, page queued | 0 requests, queued |
| Simulation switch off | queued page uploaded | pages 4, originals 4 |
| Unit (a): network cut before the session exists | stays CAPTURED, attempts 1; later session + page created | pass |
| Unit (b): request aborted during the upload | stays CAPTURED; retry gives exactly one page | pass |
| Unit (c): server stored the page, answer lost, replay | exactly one page server-side, local item resolves to UPLOADED, blob deleted | pass |
| Unit: 409 sha mismatch, Réessayer | SYNC_FAILED kept with its bytes, requeued by Réessayer, then uploaded | pass |

Not covered: the exact moment « server stored the page, process killed before the answer » in the browser run (the kill happens as the request leaves; case (c) covers the replay in unit tests); review actions (corrections, confirmations) made offline are not queued, they need the server.
