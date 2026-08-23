# Quality and performance knowledge

Use with `.agents/workflows/testing.md` for QA, performance, or certification tasks.

- Tests live in `tests/cases/` grouped by feature; `tests/scenarios/` owns setup and `tests/harness/` owns the templates.
- Every scenario declares `type` and `suite`; suites are selected by type, not by folder.
- Runs emit `test-results/results.ndjson`, `summary.json`, and `history.json` with status, duration, timeout, per-action steps, and setup detail.
- Browser scenarios are timed per interaction automatically; `history.json` keeps the last five runs for trend comparison.
- Read results with `npm run test:report`, `test:steps`, `test:trend`, and `test:failures` rather than ad-hoc scripts.
- `npm run dashboard` charts the same data at http://127.0.0.1:4300/test-dashboard/; read `test-dashboard/AGENTS.md` before editing it.
- The dashboard carries no dependencies and never imports `src/`; keep it liftable into its own repository.
- Browser interaction uses the Playwright configuration under `config/playwright/`.
- Performance budgets live in `tests/harness/measurement.mjs` and are asserted by the `performance` scenarios.
- Interaction latency on heavy workspaces is covered by `tests/cases/e2e/large-sheet-interactions.e2e.spec.mjs`; the first interaction after a large import costs far more than later ones, so compare like with like.
- Preserve sparse/virtualized sheet behavior, bounded mounted cells, input latency, and bundle budgets.
- Do not replace measured baselines or certification evidence without recording environment, command, commit, and comparison.
- A checked-in report is evidence from its recorded run, not a timeless certification.

Current visual assets under `images/` are retained evidence. Read only the artifact relevant to the metric being investigated.
