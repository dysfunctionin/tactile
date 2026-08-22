/**
 * Target values for the 16 GRAPH_METRICS, keyed by metric id. Lower is better
 * for every metric here. Sources:
 *  - WORKFLOW.md §3 budgets / RELEASE_BUDGETS: frameTimeP95 ≤ 16.7ms,
 *    inputToPaintP95 ≤ 50ms, warm launch ≤ 1.5s, no growth after nested cycles.
 *  - Stretch goals (marked "stretch") are the intended end-state after the
 *    optimization backlog in DOC.md §17; the high profile targets account for
 *    the 250k-cell fixture.
 */
export const TARGETS = {
  loadWarm: {
    low: 1500, high: 1500,
    unit: "ms",
    basis: "Workflow: warm launch ≤ 1.5s",
  },
  import: {
    low: 3000, high: 8000,
    unit: "ms",
    basis: "Stretch: import + first render (baseline 1.5s / 12.8s); cold launch ≤ 3s",
  },
  typingDur: {
    low: 2000, high: 4500,
    unit: "ms",
    basis: "Stretch: 24-key burst stays fluid",
  },
  typingP95: {
    low: 50, high: 50,
    unit: "ms",
    basis: "Release budget: input-to-paint p95 ≤ 50ms",
  },
  typingFrame: {
    low: 16.7, high: 16.7,
    unit: "ms",
    basis: "Release budget: frameTimeP95 ≤ 16.7ms",
  },
  formula: {
    low: 1500, high: 10000,
    unit: "ms",
    basis: "Stretch: formula add resolves (no 30s timeout); formula display ≤ 100ms",
  },
  scrollVertDur: {
    low: 2000, high: 3500,
    unit: "ms",
    basis: "Stretch: scripted 72-frame scroll cadence",
  },
  scrollVertFrame: {
    low: 16.7, high: 16.7,
    unit: "ms",
    basis: "Release budget: frameTimeP95 ≤ 16.7ms",
  },
  scrollDiagDur: {
    low: 1500, high: 2000,
    unit: "ms",
    basis: "Stretch: diagonal scroll cadence",
  },
  scrollDiagFrame: {
    low: 16.7, high: 20,
    unit: "ms",
    basis: "Near frame budget; allow small slack on long grids",
  },
  inOut: {
    low: 1500, high: 2500,
    unit: "ms",
    basis: "Stretch: layer open/close transition",
  },
  nested: {
    low: 5000, high: 12000,
    unit: "ms",
    basis: "Stretch: nested open/close cycle",
  },
  addRow: {
    low: 1200, high: 8000,
    unit: "ms",
    basis: "Stretch: insert stays interactive (axis-op remap)",
  },
  addCol: {
    low: 1200, high: 8000,
    unit: "ms",
    basis: "Stretch: insert stays interactive (axis-op remap)",
  },
  memDelta: {
    low: 0, high: 0,
    unit: "MB",
    basis: "Workflow: no growth after 100 nested cycles",
  },
  rssMax: {
    low: 1024, high: 2048,
    unit: "MB",
    basis: "Sanity: stays within machine RAM (15.3 GB)",
  },
};