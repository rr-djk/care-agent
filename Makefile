.PHONY: check smoke help

help: ## List targets
	@echo "make check  - dataset guard + node tests"
	@echo "make smoke  - latency probe against a local runtime (needs MODEL, see tools/smoke/README.md)"

check:
	node tools/check-datasets.mjs
	node --test tools/

smoke:
	python3 tools/smoke/crop.py
	node tools/smoke/probe.mjs
