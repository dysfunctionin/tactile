# 06 — Nested open/close (embedded sheets)

## Current time
From suite runs (`nested` = 10-level embed open/close cycle; median, one repeat):

| Profile | baseline | final-opt | frame p95 baseline → final | longtasks |
|---|---|---|---|---|
| low | 8819 ms | 8761 ms | 16.8 → 33.3 ms | 1 |
| high | 20895 ms | 20176 ms | 250 → 217 ms | 37 |

Per level that's ~0.9 s (low) / ~2.0 s (high).

## Why it is slow (measured foundations in `11`/`10`)
Each open/close level performs several workspace commits, and every commit pays the same taxes;
the root sheet's engine is rebuilt on first open:

1. **First open of the formula-dense root sheet** eagerly builds + recalcs the engine (~6.2 s
   measured; `11-formula-engine.md`). Layer sheets (30k cells, 0 formulas) build cheaply but the
   whole chain re-renders on each open.
2. **Every transition commit pays the engine + differential + stringify taxes** (~1.4 s engine +
   ~2.6 s differential on the high fixture; `10-single-edit-latency.md`).
3. **Creating each embedded sheet** goes through `createEmbeddedObject` → `commitWorkspace` with
   `repairTopology=true` and a full `structuredClone(workspace)` undo snapshot
   (`useLocalWorkspace.js:56-69,419-459`) — ~0.6 s per embed on the fixture.
4. **Duplicate formula workers** spin up per formula sheet (`shadow.js:287-329`).
5. Layer re-render (`App.jsx` stack) re-runs projections for any sheet identity change.

## Plan
- **`11` engine**: lazy band-first engine build (open a level without building the full graph) +
  change-selective recalculation → cuts both the first-open and per-commit costs.
- **`10` differential**: gate diagnostics off the hot path + coalesce reconcile + throttle cache →
  per-level commit drops from ~4 s to tens of ms.
- **P3/P4** Delta undo instead of `structuredClone`; one engine for the navigation stack; engines
  for non-visible layers initialize in idle.
- **P2** Journal-driven projections so opening a level doesn't rescan every sheet.

## Expected time
- low: **≤ 5000 ms** for 10 levels (≤ 500 ms/level); high: **≤ 10000 ms** (≤ 1 s/level) with frame p95 ≤ 33 ms in the cycle.

## Gate
`npm run bench:suite -- --profiles low,high --repeats 2 --label nested` — pass if low ≤ 5000 ms, high ≤ 10000 ms, and P0 stage timers show each level's commit < 300 ms.