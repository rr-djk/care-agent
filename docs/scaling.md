# Accuracy vs latency: how to scale from 90 % to 98 %

**Decision (Oct 3, 2026):** the prototype keeps the 13-zone cut of the pregnancy page (≈ 90 % of handwritten cells right on the tune split) to keep processing time reasonable on a CPU-only laptop. A finer cut reached **98.3 %** on the same page. This document records how, what it costs, and how to deploy it where compute allows.

## What we measured

Tune page 27 (pregnancy page, patient 4), same model (`gemma4:e4b` on Ollama, CPU), same cache, same prompt; only the crop zones change:

| Pregnancy table cut | Zones | Handwritten cells right | Blank cells right | Wrong and not flagged | Model time for the page |
| --- | --- | --- | --- | --- | --- |
| **13 zones (kept)** — 4 row groups × 3 visit-column groups | 13 | 104 / 115 = **90.4 %** | 165 / 165 | 0 | **127 s** |
| 22 zones — 7 row groups that never cross a dark section band | 22 | 113 / 115 = **98.3 %** | 165 / 165 | 1 | 521 s |

On the whole tune split (12 pages, 4 patients) the 13-zone pipeline scores 92.2 % of handwritten cells right and 100 % of blank cells left blank (README section 4).

## Why it works

The pregnancy table is split by dark printed section bands (« EXAMEN CLINIQUE », « EXAMEN BIOLOGIQUE », « TRAITEMENT », « EXAMEN FAIT PAR »). With 13 zones, the third row group starts with « TV : bassin », crosses the « EXAMEN BIOLOGIQUE » band, then holds glucosuria, albuminuria and the serologies. In that crop the small model often answers empty for short handwritten words just below the band (« Neg »), and misreads some words (« Normalux » for « Normaux »). Cutting the rows at the bands (row groups of 4, 7, 6, 6, 5, 1, 1 rows: visits | clinical exam | biology | treatment | examiner) gives crops with one homogeneous section each: on page 27 all glucosuria/albuminuria cells and the three « Normaux » became right. One new misread appeared (« Fern » for « Ferm »), and one cell stayed wrong but flagged.

Two effects to keep in mind when pitching:

- **Smaller, homogeneous crops help a small vision model** more than prompt changes do: the earlier prompt fix (`null = illegible` reworded) gained 1.4 points on the split, the zone cut 8 points on this page.
- **The cost is per crop**, not per cell: on this CPU each model call spends ~15–25 s reading the image before writing anything. 22 zones = 22 image reads, hence ~4× the time for the page, even though the answer text is about the same length.

## Cost model (this laptop: Intel Core 7 150U, 15 GB RAM, no GPU)

- Reading one crop (image + prompt): ~15–25 s. Writing the answer: ~7 output tokens/s, a few seconds for a compact answer.
- Pregnancy page: 13 zones ≈ 2 min, 22 zones ≈ 9 min. A full 8-page record: ≈ 15–17 min with 13 zones, ≈ 22 min with 22 zones (other pages unchanged).
- Analysis already runs in the background (offline queue, `PENDING_AI`), so the midwife never waits on a page; but the time to get a reviewable record grows.

## How to scale

In order of effort; the estimates are orders of magnitude, not measurements, except where stated.

1. **Same laptop, targeted cut.** Re-cut only the band that causes most errors (the biology section): ~16 zones instead of 22, most of the gain on glucosuria/albuminuria for roughly +25 % time instead of +300 %. Not measured yet.
2. **A machine with a GPU.** The image read is the bottleneck and is exactly what a GPU accelerates; the 22-zone cut then costs seconds per page, not minutes, and becomes the default. Same code, same model: only the Ollama host changes (`OLLAMA_URL`).
3. **Parallel zones.** Today zones are read one at a time (one CPU). On a server with several workers or a GPU, the zones of a page are independent calls and can run in parallel; the cache (key = crop + prompt + model) already avoids re-reading anything.
4. **Two-pass reading.** Read with the fast 13-zone cut, then re-read with the fine cut only the zones that contain a flagged cell (ink but empty answer, validator failure). Most pages pay little extra; the hard zones get the precise crop.
5. **Bigger model on a central server.** Gemma 4 has larger variants (12B, 26B-A4B, 31B); on a district or regional server they would read the same crops more reliably. The phone and the offline queue do not change: the server address is the only difference.
6. **Recalibrate after any change.** Any change to zones, prompts, thresholds or the model changes the pipeline hash: the calibration table is refused until `make predict` on the calibrate split and `make calibrate` are run again (`docs/calibration.md`). This keeps the confidence numbers honest at every scale.

## How to reproduce the 98 % run

The 22-zone cut is commit `45d655f` on branch `feature/step-13-calibration` (reverted by the next commit to keep 13 zones):

```
git show 45d655f --stat                      # what changed: zones.py, zones/pregnancy.json, pages/pregnancy.json, preview, fixtures
git cherry-pick 45d655f                      # on a scratch branch, to try it
make predict ARGS='--split tune --page-nos 27'
make eval ARGS='--extractor eval-results/predictions-<time>.jsonl --split tune --pages p3'
```

Expected on page 27: `non-empty` close to 98 % for the pregnancy layout, at about 4× the model time of the 13-zone run. Do not keep it on `main` without re-running the calibration (pipeline hash).
