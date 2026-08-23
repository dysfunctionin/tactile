/**
 * Derives comparison metrics from a scenario's retained runs.
 *
 * `runs` arrive newest first. "previous best" deliberately excludes the current
 * run so an improvement is measured against history, not against itself.
 */
export function scenarioMetrics(entry) {
  const runs = entry.runs || [];
  const durations = runs.map((run) => run.durationMs).filter((value) => Number.isFinite(value));
  const current = durations[0] ?? null;
  const earlier = durations.slice(1);
  const previous = earlier[0] ?? null;
  const previousBest = earlier.length ? Math.min(...earlier) : null;
  const previousWorst = earlier.length ? Math.max(...earlier) : null;

  return {
    current,
    previous,
    previousBest,
    previousWorst,
    runCount: durations.length,
    min: durations.length ? Math.min(...durations) : null,
    max: durations.length ? Math.max(...durations) : null,
    average: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    deltaVsPrevious: percentChange(current, previous),
    deltaVsBest: percentChange(current, previousBest),
    status: runs[0]?.status ?? "unknown",
    statuses: runs.map((run) => run.status),
    isBest: current !== null && previousBest !== null && current < previousBest,
    isWorst: current !== null && previousWorst !== null && current > previousWorst,
  };
}

/** Negative means faster than the comparison point. */
export function percentChange(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

export function stepComparison(entry) {
  const runs = entry.runs || [];
  const current = runs[0]?.steps || [];
  const previous = new Map((runs[1]?.steps || []).map((step) => [step.name, step.durationMs]));
  return current.map((step) => ({
    ...step,
    previousMs: previous.get(step.name) ?? null,
    delta: percentChange(step.durationMs, previous.get(step.name)),
  }));
}

export function formatMs(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 1) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(3)} ms`;
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

/** Faster is better, so a negative change is an improvement. */
export function trendClass(value) {
  if (!Number.isFinite(value)) return "neutral";
  if (value <= -5) return "better";
  if (value >= 5) return "worse";
  return "steady";
}

export function verdict(metrics) {
  if (metrics.status !== "pass") return `last run ${metrics.status}`;
  if (metrics.runCount < 2) return "first recorded run, no comparison yet";
  if (metrics.isBest) return "fastest run on record";
  if (metrics.isWorst) return "slowest run on record";
  const delta = metrics.deltaVsPrevious;
  if (!Number.isFinite(delta)) return "no comparable previous run";
  if (delta <= -5) return `${formatPercent(delta)} faster than the previous run`;
  if (delta >= 5) return `${formatPercent(delta)} slower than the previous run`;
  return "holding steady against the previous run";
}
