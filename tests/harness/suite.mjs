import nodeTest from "node:test";
import { performance } from "node:perf_hooks";

import { blankApp } from "../scenarios/blank-app.mjs";
import { STATUS, assertType, createRecord, roundMs, timeoutFor, typeSelected } from "./schema.mjs";
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
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Test template.
 *
 * Binds a test type and suite once per file, then every scenario in that file
 * runs its setup, executes the body, and records one uniform result.
 */
export function defineSuite({ type, suite, setup: suiteSetup = blankApp }) {
  assertType(type);
  if (typeof suite !== "string" || !suite) throw new TypeError("defineSuite requires a suite name");

  function scenario(name, optionsOrFn, maybeFn) {
    const options = typeof optionsOrFn === "function" ? {} : (optionsOrFn ?? {});
    const body = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    if (typeof body !== "function") throw new TypeError(`Scenario "${name}" requires a test function`);
    if (!typeSelected(type)) return undefined;

    const setup = options.setup ?? suiteSetup;
    const timeoutMs = timeoutFor(type, options.timeoutMs);
    const file = repoRelative(options.file || callerFile());

    // The harness owns the timeout so status is Pass/Fail/Timeout everywhere;
    // the runner's own limit stays slack so ours reports first.
    return nodeTest(name, { timeout: timeoutMs * 2, skip: options.skip }, async (t) => {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      let status = STATUS.PASS;
      let error = null;
      let setupSummary = null;
      let prepared = null;

      try {
        if (setup) {
          const result = await setup.run();
          prepared = result.context;
          setupSummary = result.summary;
        }
        const outcome = await withTimeout(Promise.resolve(body({ ...prepared, t, scenario: name })), timeoutMs);
        if (outcome && typeof outcome === "object" && outcome.metrics) options.metrics = outcome.metrics;
      } catch (caught) {
        status = caught instanceof ScenarioTimeoutError ? STATUS.TIMEOUT : STATUS.FAIL;
        error = { message: String(caught?.message || caught), failureType: caught?.name || "Error" };
        throw caught;
      } finally {
        if (setup?.teardown) await setup.teardown(prepared);
        appendRecord(
          createRecord({
            runId: currentRunId(),
            type,
            suite,
            scenario: name,
            file,
            status,
            durationMs: roundMs(performance.now() - started),
            timeoutMs,
            setup: setupSummary,
            metrics: options.metrics ?? null,
            error,
            startedAt,
          }),
        );
      }
    });
  }

  scenario.skip = (name, optionsOrFn, maybeFn) => {
    const options = typeof optionsOrFn === "function" ? {} : (optionsOrFn ?? {});
    return scenario(name, { ...options, skip: true }, typeof optionsOrFn === "function" ? optionsOrFn : maybeFn);
  };

  return scenario;
}
