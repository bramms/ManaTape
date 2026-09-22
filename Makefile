PYTHON ?= .venv/bin/python
NODE ?= node
.PHONY: install test check demo
install:
	python3 -m venv .venv
	.venv/bin/pip install -r requirements.txt
test:
	$(PYTHON) -m unittest -q test_forge.py test_profile_modes.py test_benchmarks.py test_projects.py
	$(NODE) --test test_tape.cjs test_operator.cjs test_display.cjs test_evidence.cjs
check:
	$(PYTHON) -m py_compile server.py profile_modes.py insights.py benchmark_sources.py mac-preview.py tools/dev_fixture.py
	@for file in static/*.js; do $(NODE) --check "$$file" || exit 1; done
demo:
	$(PYTHON) tools/dev_fixture.py --serve
