import { performance } from "node:perf_hooks";

function percentile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

// Timers only advance between samples, so a case that mutates shared state
// rebuilds it in `prepare` without that cost landing in the measurement.
export async function runCase(descriptor, context) {
  const { name, budgetMs, unit = "ms", warmup = 3, iterations = 10, prepare, run, note, phase } = descriptor;
  const setupStart = performance.now();
  const state = descriptor.setup ? await descriptor.setup(context) : null;
  const setupMs = performance.now() - setupStart;

  const samples = [];
  const total = warmup + iterations;
  for (let index = 0; index < total; index += 1) {
    const iterationState = prepare ? await prepare(state, context, index) : state;
    const started = performance.now();
    await run(iterationState, context, index);
    const elapsed = performance.now() - started;
    if (index >= warmup) samples.push(elapsed);
  }

  const median = percentile(samples, 0.5);
  return {
    name,
    unit,
    phase: phase || null,
    note: note || null,
    iterations: samples.length,
    setupMs: round(setupMs),
    medianMs: round(median),
    p95Ms: round(percentile(samples, 0.95)),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
    budgetMs,
    status: !Number.isFinite(budgetMs) ? "informational" : median <= budgetMs ? "pass" : "fail",
  };
}

export function formatRow(result) {
  const status = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "----";
  const budget = Number.isFinite(result.budgetMs) ? `${result.budgetMs}` : "n/a";
  return [
    status.padEnd(4),
    result.name.padEnd(28),
    `${result.medianMs}`.padStart(10),
    `${result.p95Ms}`.padStart(10),
    budget.padStart(8),
    result.phase ? ` (${result.phase})` : "",
  ].join("  ");
}
