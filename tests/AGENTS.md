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
`timeoutMs`, `timeoutRatio`, and its setup summary. Runs write `test-results/results.ndjson` and
`test-results/summary.json`; both stay out of commits.

```bash
npm test                 # unit scenarios
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
