.PHONY: check test pages smoke help

help: ## List targets
	@echo "make check  - dataset guard + typecheck + tests"
	@echo "make test   - schema tests + tools tests"
	@echo "make pages  - dedupe the specimen PNGs and write the 3-way patient split (tools/eval/data)"
	@echo "make smoke  - latency probe against a local runtime (needs MODEL, see tools/smoke/README.md)"

check:
	node tools/check-datasets.mjs
	npm run typecheck -w @care-agent/schema
	$(MAKE) test

test:
	npm test -w @care-agent/schema
	node --test tools/

pages:
	node tools/eval/dedupe.mjs
	node tools/eval/split.mjs

smoke:
	python3 tools/smoke/crop.py
	node tools/smoke/probe.mjs
