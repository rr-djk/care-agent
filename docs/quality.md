# Image quality gate and page warp (step 10)

A bad photo costs the midwife more than a retake: the model reads blur as wrong values. The phone therefore checks every photo **before** it is queued (works offline), and the server straightens the page before reading it. Code: `packages/quality` (one OpenCV.js build, `@techstark/opencv-js` 4.12.0-release.1, shared by the PWA worker and Node).

## Three outcomes, never a hard block

| Outcome | When | Midwife sees |
| --- | --- | --- |
| `OK` | nothing doubtful | nothing: the page is queued with its `quality` |
| `WARNING` | anything doubtful (blur, exposure, glare, framing, perspective, page not detected) | the messages, **Reprendre** or **Garder quand même** (page queued with the `LOW_QUALITY` flag) |
| `REJECT` | hopeless only: black photo (mean luma < 20) or no paper at all | the message and **Reprendre** only |

If OpenCV cannot run (worker failure), the photo is queued without a verdict: the check never blocks a capture.

`LOW_QUALITY` on the server (`worker.ts` `applyLowQuality`): every field of that page the analysis read as `KNOWN` becomes `NEEDS_REVIEW` with `reason: "low_quality"` and `confidence_signals.quality` 0.5, so the review walks them one by one (« La photo de cette page est de qualité douteuse : j'ai lu « … » pour …. Pouvez-vous vérifier ? »). Fields already doubtful, illegible or empty are left as they are. The midwife can still confirm each one. Applies to the model path and to ink-only manual entry (its checkboxes).

## Metrics (`QualityResult.metrics`, all computed on a ~1000 px long-side copy)

| Metric | Definition | Reported as |
| --- | --- | --- |
| blur | median Laplacian variance over 40 px tiles that hold ink or print (tile luma std ≥ 10) and lie inside the page quad. A page is mostly blank paper: a global value would measure the paper. Also isotropy = min/max of the mean \|dx\|, \|dy\| gradients over those tiles (motion blur smears one direction) | `blur` = the median (high = sharp) |
| brightness | luma statistics over the page pixels: mean, share > 250 (clipped), share < 15 (black), p99 − p1 spread (p95 − p5 reads 0 on a page that is 98 % blank paper, so the wider range is used) | `brightness` = mean luma |
| glare | share of the page covered by connected blobs (≥ 0.4 % of the page) where all three channels are > 240 (white; pink paper has G ≈ 190). Not measured in live mode | `glare` |
| framing | page quad: paper mask (saturation > 50 and value > 60, Otsu on luma when no pink), close/open, largest outer contour, convex hull, `approxPolyDP` to 4 corners. Checks: all 4 corners inside the frame (margin 0.5 %), area share, largest corner angle deviation from 90° | `framing` = page area share (0 = no quad; 1 = a flat full-page render) |

A flat full-page render (the specimen PNGs, paper to the edges, A4 aspect ± 3 %) counts as well framed: quad = the whole image, no warp. A render cropped to another aspect does not (« Page coupée »).

## Provisional thresholds (`packages/quality/src/thresholds.ts`)

| Rule | Threshold | Message |
| --- | --- | --- |
| blur | median < 250 | Photo floue : rapprochez-vous et tenez le téléphone immobile |
| motion | isotropy < 0.25 | Photo bougée : tenez le téléphone immobile |
| dark | page mean luma < 90 or black share > 10 % | Trop sombre : approchez-vous d'une source de lumière |
| bright | page mean luma > 225 or clipped share > 15 % | Trop clair : évitez la lumière directe sur la page |
| contrast | p99 − p1 < 40 | Contraste trop faible : changez l'éclairage |
| glare | blobs > 3 % of the page | Reflet sur la page : inclinez légèrement le téléphone |
| cut | a corner outside the frame (0.5 % margin) | Page coupée : reculez pour voir les 4 coins |
| far | page area < 40 % of the image | Page trop petite dans l'image : rapprochez-vous |
| skew | corner angle deviation > 10° | Photo prise de biais : placez-vous au-dessus de la page |
| no quad | paper present, no 4-corner contour | Page non détectée : posez la page à plat sur un fond sombre et cadrez-la entièrement |
| REJECT | whole-image mean luma < 20 / no paper-coloured pixels (< 5 %) | Photo noire … / Aucune page visible : cadrez la page entière |

They were chosen by eye on the 80 specimen renders, the 5 real photos and the synthetic degradations below. **Step 13** recalibrates them: degrade pages in controlled steps, run the analysis, and tabulate "measured quality → field accuracy"; each threshold goes where accuracy starts to fall (blur first, then exposure and glare). The scripts exist (`make degrade`, `make quality-curve`, procedure below); the decision waits for the full runs. `LOW_QUALITY`'s 0.5 signal is provisional too.

### Step 13: how to choose the thresholds (procedure; thresholds NOT changed yet)

The tooling is in place; the decision waits for the full runs (a handful of pages is not enough).

1. `make degrade ARGS='--split calibrate --pages p4,p6 --variants all'` writes graded variants (blur σ 1/2/4, motion blur 15 px, darkness ×0.6 / ×0.4, glare blob, JPEG q30, downscale ×0.5, perspective mild / strong) under the git-ignored `data/degraded/`.
2. `make predict ARGS='--split calibrate --variants all'`: every image goes through the gate (`gate` in the record) and the analysis (`status`, `verbatim` per field).
3. `make quality-curve ARGS='--pred eval-results/predictions-<ts>.jsonl'` prints, per variant, the accuracy on handwritten cells, the drop against the clean reading of the same pages and the mean gate metrics, then, for blur / motion / darkness / glare, the first level whose accuracy dropped by 5 points (`--drop`) and by 25 points (`--collapse`) with the metric value there.
4. Decide: **WARNING** threshold = between the metric of the last level that still reads well and the first level with the drop (blur: `blurMin`, motion: `isotropyMin`, darkness: `lumaDarkMax`, glare: `glareMax`). **REJECT** stays "hopeless only" (black photo, no paper): move `lumaRejectMax` only if accuracy is already at the floor at a level the gate still lets through. A family with `none` is not contradicted: keep the threshold. Check afterwards with `make quality-eval` (80 clean specimens must stay `OK 80`, every blurred / dark variant must stay `WARNING`).
5. Write the table and the chosen values here, and change `packages/quality/src/thresholds.ts` in the same commit. Note: the gate thresholds are not part of the `pipeline_hash` (they do not change what the model reads), but the quality factor stored in the calibration table comes from the gate outcome, so recalibrate after changing them.

Variants are synthetic, not phone photos (see `docs/calibration.md`, Limits). Measured so far on one cover page only (illustration, not a decision): Gaussian blur σ 2 gave gate `WARNING` (blur 137 against the threshold 250) and 5 of 6 handwritten cells right against 6 of 6 clean; JPEG q30 stayed `OK` and 6 of 6.

## Page warp (`warpPage`)

Quad found, not a full-page render, plausible (area ≥ 30 % of the image, corners not outside the frame, long/short side ratio within ±20 % of A4) → `getPerspectiveTransform` + `warpPerspective` to 1654 × 2339 (A4 portrait, the template size; a page photographed sideways is turned a quarter). Otherwise the image is returned unchanged. The server applies it in memory before analysis (`vision/rectify.ts`, called by `decode` in `main.ts`); the stored original stays byte-exact. The log keeps a counter only (`warp: 3 of 5 analysed pages rectified since start`). The `npm run analyze` / `predict` CLIs do not warp (they read the clean specimens).

## Live camera (PWA)

`getUserMedia` (rear camera, ideal 1920 × 1080), an A4 guide frame, frames analysed in the worker at ~4 fps (framing + blur + exposure, no glare). The guide turns green when the outcome is `OK`; when the page has been green and its corners have moved < 2 % between frames for 0.5 s, the photo is taken (a manual shutter exists too). The full frame is captured (no crop) and the video is shown in a box with exactly the video's aspect ratio, so the guide's fractions are fractions of the captured image. Full resolution: `ImageCapture.takePhoto` when available and when its aspect ratio equals the frame's (±2 %, else the field of view differs and the guide would not map), otherwise the current video frame. The post-capture check then runs as a safety net. No `getUserMedia` (insecure HTTP origin) or permission denied: the file picker.

## Evaluation (`make quality-eval`, ~1 minute; output in `eval-results/quality/`)

**80 clean specimen pages: 80 OK, 0 WARNING, 0 REJECT** (blur 2194 … 3758, mean luma 193 … 204, glare 0, spread 107 … 138).

**5 real photos** (900 × 1600 JPEG), all `WARNING` « Page coupée » (see the notes):

| Photo | blur | isotropy | mean luma | glare | page area | skew ° | quad | warp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1-1 (cover) | 493 | 0.75 | 187 | 0 | 0.72 | 4 | found, tight | yes, good |
| 1-2 (identification spread) | 557 | 0.57 | 172 | 0 | 0.77 | 9 | found, includes the right page strip | yes, usable |
| 1-3 | 842 | 0.84 | 188 | 0 | 0.75 | 8 | found, includes the neighbour page and the curl | yes, usable |
| 1-4 | 685 | 0.42 | 167 | 0 | 0.81 | 3 | found, spread cut at the left border | yes, neighbour page stretched in |
| 1-5 | 1113 | 0.43 | 182 | 0 | 0.60 | 6 | found, spread cut at the left border | yes, neighbour page stretched in |

Notes: the photos are sharp and well lit (blur 493 … 1113 against the threshold 250), so only framing speaks. In 1-1 the page touches the left and right edges (corners at x = 0 and 898 of 900): « coupée » is borderline-correct. 1-2 … 1-5 are open booklets: the neighbouring page and the gutter are pink too, so the quad is the whole spread, and 1-4 / 1-5 really are cut at the border. The warp makes 1-1 a clean A4 page; for the spreads it removes the perspective but the geometry is not the single-page template, so the template cell boxes will not line up on them (a single-page crop of a spread is future work, with the cover/page-type step). Previews: `eval-results/quality/warp-1..5.png` (green = detected quad on the original, rectified page on the right; a red background means no warp).

**Synthetic degradations** of specimen pages 2, 3, 4 (full-size renders; same result on all three except where noted):

| Variant | Outcome | blur | mean luma | glare | page area | Message |
| --- | --- | --- | --- | --- | --- | --- |
| clean | OK | 2617 / 2805 / 2614 | 200 / 193 / 203 | 0 | 1 | |
| Gaussian blur σ 2 | WARNING | 173 / 170 / 139 | | | | floue |
| Gaussian blur σ 4 | WARNING | 13 / 14 / 13 | | | | floue |
| Gaussian blur σ 8 | WARNING | 3 / 3 / 3 | | | | floue |
| motion blur 25 px | WARNING | ~1000-1400 (isotropy 0.11-0.13) | | | | bougée |
| dark (× 0.4) | WARNING | | 80 / 77 / 81 | | | Trop sombre |
| very dark (× 0.08) | REJECT | | 16 / 16 / 17 | | | Photo noire |
| overexposed (× 1.3 + 70) | WARNING | | 250 / 248 / 252 | 0.82 / 0 / 0.95 | 1 / 0 (p3: page not detected) | Trop clair, Reflet |
| glare blob (8 %) | WARNING | | 207 / 200 / 209 | 0.105 / 0.104 / 0.107 | | Reflet sur la page |
| 20 % cropped on the left | WARNING | | | | | Page coupée |
| on a table, mild perspective | OK | 2007 / 2099 / 1992 | | | 0.72 | |
| strong perspective | WARNING | | | | 0.5 | Photo prise de biais (skew 15°) |

Every blurry, dark and cropped variant is WARNING or REJECT; every clean variant is OK. Not tested: a weak motion blur (< 25 px), blur on a real photo, exposure with a colour cast. Contact sheet of the page 3 variants: `eval-results/quality/synthetic-p3.png`.

## Live camera check (Chromium fake camera)

Fake video from the real photo 1-1 placed on a dark surround (720 × 1080 stream): the sharp video turns the guide green about 1.7 s after the camera opens (OpenCV load included; frames then take ~100 ms) and fires the auto-capture; the same video blurred (σ 5) never turns green over 8 s (hint « Photo floue … »), the manual shutter then gives the WARNING panel. Guide inside the frame, frame ratio = video ratio, guide ratio 1.414. Offline post-capture: a black photo gives REJECT (Reprendre only), a cropped one WARNING; the kept page is queued, nothing reaches the server while offline, and after reconnecting the server has the pages with `quality` and `LOW_QUALITY`. Getting `getUserMedia` denied shows « Choisir une photo » and the file path works.

## Limits

- Thresholds are provisional; the real photos are the only real-world data (5), all booklet spreads.
- OpenCV.js is ~11 MB (3.5 MB gzip): precached once by the service worker, downloaded at the first online visit. Without the service worker (dev server) it is fetched when the first photo is checked.
- First check after a reload takes ~1.5 s more on a laptop (wasm start), more on a phone.
- `ImageCapture.takePhoto` could not be tested (Chromium fake camera has none): the frame fallback was.
