# Test subtree instructions

These rules apply under `tests/` in addition to root guidance.

- Read `.agents/workflows/testing.md` and the source owner before changing assertions.
- `npm test` covers only `tests/unit/**`; every other suite is explicit.
- Place a new test by owning source area: `unit/core`, `unit/sheet`, `unit/objects`, `unit/shell`, `unit/workspace`, `unit/workers`, `unit/platform`, `unit/release`.
- Explicit suites: `compatibility/` (portable format), `platform/` (browser and Tauri adapters), `sites/` (worker and packaging), `e2e/`, `visual/`, `performance/` (runners plus `performance/benchmarks/`).
- Name files after the behavior under test, not a wave, phase, or ticket identifier.
- Match the test level to behavior: pure Node tests first, Playwright for rendered interaction, native tests for Rust/platform contracts, performance suites for budgets.
- Preserve failure evidence; do not weaken assertions, timeouts, or budgets without a documented behavior change.
- Keep generated reports, screenshots, and `test-results` out of commits unless they are intentional baselines/evidence.
