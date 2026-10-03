# Hand-labeling the 5 real photos

The five JPGs (`1-1` to `1-5`, in the datasets directory) are the only real-form samples. They are never used for tuning: they only measure the gap between the clean specimens and a real photo (dev plan, phase 5). Their labels are written by a human, from the image.

## What to do

1. Copy `tools/eval/data/real_photos_labels.template.json` to `tools/eval/data/real_photos_labels.json` (the template stays untouched).
2. Open each photo from `DATASETS_DIR/data/Paper Registry/` (read-only, never copy a photo into the repo) and fill every `value` of its `fields`.
3. Keys follow the ground-truth scheme (`pNN.<row>.<column>`), so the same scoring can be applied later. Rows that exist only on the real form (`autres`, `autres_a_preciser`) have keys the specimen does not have.

| Photo | Shows | Fields |
| --- | --- | --- |
| `1-1.jpg` | Cover: fiche number, region, province, facility, facility type, coverage mode, pregnancy at risk. The woman's name is covered by paper | 21 |
| `1-2.jpg` | Identification: age, instruction level, profession, two checkboxes; family history table (6 rows × 2 columns); the woman's history (3 columns) | 20 |
| `1-3.jpg` | Obstetric history (4 × 4), previous deliveries (6 rows × 5 columns), gestation, parity, living children, VAT 1–5, rubella and hepatitis B vaccines with dates, smear | 59 |
| `1-4.jpg` | Pregnancy page, left half, photographed at an angle: DDR, height, blood group, 1st trimester visits 1–3 | 104 |
| `1-5.jpg` | Pregnancy page, right half: due dates, 2nd and 3rd trimester columns, partly cut at both edges | 194 |

## Value conventions

- Text: as written. Spaces, case, accents and `,` vs `.` do not matter (same rule as `tools/eval/normalize.mjs`: two values are equal when they match once accents, case and all spaces are removed and a decimal comma is a dot). Keep units as written (`58.8`, `11,8 g/dL`).
- Cell visibly empty: `""`. Present but unreadable or cut off by the photo edge: `"?"`. A dash written in the cell: `"—"`.
- Checkbox: `true` if ticked or crossed, `false` if empty.
- Staff names ("Examen fait par"): write `"<staff>"` if anything is written, never the name. Same as the ground truth.
- `null` means "not labeled yet". Leave nothing as `null` when you are done.
- Several lines in one cell (for example "Antécédents de la femme"): one text, lines separated by a space.

## What never goes in the file

No identifiers, ever: the woman's name, CIN, address, telephone, husband's name and husband's profession. They have no field in the template. They are visible on `1-2` (CIN, address) and written on `1-1` next to the title ("CM: …", not a form field): do not transcribe them, do not add a field for them, do not put them in a comment. `make check` fails if an identifier pattern is found in the committed ground truth and zones; check the labels file by eye before committing it.

## Status (step 12)

`tools/eval/data/real_photos_labels.json` holds labels for `1-1.jpg` (21 fields) and `1-4.jpg` (104 fields) only. **They were written by the build assistant from the images, not by a human: a human must verify them before any score is trusted.** `"?"` marks what is not reliably readable (61 of the 104 fields of `1-4`: the handwriting sits between the printed rows, so the row of a value is often a guess); `""` marks a cell that is visibly empty. The fiche number is labelled as the field value only; the handwritten "CM: …" next to the title and the woman's name are not transcribed. `1-2`, `1-3` and `1-5` are not labelled.

## Why the spreads are not templated

`1-2` to `1-5` are open booklet spreads: two pages in one photo, photographed at an angle, with the next page cut at the edge. Rectification (`vision/rectify.ts`) finds the quadrilateral of one A4 sheet; on a spread it finds the whole spread or one half with a curved spine, so a fixed zone template cannot be placed. Extracting one page out of a spread (split at the spine, flatten the curl, then template) is not done. Only the cover `1-1`, a single sheet, has a template (`real_cover`, `tools/eval/data/zones/real_cover.json`, `packages/schema/pages/real_cover.json`): its zones are hand-drawn on the photo after the warp to 1654 × 2339 px.
