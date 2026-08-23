# Quality and performance knowledge

Use with `.agents/workflows/testing.md` for QA, performance, or certification tasks.

- Tests live in `tests/cases/` grouped by feature; `tests/scenarios/` owns setup and `tests/harness/` owns the templates.
- Every scenario declares `type` and `suite`; suites are selected by type, not by folder.
- Runs emit `test-results/results.ndjson` and `test-results/summary.json` with status, duration, timeout, and setup detail.
- Browser interaction uses the Playwright configuration under `config/playwright/`.
- Performance budgets live in `tests/harness/measurement.mjs` and are asserted by the `performance` scenarios.
- Preserve sparse/virtualized sheet behavior, bounded mounted cells, input latency, and bundle budgets.
- Do not replace measured baselines or certification evidence without recording environment, command, commit, and comparison.
- A checked-in report is evidence from its recorded run, not a timeless certification.

Current visual assets under `images/` are retained evidence. Read only the artifact relevant to the metric being investigated.
