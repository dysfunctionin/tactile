# Testing workflow

Reproduce failures before editing when practical. Prefer checks in this order:

1. Exact failing test or behavior.
2. Focused test file for the touched module.
3. Typecheck/lint/build for the touched surface.
4. Broader suite matching the change risk.

`npm run test:unit` runs unit and compatibility scenarios. `npm run test:all` builds once, runs every test type, and
aggregates them under one dashboard history entry. Do not weaken assertions or budgets without evidence. Use Playwright
for rendered interaction and screenshot evidence where layout matters. Report unrelated existing failures separately.

See local `tests/AGENTS.md` for suite routing.
