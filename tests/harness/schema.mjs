import process from "node:process";
import { performance } from "node:perf_hooks";

import { instrumentObject } from "./instrument.mjs";

// 2 adds `runtime`, which also joins the history key, so older history cannot
// be merged with new runs and is discarded on first report.
export const SCHEMA_VERSION = 2;

export const TEST_TYPES = Object.freeze([
  "unit",
  "compatibility",
  "platform",
  "sites",
  "e2e",
  "visual",
  "performance",
  "benchmark",
]);

export const STATUS = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  TIMEOUT: "timeout",
  SKIPPED: "skipped",
});

// Which build a scenario measured. Headless suites exercise `src/core/` with no
// platform adapter, so they are neither and stay "agnostic".
export const RUNTIMES = Object.freeze(["web", "native", "agnostic"]);

export const DEFAULT_RUNTIME = "agnostic";

// Types that reach a platform adapter, so the same scenario can be measured per
// runtime and the two results are not comparable to each other's budgets.
export const RUNTIME_SENSITIVE_TYPES = Object.freeze(["e2e", "visual", "sites"]);

export function assertRuntime(runtime) {
  if (!RUNTIMES.includes(runtime)) {
    throw new TypeError(`Unknown test runtime "${runtime}". Expected one of ${RUNTIMES.join(", ")}.`);
  }
  return runtime;
}

export function selectedRuntime(type) {
  if (!RUNTIME_SENSITIVE_TYPES.includes(type)) return DEFAULT_RUNTIME;
  return assertRuntime(process.env.TACTILE_TEST_RUNTIME || "web");
}

// Derived from a full green run: roughly four times the observed maximum per
// type, with a 5s floor. Setup time is reported separately and not included.
export const DEFAULT_TIMEOUT_MS = Object.freeze({
  unit: 8_000,
  compatibility: 8_000,
  platform: 5_000,
  sites: 5_000,
  e2e: 323_000,
  visual: 323_000,
  performance: 5_000,
  benchmark: 300_000,
});

// A scenario whose duration approaches its timeout is a flake waiting to
// happen, so the ratio is reported for every scenario and gated in CI.
export const DEFAULT_TIMEOUT_RATIO_LIMIT = 0.75;

// Runs retained per scenario so a dashboard can plot duration and status trends.
export const HISTORY_LIMIT = 5;

export function roundMs(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

export function timeoutFor(type, override) {
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_TIMEOUT_MS[type] ?? DEFAULT_TIMEOUT_MS.unit;
}

/**
 * Times named actions inside a scenario so a run reports each operation, not
 * just the total. Failures still record the elapsed time before rethrowing.
 */
export function createStepRecorder() {
  const steps = [];
  async function step(name, action) {
    const started = performance.now();
    let status = STATUS.PASS;
    try {
      return await action();
    } catch (error) {
      status = STATUS.FAIL;
      throw error;
    } finally {
      steps.push({ name, status, durationMs: roundMs(performance.now() - started) });
    }
  }
  step.instrument = (target, label) => instrumentObject(target, step, label);
  return { step, steps };
}

export function assertType(type) {
  if (!TEST_TYPES.includes(type)) {
    throw new TypeError(`Unknown test type "${type}". Expected one of: ${TEST_TYPES.join(", ")}`);
  }
  return type;
}

// Types live in the files rather than the folder names, so selection is a
// runtime filter instead of a path glob.
export function typeSelected(type) {
  const requested = process.env.TACTILE_TEST_TYPES;
  if (!requested) return true;
  return requested
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(type);
}

export function createRecord({
  runId,
  type,
  suite,
  scenario,
  file,
  status,
  durationMs,
  timeoutMs,
  runtime = DEFAULT_RUNTIME,
  setup = null,
  steps = null,
  metrics = null,
  error = null,
  startedAt,
}) {
  const duration = roundMs(durationMs);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    type,
    suite,
    scenario,
    file,
    runtime: assertRuntime(runtime),
    status,
    durationMs: duration,
    timeoutMs,
    timeoutRatio: timeoutMs > 0 && duration !== null ? roundMs(duration / timeoutMs) : null,
    setup,
    steps,
    metrics,
    error,
    startedAt,
  };
}
