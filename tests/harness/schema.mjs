import process from "node:process";

export const SCHEMA_VERSION = 1;

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

// Deliberately generous until a full green run establishes real per-type
// durations; tighten from the observed p95 rather than by guessing.
export const DEFAULT_TIMEOUT_MS = Object.freeze({
  unit: 600_000,
  compatibility: 600_000,
  platform: 600_000,
  sites: 600_000,
  e2e: 120_000,
  visual: 120_000,
  performance: 1_800_000,
  benchmark: 1_800_000,
});

// A scenario whose duration approaches its timeout is a flake waiting to
// happen, so the ratio is reported for every scenario and gated in CI.
export const DEFAULT_TIMEOUT_RATIO_LIMIT = 0.75;

export function roundMs(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

export function timeoutFor(type, override) {
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_TIMEOUT_MS[type] ?? DEFAULT_TIMEOUT_MS.unit;
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
  setup = null,
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
    status,
    durationMs: duration,
    timeoutMs,
    timeoutRatio: timeoutMs > 0 && duration !== null ? roundMs(duration / timeoutMs) : null,
    setup,
    metrics,
    error,
    startedAt,
  };
}
