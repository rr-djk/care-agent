.PHONY: check test pages truth schemas eval smoke help

help: ## List targets
	@echo "make check  - dataset guard + typecheck + tests"
	@echo "make test   - schema tests + tools tests"
	@echo "make pages  - dedupe the specimen PNGs and write the 3-way patient split (tools/eval/data)"
	@echo "make truth  - ground truth + zones + overlay previews from the specimen PDF (read-only on DATASETS_DIR)"
	@echo "make schemas - regenerate packages/schema/pages/*.json (OVERWRITES hand edits)"
	@echo "make eval   - score predictions against the ground truth, e.g. make eval ARGS='--extractor empty --split verify'"
	@echo "make smoke  - latency probe against a local runtime (needs MODEL, see tools/smoke/README.md)"

check:
	node tools/check-datasets.mjs
	npm run typecheck -w @care-agent/schema
	$(MAKE) test

test:
	npm test -w @care-agent/schema
	node --test tools/
	python3 -m unittest discover -s tools/eval

pages:
	node tools/eval/dedupe.mjs
	node tools/eval/split.mjs

truth:
	python3 tools/eval/extract_pdf.py
	python3 tools/eval/zones.py
	python3 tools/eval/zones_preview.py

# Bootstrap only: the generated JSON is then hand-editable, and re-running this OVERWRITES those edits.
schemas:
	node tools/eval/build_schemas.mjs

eval:
	node tools/eval/run.mjs $(ARGS)

smoke:
	python3 tools/smoke/crop.py
	node tools/smoke/probe.mjs
