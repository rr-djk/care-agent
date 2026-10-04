.PHONY: check test pages truth schemas eval predict degrade calibrate quality-curve report eval-full smoke quality-eval server pwa certs help

# Python reads files as UTF-8 on every OS (Windows defaults to cp1252: "Néant" in normalize_cases.json was misread).
export PYTHONUTF8 = 1

help: ## List targets
	@echo "make check  - dataset guard + typecheck + tests"
	@echo "make test   - schema tests + tools tests"
	@echo "make pages  - dedupe the specimen PNGs and write the 3-way patient split (tools/eval/data)"
	@echo "make truth  - ground truth + zones + overlay previews from the specimen PDF (read-only on DATASETS_DIR)"
	@echo "make schemas - regenerate packages/schema/pages/*.json (OVERWRITES hand edits)"
	@echo "make eval   - score predictions against the ground truth, e.g. make eval ARGS='--extractor empty --split verify'"
	@echo "make predict - run the analyzer on specimen pages and write eval-results/predictions-<ts>.json, e.g. make predict ARGS='--split tune --pages p3 --limit 1'"
	@echo "make degrade - graded degraded variants of specimen pages into data/degraded/ + manifest, e.g. make degrade ARGS='--split calibrate --pages p2,p4 --variants blur-s2,glare'"
	@echo "make calibrate - fit the per-category confidence table on the calibrate split, e.g. make calibrate ARGS='--pred eval-results/predictions-<ts>.jsonl'"
	@echo "make quality-curve - accuracy vs gate metrics from predictions on variants, e.g. make quality-curve ARGS='--pred eval-results/predictions-<ts>.jsonl'"
	@echo "make report - final markdown report from verify predictions, e.g. make report ARGS='--pred eval-results/predictions-<ts>.jsonl[,photo.jsonl] [--publish]'"
	@echo "make eval-full - (documented, long) predict calibrate + variants, calibrate, predict verify, report: see docs/calibration.md"
	@echo "make quality-eval - run the image-quality gate on the specimens, the real photos and synthetic degradations (outputs in eval-results/quality/)"
	@echo "make server - start the API server on PORT (default 8787), data in DATA_DIR (default ./data)"
	@echo "make pwa    - start the PWA dev server on 0.0.0.0:5173 (HTTPS when data/certs exist), /api proxied to API_URL"
	@echo "make certs  - mkcert certificate for localhost + this machine's LAN IPs into data/certs (run 'mkcert -install' yourself once)"
	@echo "make smoke  - latency probe against a local runtime (needs MODEL, see tools/smoke/README.md)"

check:
	node tools/check-datasets.mjs
	npm run typecheck -w @care-agent/schema
	npm run typecheck -w @care-agent/quality
	npm run typecheck -w @care-agent/server
	npm run typecheck -w @care-agent/pwa
	$(MAKE) test

test:
	npm test -w @care-agent/schema
	npm test -w @care-agent/quality
	npm test -w @care-agent/server
	npm test -w @care-agent/pwa
	node --import tsx --test $(wildcard tools/*.test.mjs tools/*/*.test.mjs)
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

predict:
	npm run predict -w @care-agent/server -- $(ARGS)

# ARGS (all steps): flags of the script, see its header and docs/calibration.md. `make predict` ARGS also take
# --variants all|ids, --no-clean, --real 1-1 (see apps/server/src/cli/predict.ts).
degrade:
	node --import tsx tools/eval/degrade.mjs $(ARGS)

calibrate:
	node --import tsx tools/eval/calibrate.mjs $(ARGS)

quality-curve:
	node --import tsx tools/eval/quality-curve.mjs $(ARGS)

report:
	node --import tsx tools/eval/report.mjs $(ARGS)

# Documented, NOT run by `make check` (hours on the CPU laptop, one Ollama, never two at once). Edit the page lists to fit your time.
# Estimates (Intel Core 7 150U, gemma4:e4b, ~20-40 s per zone, cache hits free): see "Long runs" in docs/calibration.md.
# Run the steps in order and give each the file written by the previous predict (`ls -t eval-results/predictions-*.jsonl`).
eval-full:
	$(MAKE) degrade ARGS='--split calibrate --pages p4,p6 --variants blur-s1,blur-s2,blur-s4,motion-15,dark-0.6,dark-0.4,glare,jpeg-q30,down-0.5,persp-mild'
	$(MAKE) predict ARGS='--split calibrate --variants all'
	$(MAKE) calibrate ARGS="--pred $$(ls -t eval-results/predictions-*.jsonl | head -1)"
	$(MAKE) quality-curve ARGS="--pred $$(ls -t eval-results/predictions-*.jsonl | head -1)"
	$(MAKE) predict ARGS='--split verify --real 1-1'
	$(MAKE) report ARGS="--pred $$(ls -t eval-results/predictions-*.jsonl | head -1)"

server:
	npm run dev -w @care-agent/server

pwa:
	npm run dev -w @care-agent/pwa

quality-eval:
	node --import tsx tools/quality-eval.mjs

# Needs mkcert installed and its root CA set up once by the user (`mkcert -install`); the phone must trust that CA.
certs:
	mkdir -p data/certs
	mkcert -key-file data/certs/key.pem -cert-file data/certs/cert.pem localhost 127.0.0.1 $$(hostname -I)

smoke:
	python3 tools/smoke/crop.py
	node tools/smoke/probe.mjs
