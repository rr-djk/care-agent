.PHONY: check test pages truth schemas eval predict smoke quality-eval server pwa certs help

help: ## List targets
	@echo "make check  - dataset guard + typecheck + tests"
	@echo "make test   - schema tests + tools tests"
	@echo "make pages  - dedupe the specimen PNGs and write the 3-way patient split (tools/eval/data)"
	@echo "make truth  - ground truth + zones + overlay previews from the specimen PDF (read-only on DATASETS_DIR)"
	@echo "make schemas - regenerate packages/schema/pages/*.json (OVERWRITES hand edits)"
	@echo "make eval   - score predictions against the ground truth, e.g. make eval ARGS='--extractor empty --split verify'"
	@echo "make predict - run the analyzer on specimen pages and write eval-results/predictions-<ts>.json, e.g. make predict ARGS='--split tune --pages p3 --limit 1'"
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

predict:
	npm run predict -w @care-agent/server -- $(ARGS)

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
