const STAGE_PREFIX = "tactile:stage:";

// The perf suite reads these through a PerformanceObserver on "measure".
// performance.measure is a no-op cost when nothing observes it, so this stays
// on in production rather than hiding behind a build flag.
export function measureStage(name, run) {
  if (typeof performance?.measure !== "function") return run();
  const started = performance.now();
  try {
    return run();
  } finally {
    try {
      performance.measure(`${STAGE_PREFIX}${name}`, { start: started, end: performance.now() });
    } catch {
      // Measure entries are best-effort diagnostics.
    }
  }
}

export async function measureStageAsync(name, run) {
  if (typeof performance?.measure !== "function") return run();
  const started = performance.now();
  try {
    return await run();
  } finally {
    try {
      performance.measure(`${STAGE_PREFIX}${name}`, { start: started, end: performance.now() });
    } catch {
      // Measure entries are best-effort diagnostics.
    }
  }
}

export { STAGE_PREFIX };
