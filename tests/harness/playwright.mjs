import { performance } from "node:perf_hooks";

import { test as playwrightTest } from "@playwright/test";

import { STATUS, assertType, createRecord, createStepRecorder, roundMs, timeoutFor, typeSelected } from "./schema.mjs";
import { appendRecord, currentRunId, repoRelative } from "./writer.mjs";
import { callerFile } from "./caller.mjs";

class ScenarioTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Scenario exceeded its ${timeoutMs} ms timeout`);
    this.name = "ScenarioTimeoutError";
  }
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new ScenarioTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Browser flavour of the test template.
 *
 * Mirrors defineSuite() but forwards Playwright fixtures, so a browser scenario
 * records the same shape as a node one.
 */
export function defineSuite({ type = "e2e", suite, setup = null }) {
  assertType(type);
  if (typeof suite !== "string" || !suite) throw new TypeError("defineSuite requires a suite name");

  function scenario(name, optionsOrFn, maybeFn) {
    const options = typeof optionsOrFn === "function" ? {} : (optionsOrFn ?? {});
    const body = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    if (typeof body !== "function") throw new TypeError(`Scenario "${name}" requires a test function`);

    const scenarioSetup = options.setup ?? setup;
    const timeoutMs = timeoutFor(type, options.timeoutMs);
    if (!typeSelected(type)) return undefined;
    const file = repoRelative(options.file || callerFile());

    // Playwright parses this parameter list to decide which fixtures to build,
    // so it must stay a literal destructuring pattern.
    return playwrightTest(name, async ({ page, context, browserName }, testInfo) => {
      // Keep Playwright's limit just above the harness limit so the harness
      // reports the timeout first.
      playwrightTest.setTimeout(timeoutMs + 30_000);
      const startedAt = new Date().toISOString();
      let status = STATUS.PASS;
      let error = null;
      let setupSummary = null;
      let prepared = null;
      let bodyStarted = performance.now();
      const { step, steps } = createStepRecorder();

      try {
        if (scenarioSetup) {
          const result = await scenarioSetup.run();
          prepared = result.context;
          setupSummary = result.summary;
        }
        // Timed from here so the recorded duration matches what the timeout guards.
        bodyStarted = performance.now();
        await withTimeout(
          Promise.resolve(body({ page, context, browserName, ...prepared, step, testInfo, scenario: name })),
          timeoutMs,
        );
      } catch (caught) {
        status = caught instanceof ScenarioTimeoutError ? STATUS.TIMEOUT : STATUS.FAIL;
        error = { message: String(caught?.message || caught), failureType: caught?.name || "Error" };
        throw caught;
      } finally {
        if (scenarioSetup?.teardown) await scenarioSetup.teardown(prepared);
        appendRecord(
          createRecord({
            runId: currentRunId(),
            type,
            suite,
            scenario: name,
            file: file || repoRelative(testInfo?.file),
            status,
            durationMs: roundMs(performance.now() - bodyStarted),
            timeoutMs,
            setup: setupSummary,
            steps: steps.length ? steps : null,
            metrics: options.metrics ?? null,
            error,
            startedAt,
          }),
        );
      }
    });
  }

  scenario.skip = (name, optionsOrFn, maybeFn) =>
    playwrightTest.skip(name, typeof optionsOrFn === "function" ? optionsOrFn : maybeFn);

  return scenario;
}
