@care-agent/eval: ground truth, zones and a minimal eval harness (see docs/Care_Agent-Dev_Plan.md, step 3).

- `make pages`: `dedupe.mjs`, `split.mjs` -> `data/pages.json`, `data/split.json`.
- `make truth`: `extract_pdf.py` (ground truth + identifier masks from the specimen PDF), `zones.py` (zones per layout), `zones_preview.py` (overlays in `docs/zones-pNN.png`). Read-only on `DATASETS_DIR`.
- `make predict ARGS='--split tune --pages p1,p2,p3,p4 [--limit N]'`: runs the full pipeline (model) and writes `eval-results/predictions-<time>.json`.
- `make eval ARGS='--extractor truth|empty|<predictions.json> --split tune|calibrate|verify|all --pages p1,p2,p3,p4'`: `run.mjs`, results in `eval-results/` (git-ignored).
- `normalize.py` / `normalize.mjs`: the comparison rule, same cases in `data/normalize_cases.json`.
- `data/real_photos_labels.template.json`: template to hand-label the 5 real photos (`docs/labeling.md`).
- `make schemas`: `build_schemas.mjs` bootstraps `packages/schema/pages/{identification,pregnancy,delivery}.json` (fields, zones, masks) from the ground truth + zones. Those JSON files are then the source of truth: re-running overwrites hand edits.
