# care-agent

Offline-first PWA that turns photos of a paper maternal registry into a structured, midwife-verified record.
A phone captures and checks pages; a laptop on the local Wi-Fi runs a local Gemma 4 E4B-it and a Hono/TypeScript server.
No internet, no cloud.

## Layout

- `apps/pwa` - Vite + React PWA: login, WhatsApp-style chat in French, photo capture with a live A4 guide and a quality check, live analysis, field correction
- `apps/server` - Hono API (SQLite, lifecycle, encrypted originals, NDJSON analysis stream) and image analysis: crop, ink detection, Gemma 4 calls, field statuses (`analyze`, `predict`, `ink-eval` commands)
- `packages/quality` - on-device image quality gate and page-quad warp (OpenCV.js), shared by the PWA worker and the server
- `packages/schema` - shared zod contracts, page schemas (`pages/*.json`), zone prompts, normalizers and validators
- `tools/eval` - ground truth from the specimen PDF, crop zones, evaluation harness
- `tools/check-datasets.mjs` - dataset integrity guard; `tools/smoke/` - latency probe
- `docs/` - plan, build progress, runtime notes, API contract, zone previews

Plan and build progress: [docs/Care_Agent-Dev_Plan.md](docs/Care_Agent-Dev_Plan.md). Agent and contributor notes: [AGENTS.md](AGENTS.md).

## How to test

What works today: reading registry pages with the local model (command line, section 3), and the app itself: server + PWA in the browser (section 5) or on a phone (section 6). The chat then walks the doubtful fields one by one (Confirmer / Corriger / Reprendre la photo / Laisser illisible, or type the value), and offers manual entry when the model is unavailable. Offline capture with an encrypted queue works too (section 7), and every photo goes through an on-device quality check (section 8). Patient linking works too (section 9): the cover page gives the fiche number, the bot asks which patient record the session belongs to, and a longitudinal record shows the visits. Not yet: pages 5 to 8.

### 1. Prerequisites

- Node.js 20 and npm.
- Python 3.12 with `PyMuPDF`, `numpy`, `opencv-python` and `Pillow` (`pip install pymupdf numpy opencv-python pillow`, in a venv if your system refuses global installs). Needed by `make test` and to regenerate ground truth.
- `pdftotext` (package `poppler-utils`), used by `make pages`.
- The challenge data, laid out like this (the repo never modifies it):

  ```
  DayOne/
    consignes-fr-en.pdf          # the guard also checks this file
    datasets/                    # manifest.json + data/Paper Registry/...
    care-agent/                  # this repo
  ```

  Elsewhere? Set `DATASETS_DIR=/path/to/datasets`.
- For the model: [Ollama](https://ollama.com) and the model tag `gemma4:e4b` (`ollama pull gemma4:e4b`, ~6.6 GB). Ollama must be running (`curl localhost:11434/api/version`).

### 2. Install and check (no model needed)

```
npm ci
make check
```

`make check` runs the dataset guard, the typecheck of the four packages and every test suite. Success looks like this (excerpt):

```
entries: 132, ok: 132, mismatches/missing: 0          <- every data file matches manifest.json
info: 88 entries share an identical sha256 with another entry   <- normal: duplicate PNGs in the dataset
# pass 38 / # fail 0                                  <- schema tests
# pass 7 / # fail 0                                   <- quality tests (OpenCV.js, ~10 s)
# pass 75 / # fail 0                                  <- server tests (incl. linking)
      Tests  52 passed (52)                           <- PWA tests
# pass 14 / # fail 0                                  <- eval tools tests
Ran 9 tests ... OK                                    <- Python tests
```

Look at: `mismatches/missing: 0` and every `fail 0`. Failure modes: `MISSING ...` lines mean the data is not where expected (check the layout above or `DATASETS_DIR`); `SHA256 ...` means a data file was modified; `cannot check datasets in ...` means the folder was not found.

```
make eval ARGS='--extractor truth'
```

Feeds the ground truth to the harness as if it were the model, to prove the harness itself is right:

```
layout             non-empty         empty           all
cover               68 100.0%    142 100.0%    210 100.0%
identification    354 100.0%    416 100.0%    770 100.0%
pregnancy        1181 100.0%   1619 100.0%   2800 100.0%
delivery          116 100.0%    224 100.0%    340 100.0%
overall          1719 100.0%   2401 100.0%   4120 100.0%
```

Every cell must be `100.0%`. `non-empty` = cells with handwriting, `empty` = cells left blank on paper. The JSON report goes to `eval-results/` (git-ignored).

### 3. Read one zone with the model (~40 s on a CPU laptop)

Needs Ollama running with `gemma4:e4b`.

```
npm run analyze -w @care-agent/server -- 19 --zones p03.visits.r1c1
```

Page 19 is patient 3's pregnancy page; `p03.visits.r1c1` is the top-left block of the visit table (rows Rendez-vous to État des conjonctives, 1st-trimester visits; see `docs/zones-p03.png`). Output (excerpt):

```
zone               field                              verbatim       status         ink
p03.visits.r1c1    p03.rendez_vous.v1_t1              "03/07/2025"   KNOWN          0.0200
p03.visits.r1c1    p03.rendez_vous.v2_t1              ""             NOT_PROVIDED   0.0000
...
p03.visits.r1c1    p03.poids_kg.v1_t1                 "51,6"         KNOWN          0.0213
  -> p03.visits.r1c1: prefill 17.4 s (342 tok), gen 5.0 s (66 tok), wall 23.0 s
```

How to read it:
- `verbatim` = what the model wrote, exactly; `""` = empty cell, `null` = the model says it cannot read it.
- `status`: `KNOWN` accepted, `NEEDS_REVIEW` the midwife must check (value rejected by a validator, or ink seen but nothing read), `NOT_PROVIDED` empty on paper, `ILLEGIBLE`, `UNKNOWN` (zone not read).
- `ink` = share of ink pixels in the cell: `0.0000` means empty paper, so the model is not even asked.
- `prefill` = time to read the image, `gen` = time to write the answer, `wall` = total.

Success: the 8 visit-1 values `03/07/2025`, `05/06/2025`, `Non`, `8 SA`, `51,6`, `104/78`, `RAS`, `Normales` are `KNOWN` on the `v1_t1` rows, and the 16 other cells are `""` / `NOT_PROVIDED`. Run it again: the zone line ends with `[cache hit]` and `wall 0.0 s` (answers are cached in `data/cache/`, git-ignored). The key safety rule: a wrong value must never be `KNOWN` silently; e.g. on zone `p03.visits.r1c2` the model may read `8 17 SA` for `17 SA`, which must come out `NEEDS_REVIEW`.

Check a reading yourself (what the model saw, what it was asked, what it answered):

```
npm run analyze -w @care-agent/server -- 19 --zones p03.visits.r1c1 --save-crops p19
```

It first prints the folder, `crops, prompts and answers -> .../care-agent/data/crops/p19` (relative names always land in the git-ignored `data/crops/`). For each zone sent to the model it writes `<zone>.png` (the exact image: identifiers blacked out, row labels added on the left), `<zone>.prompt.txt` (the cells asked, numbered) and `<zone>.answer.json` (the raw answer, one value per numbered cell, in order). Open the PNG next to the answer: value n of the answer must be what is written in cell n of the prompt. The true value of any field is in `tools/eval/data/ground_truth.json` (page number, then field id).

Other useful runs:

```
npm run analyze -w @care-agent/server -- 19          # whole page: 13 zones, ~8 minutes on CPU; totals on the last line
npm run analyze -w @care-agent/server -- 20          # delivery page: checkboxes come from ink (no model), only text is asked
npm run ink-eval -w @care-agent/server               # ink detector vs ground truth on 80 pages, no model, ~1 min
```

`ink-eval` prints precision/recall per layout and threshold; at the thresholds used (text 0.002, delivery and cover text 0.01, checkbox 0.05) expect `precision=1.000` and `recall` ≥ `0.997`.

**The cover page (page type 1)** is read the same way. Page 17 is patient 3's cover (tune split); the zone preview with the woman's name painted black is `docs/zones-p01.png`:

```
npm run analyze -w @care-agent/server -- 17
```

Output (excerpt, ~40 s: only the `p01.identity` zone has handwriting, the two other zones are checkboxes read from the ink):

```
p01.identity       p01.n_deg_de_la_fiche                        "2026-711-003"         KNOWN          0.0531
p01.identity       p01.region                                   "Marrakech-Safi"       KNOWN          0.0715
p01.identity       p01.province                                 "Al Haouz"             KNOWN          0.0505
p01.identity       p01.nom_de_l_etablissement_sanitaire         "DR Tahannaout Sud"    KNOWN          0.0595
  -> p01.identity: prefill 30.2 s (306 tok), gen 7.9 s (44 tok), wall 38.3 s
p01.facility       p01.dr   ... ink 0.5619   (ticked)      p01.mobile ... ink 0.4694   (ticked); the other boxes 0.0000
```

Success: the four values equal the truth (`tools/eval/data/ground_truth.json`, page `17`: `2026-711-003`, `Marrakech-Safi`, `Al Haouz`, `DR Tahannaout Sud`), `DR` and `Mobile` have ink above 0.05 (ticked) and every other box 0.0000. The woman's name is never read: the cover schema has no field for it and its rectangle is blacked out before any crop is cut (check with `--save-crops cover17`: `data/crops/cover17/p01.identity.png` shows the four fields and no name).

### 4. Measure accuracy on a split (long: plan tens of minutes)

```
make predict ARGS='--split tune --pages p3 --limit 1'
```

Runs the full pipeline on the first pregnancy page of the `tune` patients and prints one line per page (`page 11 (pregnancy): 280 cells`), then `wrote .../eval-results/predictions-<time>.json`. Score it with that file name:

```
make eval ARGS='--extractor eval-results/predictions-<time>.json --split tune --pages p3'
```

Same table as in section 2, now with real percentages. Look at `non-empty` (handwritten cells read correctly) and `empty` (blank cells correctly left empty, expected 100 %). Reference on the 12 `tune` pages (pages 2, 3, 4 of patients 2, 3, 4, 8), current prompt: non-empty **92.2 %** (identification 92.9 %, pregnancy 91.3 %, delivery 100 %), empty 100 % (the first run, before the prompt fix, gave 90.8 %). A full `tune` run takes about 1 hour on the CPU laptop; do not delete or switch the folder it runs from until it prints `wrote .../predictions-<time>.json` (results are only written at the end). Per-field results are in the JSON (`by_key`).

Splits: `tune` (patients 2, 3, 4, 8), `calibrate` (1, 5, 7), `verify` (6, 9, 10). Everything generated stays in `eval-results/` and `data/` (git-ignored).

### 5. Run the app on the laptop (browser)

Two terminals:

```
make server        # API on :8787. First start prints demo users sf-01, sf-02 (midwives), sup-01 (supervisor) and their PINs, once.
make pwa           # PWA on http://localhost:5173 (/api is proxied to the server)
```

First start of `make server` prints (PINs are random, shown once, stored hashed):

```
Demo users created. PINs are shown ONCE (stored hashed):
  sf-01  573194
  sf-02  269719
  sup-01  971041
care-agent server on :8787 (data: .../care-agent/data, analyzer on)
```

Write them down; later starts print only the last line. Lost them? Stop the server, delete `data/care-agent.db` (this also deletes uploaded pages) or use `data/users.json`. `make pwa` prints `Local: http://localhost:5173/` and a `Network:` line with the LAN address for the phone. To choose the PINs instead, create `data/users.json` before the first start: `[{ "id": "sf-01", "role": "midwife", "pin": "123456" }]`.
Open http://localhost:5173, log in as `sf-01`, tap **Nouvelle session**, pick the page type (1 cover, 2, 3 or 4 are analyzed), tap **Photographier une page** and choose a specimen PNG (e.g. `../datasets/data/Paper Registry/dossiers_specimen_10_patientes-19.png`, page type 3). Expected: "Photo envoyée", "Page reçue, analyse en cours…", then after a few minutes a page summary and the first question (« J'ai lu « … » pour …, mais la valeur semble inhabituelle. Pouvez-vous vérifier ? ») with **Confirmer / Corriger / Reprendre la photo / Laisser illisible**; answer with the buttons or type the value (e.g. `158`, `12/04/2026`, `120/80`, `neg`, `c'est bon`), then the bot asks the next field, and « Tout est vérifié pour la page 3. » + **Confirmer la page** at the end. **Reprendre la photo** uploads a new photo that replaces the page.

What to check in the browser: the analysis takes several minutes on CPU, the « Page reçue, analyse en cours… » bubble stays until then (the server terminal shows `POST /api/pages 200` then nothing while the model works). The page summary counts `lu / à vérifier / illisible / non lu`; every « à vérifier » field comes back as a question with the reason, and **Confirmer la page** is refused (list of fields) while a field is still to check. Never expected: a percentage shown to the midwife, or a doubtful value accepted without a question.

- No model at hand? `ANALYZER=off make server`: upload works, analysis never starts.
- No model, but you still want to read pages: `ANALYZER=ink make server` (manual entry: you type the cells that have writing); with the model on, a page whose analysis fails offers **Saisie manuelle**.
- UI only, no server: `VITE_FIXTURES=1 make pwa` replays a canned flow (a doubt, an illegible field, a failed page with manual entry, a retake).
- Optional LLM chat: `CHAT_ENGINE=strands make server` (see `docs/security.md`).

### 6. On a phone (same Wi-Fi as the laptop) — phone test over HTTPS

Goal: open the app on a real phone, take a photo of a registry page with its camera, and see the analysis and the review. The phone's browser only allows the camera on HTTPS, so the laptop serves the PWA with a certificate from **mkcert**, a tool that creates a small local certificate authority (CA); the phone is told to trust that CA once. Plan ~20 minutes the first time. Steps 1–4 are done once per laptop/phone; steps 5–7 each time.

**What you need:** the laptop (Linux; macOS/Windows notes inline) with the repo installed (sections 1–2) and Ollama + `gemma4:e4b` running; an Android phone or iPhone on the **same Wi-Fi** as the laptop; a printed specimen page, or a page shown full screen on another screen (e.g. `../datasets/data/Paper Registry/dossiers_specimen_10_patientes-19.png`, page type 3).

**1. Install mkcert on the laptop**

```
sudo apt install libnss3-tools mkcert        # Debian/Ubuntu. Package missing? Download the binary from
                                             # https://github.com/FiloSottile/mkcert/releases, chmod +x it, put it in your PATH
# macOS: brew install mkcert nss     Windows: choco install mkcert
mkcert -version                              # expect a version line, e.g. v1.4.4
```

**2. Create the local CA and the certificate** (in `care-agent/`)

```
mkcert -install
make certs
```

`mkcert -install` prints `Created a new local CA` and `The local CA is now installed in the system trust store`. `make certs` prints `Created a new certificate valid for the following names` followed by `localhost`, `127.0.0.1` and the laptop's IP addresses (e.g. `192.168.1.42`), then the two files `data/certs/cert.pem` and `data/certs/key.pem` (git-ignored: `git check-ignore data/certs/cert.pem` prints the path). Check the laptop's Wi-Fi address with `hostname -I` (the first `192.168.x.x` or `10.x.x.x`): it must be in that list. **If the laptop gets a new IP later (other network, hotspot), run `make certs` again and restart `make pwa`.**

**3. Put the CA on the phone**

The file to transfer is `rootCA.pem`, in the folder printed by `mkcert -CAROOT`. It is the CA certificate only; never copy `rootCA-key.pem` (the private key). Easiest transfer: serve that folder over the Wi-Fi for a minute.

```
python3 -m http.server 8000 --directory "$(mkcert -CAROOT)"
```

On the phone, open `http://<laptop IP>:8000/rootCA.pem` and download it, then stop the command with Ctrl+C. (USB or emailing it to yourself works too.)

- **Android:** Settings › Security (or Security & privacy) › More security settings › Encryption & credentials › Install a certificate › **CA certificate** › confirm the warning › pick `rootCA.pem`. Menu names vary by brand: search "certificate" in Settings. Use **Chrome** for the test.
- **iPhone:** open the downloaded file → "Profile downloaded" → Settings › Profile Downloaded › Install. Then **Settings › General › About › Certificate Trust Settings** › enable full trust for "mkcert …". Without this second switch Safari still refuses the site. Use **Safari**.

**4. Let the phone reach the laptop**

If the laptop firewall is active (`sudo ufw status` says `active`), open the PWA port: `sudo ufw allow 5173/tcp`. Only port 5173 is needed: the PWA proxies `/api` to the server on the laptop itself.

**5. Start the app** (two terminals in `care-agent/`)

```
make server
make pwa
```

`make pwa` must now show **https**, which proves the certificate was found:

```
  ➜  Local:   https://localhost:5173/
  ➜  Network: https://192.168.1.42:5173/
```

If it shows `http://`, the files in `data/certs/` are missing: redo step 2.

**6. Open the app on the phone**

Type the `Network:` address exactly, `https://<laptop IP>:5173`. Expected: the « Care Agent » login screen, with no security warning. Log in (`sf-01` + the PIN printed by `make server`).

**7. Test checklist (note what works and what does not)**

1. **Nouvelle session**, choose page type **3 · Grossesse**, tap **Photographier une page**: the **camera** opens (not only a file picker). Photograph the page flat, whole, without glare.
2. Bubbles « Photo enregistrée » then « Page reçue, analyse en cours… »; on the laptop, the `make server` terminal shows `POST /api/pages 200`.
3. After a few minutes: the page summary, then the review questions one by one. Answer one with **Confirmer**, one with **Corriger** (type a value), one by typing in the text box (e.g. `neg`). At the end: « Tout est vérifié pour la page 3. » and **Confirmer la page**.
4. Offline: switch the phone to airplane mode, take another photo: it is listed « En attente de traitement IA ». Turn airplane mode off (Wi-Fi back on): the badge goes « Synchronisation » then « En ligne », and the page is sent and analysed once.
5. Optional: browser menu › "Add to Home screen" / "Install app": the app opens full screen like a native app.

**What to report back:** phone model, OS version and browser; which checklist items passed; a screenshot of anything wrong; the photo used if the reading was bad. A real camera photo is harder than the clean specimen files: compare the values the app shows with the paper page.

**Troubleshooting**

| Symptom | Cause and fix |
| --- | --- |
| "Your connection is not private" / « Ce site n'est pas sécurisé » | The phone does not trust the CA (redo step 3; on iPhone, the Certificate Trust Settings switch), or the address is not in the certificate (laptop IP changed: `make certs` again, restart `make pwa`). |
| The page never loads / times out | Not on the same Wi-Fi; guest or public Wi-Fi often isolates devices (use a phone hotspot for both devices, then `make certs` again for the new IP); firewall (step 4). |
| `make pwa` shows `http://` | `data/certs/cert.pem` or `key.pem` missing: step 2. |
| Only a file picker, no camera | Opened over `http://`, or camera access denied: allow it in the browser's site settings. |
| Login fails | Server not running, or wrong PIN (PINs are printed once at the first `make server`; section 5 explains how to set them). |
| Analysis never ends | Ollama not running or the model not pulled (`curl localhost:11434/api/version`). On CPU several minutes per page is normal. |

### 7. Offline demo (encrypted queue, sync)

Needs the service worker so the app reloads offline: `npm run build -w @care-agent/pwa`, then `npx vite preview` in `apps/pwa` (port 4173, `/api` proxied like `make pwa`). Or skip the reload part and use the dev server.

1. Log in online once (this derives the device key from the PIN and stores the encrypted token). A reload now shows « Déverrouiller »: the PIN is asked again.
2. **Nouvelle session**, then go offline: airplane mode on the phone, or on the laptop the switch **Mode hors ligne (simulation)** under the header (no network call at all while it is on), or DevTools > Network > Offline. Badge: **Hors ligne**.
3. **Photographier une page** twice. Each page is stored encrypted on the device and listed as « En attente de traitement IA ». Reload the page while offline: « Serveur injoignable : déverrouillage hors ligne », type the PIN (a wrong PIN is refused, 5 failures add a delay), the queue is still there.
4. Reconnect (or switch the simulation off): badge **Synchronisation (n)**, the pages go « Envoi en cours… » then « Envoyée — analyse en cours », then the analysis arrives (with `ANALYZER=ink`: the manual-entry questions).
5. Try also: kill the server during an upload and restart it (the page stays queued, no loss, no duplicate); a refused page shows « Échec d'envoi : … » and **Réessayer**.
6. **Effacer les données de l'appareil** (under the header, and on the unlock screen) deletes the local database, queued pages included.

What proves it works: (a) while offline, the server terminal shows no request and the pages stay « En attente de traitement IA » even after a reload; (b) after reconnecting, the server terminal shows one `POST /api/pages 200` per queued page, and each page appears once in the chat (no duplicate bubble); (c) after a kill/restart of the server during an upload, the page is still sent once (the server answers the replay with the stored page). Failure would be: a page vanishing from the queue without « Envoyée », two copies of a page, or the queue empty after an offline reload.

Design, failure table and the network-cut matrix: [docs/offline.md](docs/offline.md). Tests: `npm test -w @care-agent/pwa`.

### 8. Image quality gate (no model, no Ollama)

Details, thresholds and numbers: [docs/quality.md](docs/quality.md).

**8.1 Evaluation on the specimens, the real photos and synthetic degradations (~1 minute)**

```
make quality-eval
```

Output (excerpt):

```
specimens: 80 pages, OK 80, WARNING 0, REJECT 0
  blur 2194.3..3758.1  brightness 193..204  glare 0..0  spread 107..138
...
1-1.jpg WARNING | Page coupée : reculez pour voir les 4 coins | quad found | warped true
...
│ 12      │ 'p3 clean'              │ 'OK'      │ 2805.3 │ ...
│ 13      │ 'p3 blur s2'            │ 'WARNING' │ 170.1  │ ...
│ 18      │ 'p3 very dark'          │ 'REJECT'  │ 0      │ ...
wrote .../eval-results/quality/ (quality-eval.json, warp-1..5.png, synthetic-p3.png)
```

Success: the first line says `OK 80, WARNING 0, REJECT 0` (a clean render must never be warned), every `clean` and `on table, mild` row is `OK`, every `blur`, `motion`, `dark`, `cropped` row is `WARNING` or `REJECT`, `very dark` is `REJECT`. Failure: a clean specimen listed under `not OK:` (a threshold is too strict), or a blurred/dark/cropped variant that is `OK` (too lax). The five real photos are all `WARNING` « Page coupée » (open booklets cut by the frame): that is expected, not a failure; what matters is `quad found`.
Look at the files in `eval-results/quality/` (git-ignored, verify: `git check-ignore -v eval-results/quality/warp-1.png`): `warp-N.png` = original with the detected quad in green on the left, the rectified page on the right (a red background = no warp applied); `synthetic-p3.png` = the page 3 variants side by side; `quality-eval.json` = every metric. Photo 1 must come out as a straight A4 page.

**8.2 In the browser (unit tests + the app)**

```
npm test -w @care-agent/quality     # metrics, quad detection, warp size, gate outcomes, stability: expect "# pass 7", "# fail 0"
npm test -w @care-agent/server      # incl. LOW_QUALITY -> NEEDS_REVIEW and the rectify counter: expect "# pass 75"
npm test -w @care-agent/pwa         # incl. guide geometry and quality kept in the encrypted queue: expect "52 passed"
```

Then the app (`npm run build -w @care-agent/pwa`, `npx vite preview` in `apps/pwa`, and `ANALYZER=ink make server` so no model is called; `localhost` counts as a secure context for the camera):

1. **Nouvelle session**, then **Photographier une page**: the camera screen opens with a white A4 frame. Hold a page (or a photo of one on a screen) inside it: the hint reads « Cadrez la page dans le guide » or the precise problem (« Photo floue … »), the frame turns **green** with « Ne bougez plus… » when everything passes, and the photo is taken by itself about half a second later. **Photographier** takes it by hand.
2. After the shot, « Analyse de la photo… » flashes, then: OK = the page is queued as usual (nothing extra to do); doubtful = a panel « Photo à vérifier » with the messages and **Reprendre** / **Garder quand même**; hopeless (black, no paper) = « Photo inutilisable » with **Reprendre** only.
3. **Importer une image** (or the main button when the camera is unavailable: plain HTTP on the LAN, permission denied) goes through the same check. Offline works the same (airplane mode, or the simulation switch): the verdict appears, the page is queued, and it is sent when the connection returns.
4. After **Garder quand même** and the upload, the page's questions are all « La photo de cette page est de qualité douteuse : j'ai lu « … » pour … » (every field read goes to review).

Success: the green frame appears only on a sharp, well framed page and never on a blurry one; the blurry photo gets « Photo floue : rapprochez-vous et tenez le téléphone immobile »; the server log (`make server`) shows one `warp: n of m analysed pages rectified since start` line per page read (model or `ANALYZER=ink`). Failure: the camera screen black or stuck on « Démarrage de la caméra… » (permission, or no HTTPS off localhost: use the file picker), the check never answering (OpenCV asset not cached: build + preview, not the dev server, for offline), a clean photo refused.

### 9. Patient linking (cover page, link question, longitudinal record)

Needs no model. Details: [docs/api.md](docs/api.md) (endpoints), [docs/security.md](docs/security.md) (identifiers).

**9.1 Unit and API tests**

```
npm test -w @care-agent/server    # expect "# pass 75" and "# fail 0"
npm test -w @care-agent/pwa       # expect "52 passed"
```

What they prove (test names in `apps/server/src/linking.test.ts`, `record.test.ts`, the `linking:` / `re-digitization:` / `privacy:` / `SYNCED:` tests in `server.test.ts`, `patient linking` in `apps/pwa/src/state.test.ts`): exact, near, inconsistent and low-confidence fiche cases; nothing is ever created or linked by asking; `PAT-000001`, `PAT-000002` come from a counter; « Je ne sais pas » parks the pages in `DUPLICATE_SUSPECTED` and the same endpoint settles it later; per-field re-digitization choices; a midwife gets `403` on a patient she has no linked session with; a database dump after a full flow holds no identifier (no identifier column, no CIN or phone pattern in any text value, a phone typed into a free-text field is stored as `[masqué]`). Failure would be a red test named after one of these rules.

**9.2 In the browser (no model: `ANALYZER=ink`)**

```
ANALYZER=ink make server            # first start prints sf-01 / sf-02 / sup-01 PINs (or put data/users.json first)
npm run build -w @care-agent/pwa && cd apps/pwa && npx vite preview    # http://localhost:4173, or `make pwa` on :5173
```

Use a specimen cover and a pregnancy page of the same patient (the files in `../datasets/data/Paper Registry/` are named `dossiers_specimen_10_patientes-17__<hash>.png` for page 17 = patient 3's cover, `...-19__<hash>.png` = patient 3's pregnancy page; `ls` shows the exact names).

1. **Session 1.** Log in as `sf-01`, **Nouvelle session** > **Démarrer** (leave the fiche empty: it will be read from the cover). Page type `1`, **Importer une image** (or **Photographier une page**) with the cover; page type `3` with the pregnancy page. With `ANALYZER=ink` every handwritten cell is a question: for the cover type the four values with **Corriger** (`2026-711-003`, `Marrakech-Safi`, `Al Haouz`, `DR Tahannaout Sud`); confirm each page with **Confirmer la page** (« Tout est vérifié pour la page 1. »). For the long pregnancy page, answer by API or use **Laisser illisible** on each question (the e2e script in section 9.3 fills it from the ground truth).
   Expected: after the last confirmation « Toutes les pages sont confirmées. … » with the button **C'était la dernière page : choisir le dossier**. Tap it: « Aucun dossier ne correspond à la fiche 2026-711-003 (DR Tahannaout Sud). Créer un nouveau dossier ? » with **Créer un nouveau dossier** / **Je ne sais pas**. Nothing exists yet: `sqlite3 data/care-agent.db 'select count(*) from patients'` prints `0`. Tap **Créer un nouveau dossier**: « Dossier PAT-000001 créé (1 visite) » and **Voir le dossier PAT-000001** (the record: visits, key values, retained values with their source date). The page chips read « dossier enregistré » (pages `SYNCED`).
2. **Session 2 (same woman).** **Nouvelle session**, the same cover again (type the same fiche, spaces instead of dashes also work: `2026 711 003`) and the pregnancy page again. At the question: a candidate card « Patient 1 · PAT-000001 », fiche, facility, DDR, `1 visite`, the reasons (« Même numéro de fiche et même établissement. », « DDR concordante … », « Province concordante … ») and three buttons: **Oui, c'est le dossier PAT-000001** / **Non, créer un nouveau dossier** / **Je ne sais pas**. Tap the first: « Dossier PAT-000001 mis à jour (2 visites) », then the card « Cette page existe déjà dans le dossier. Pour chaque champ qui diffère, que faut-il garder ? »: for each field whose old value would be overwritten, « Ancien (date) : … · Nouveau : … » and **Garder l'ancien** / **Prendre le nouveau** (the selected one is highlighted; « choix par défaut » until you choose: the new value if it is read reliably, the old one if the new one is empty). **Voir le dossier PAT-000001** now shows 2 visits; each retained value carries the date of the page it comes from. Both photos stay stored (`select page_type, state from pages`).
3. **Session 3 (near-match).** A new session with the cover where you type the fiche `2026-711-008` (one digit off). Expected: « Je ne suis pas sûr de la patiente pour la fiche 2026-711-008. … », the candidate card with « Numéro de fiche presque identique (2026-711-003 dans le dossier), même établissement. » and the four-button choice **Patient 1** / **Aucune, créer** / **Je ne sais pas** (with two candidates: **Patient 1** / **Patient 2** / **Aucune, créer** / **Je ne sais pas**). Tap **Je ne sais pas**: « D'accord : ces pages sont mises de côté pour vérification (doublon possible). Rien n'est créé ni lié. », the chip reads « à vérifier (doublon ?) », the pages are `DUPLICATE_SUSPECTED`, `patients` still has 1 row. The supervisor lists it with `GET /api/review/duplicates`; the midwife settles it later with `POST /api/sessions/<id>/link`.
4. **Offline.** Tick **Mode hors ligne (simulation)** once the pages are confirmed: the button **C'était la dernière page : choisir le dossier** is disabled and « Hors ligne : la question attend la connexion au serveur. » appears; untick it and the question is asked. Linking never happens without the server.
5. **A doubtful fiche.** If the cover reading looks wrong (letters O or I in place of 0 or 1, or not 4-3-3 digits), the bot asks first « J'ai lu 2O26-711-OO3, est-ce correct ? » (**Oui, c'est correct** / **Non, je la saisis**) and only then looks for candidates. A session without a readable fiche asks the midwife to type the fiche and the facility.

What to look at: the server terminal shows only paths and statuses (no values); `data/care-agent.db` (git-ignored) holds `patients(id, fiche_number, facility, created_at)`, `session_links(session_id, patient_id, decision, decided_by, decided_at)`; no column or value holds a name, CIN, phone or address. Success: ids are `PAT-000001`, `PAT-000002`… in creation order whatever the data, no patient appears before a tap, every doubtful case shows the buttons. Failure: a patient row before any decision, a candidate silently attached, or a page left `VALIDATED` after the decision.

**9.3 Scripted end to end (what step 11 was verified with)**

The three sessions above, driven by Playwright against `ANALYZER=ink` server + `vite preview`: `step11.cjs` in the session scratchpad (not part of the repo; it needs `playwright-core` and Chrome). It prints `RESULT PASS ...` lines and writes `step11-*.png` screenshots (cover typed, question « créer », record, candidate card, differences, four buttons, parked, offline wait). Any `RESULT FAIL` line is a failure (exit code 1).

### Known limits

- CPU only: ~20 s to read a crop plus ~7 output tokens/s; a full 8-page record takes many minutes. Analysis is designed to run in the background.
- Ollama returns no per-token probabilities for this model, so confidence comes from ink/model agreement and validators.
- Only pages 1 to 4 have schemas so far (cover, identification, pregnancy, delivery).
- Linking: the supervisor reads the duplicates list but the midwife settles them (the supervisor is read-only); the PWA has no screen for a parked session yet (API only); the candidate search scans all patients (fine for a demo, not for thousands); a page added to a session after its link decision cannot be linked (start a new session).
- Offline, only captures are queued; reviewing (corrections, confirmations) needs the server.
- Quality thresholds are provisional (recalibrated in step 13); an open booklet is detected as one big quad (the spread), the single-page crop is not done yet.
