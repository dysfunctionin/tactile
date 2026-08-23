# Test subtree instructions

These rules apply under `tests/` in addition to root guidance.

## Layout

| Path               | Holds                                                        |
| ------------------ | ------------------------------------------------------------ |
| `tests/harness/`   | The templates. Generic and app-agnostic. Rarely edited.      |
| `tests/scenarios/` | Scenario setups: the situations a test can run against.      |
| `tests/cases/`     | The tests themselves, grouped by feature area.               |
| `tests/fixtures/`  | Static input data, such as the compatibility workspace JSON. |

Assertions never belong in `scenarios/`. Building a workspace inline in `cases/` is wrong when a scenario already
describes that situation.

## Adding a test

1. Pick the feature folder under `tests/cases/`, or add one named after the feature.
2. Declare the suite once at the top of the file, then write scenarios.

```js
import assert from "node:assert/strict";

import { defineSuite } from "../../harness/index.mjs";
import { largeSheet } from "../../scenarios/large-sheet.mjs";

const scenario = defineSuite({ type: "unit", suite: "sheet" });

// The default setup is the blank app, so nothing extra is needed.
scenario("column insert shifts trailing cells", () => {
  assert.ok(true);
});

// Opt into a heavier situation, and raise the limit only when the work is genuinely slow.
scenario("large sheet keeps an edit bounded", { setup: largeSheet, timeoutMs: 120_000 }, ({ rootSheet, spec }) => {
  assert.equal(spec.formulaCount, 25_000);
  assert.ok(Object.keys(rootSheet.cells).length > 0);
});
```

`type` is one of `unit`, `compatibility`, `platform`, `sites`, `e2e`, `visual`, `performance`, `benchmark`. `suite` is
the feature area. Both are explicit so results group correctly without depending on folder names.

## Timing individual actions

A scenario reports one duration for its body. When the per-action cost matters, wrap each action in `step`, which
records its own name, status, and duration:

```js
scenario("row edits stay responsive", { setup: largeSheet }, async ({ rootSheet, step }) => {
  const engine = await step("build formula engine", () => new FormulaEngine(rootSheet));
  await step("insert a row", () => shiftCells(rootSheet, "row", 10));
  await step("delete a row", () => removeSheetAxisCells(rootSheet, "row", 10));
});
```

Steps appear on the record under `steps` and are retained per run in `history.json`, so a dashboard can graph a single
action over time instead of only the scenario total.

Browser scenarios need no `step` calls: the harness wraps `page` and times every interaction automatically. Add `step`
only to name something the proxy cannot see, such as a scroll performed through `evaluate`.

## Writing browser scenarios

Match the app rather than guessing at it:

- Sheet cells carry `data-object-id` themselves. Use `.sheet-cell[data-object-id="<id>"]`, never
  `[data-object-id="<id>"] .sheet-cell`, which matches nothing and makes a count assertion pass vacuously.
- Typing into a cell needs `dblclick()` then `.cell-inline-editor`; `click()` plus `keyboard.type()` does not enter
  edit mode and the cell keeps its old value.
- Scroll through the surface: `page.locator("[data-sheet-scroll]").last().evaluate((el) => el.scrollTo({ top }))`.
- Pair every upper bound with a lower bound. `expect(count).toBeLessThan(5_000)` alone passes when the selector is
  wrong and the count is zero.

Heavy scenarios materialize a ~25 MB workspace under `test-results/scenarios/`, cached across scenarios. Delete that
folder to force a rebuild.

## Reading results in the terminal

```bash
npm run test:report                          # summary table plus the slowest actions
npm run test:steps                           # per-action breakdown for every timed scenario
npm run test:steps -- --scenario 250k        # filter by scenario, suite, type, or file
npm run test:trend -- --scenario 250k        # duration across the retained runs
npm run test:failures                        # failures with their first error line
```

Running `npx playwright` directly does not clear shards, so stale results from earlier attempts are merged into the
next report. Use `npm run test:e2e` or `node tests/harness/run.mjs ...` when the numbers matter.

## Dashboard

`npm run dashboard` serves `test-dashboard/` and charts the retained runs: latest duration, change against the previous
run, change against the best previous run, and per-action bars. Its hot-topic section is configured in
`test-dashboard/src/config.js`; point it at whatever is being optimised. The dashboard reads only `history.json` and
`summary.json`, so it also accepts a remote base URL and can be lifted into its own repository unchanged.

Browser tests are the same apart from the import and the `*.e2e.spec.mjs` suffix:

```js
import { expect } from "@playwright/test";
import { defineSuite } from "../../harness/playwright.mjs";

const scenario = defineSuite({ type: "e2e", suite: "themes" });

scenario("applies a built-in theme", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".sheet-cell").first()).toBeVisible();
});
```

## Adding a scenario

Reuse an existing scenario first. When the situation is genuinely new, define it with the template so it reports like
every other scenario, then export it from `tests/scenarios/index.mjs`:

```js
import { defineScenarioSetup } from "../harness/scenario-setup.mjs";

export const nestedLayers = defineScenarioSetup({
  id: "nested-layers",
  label: "workspace five embeds deep",
  materialize() {
    const workspace = buildWorkspace();
    return { workspace, counts: { objects: Object.keys(workspace.objects).length } };
  },
});
```

Whatever `materialize()` returns is passed to the test body. Returning `counts`, `fingerprint`, or `artifactPath` adds
them to the result record. Call `ensureArtifactDir()` when the scenario has to write sample files for the app to open.

## Results

Every scenario records type, suite, scenario, file, status (`pass`, `fail`, `timeout`, `skipped`), `durationMs`,
`timeoutMs`, `timeoutRatio`, and its setup summary. `durationMs` measures the scenario body; setup time is reported
separately under `setup.durationMs`. Runs write `test-results/results.ndjson` and `test-results/summary.json`, and
`test-results/history.json` keeps the last five runs per scenario so duration and status can be graphed over time. All
three stay out of commits.

```bash
npm run tests:all        # build, run every test type, and write one aggregate history entry
npm run test:unit        # unit + compatibility
npm run test:platform    # browser and Tauri adapters
npm run test:sites       # worker and packaging (run npm run build first)
npm run test:performance # release budgets
npm run test:e2e         # browser scenarios
npm run test:report      # rebuild the report from the last run
```

Suites are selected by declared `type` through `--types` on `tests/harness/run.mjs`, not by folder.

## Rules

- Name a scenario after the behaviour under test, not a wave, phase, or ticket.
- Do not weaken assertions, budgets, or timeouts to make a run pass; a rising `timeoutRatio` is a real signal.
- Keep generated reports and screenshots out of commits.
