# 07 — In/out transition (layer open/close)

## Current time
From suite runs (`in-out` = open sheet as floating layer, close, restore; median, one repeat):

| Profile | baseline | final-opt | frame p95 | input p95 baseline → final | longtasks |
|---|---|---|---|---|---|
| low | 1899 ms | 1917 ms | 33.3 ms | 104 → 96 ms | 1 |
| high | 3548 ms | 3291 ms | 317 ms | 384 → 368 ms | 8 |

## Why it is slow (measured foundations in `11`/`10`)
Opening a layer re-hydrates the whole sheet view while the workspace changes many times:

1. **First open of a formula sheet** eagerly builds + recalcs the engine before paint (~6.2 s on
   the 25k-formula root sheet; `11-formula-engine.md`) — the 317 ms frame spike on high.
2. **Every layer transition commits workspace state** — each pays the engine + shadow differential
   (4× `normalizeWorkspace`) + cache-stringify taxes (`10-single-edit-latency.md`).
3. **Layer stack re-renders the object renderer** for the transitioning sheet plus the previous
   layer's projections; any object identity change re-runs them (`App.jsx` layer stack).
4. Suspended-view memory restore does a scroll + `syncViewport` handoff per open
   (`useVirtualSheet.js:477-528`).

## Plan
- **`11` engine (main)**: lazy band-first engine build and change-selective recalculation (removes
  the 6.2 s first-paint block); keep `autoRowHeights`/`embeddedTypes` journal-driven (`P2`).
- **P1/P10** Coalesce reconcile + cache flush; gate the differential diagnostics; make
  `normalizeWorkspace` an identity-cheap short-circuit.
- **P2.4** Memoize the layer's projection across the transition so re-open doesn't rescan.
- **P4** One engine for the floating layer (no shadow worker mirror re-serialization).
- **P5** Yield between transition work; the layer's engine builds after first paint.

## Expected time
- low: **≤ 1500 ms**; high: **≤ 2200 ms** with first-open frame p95 ≤ 100 ms (from 317 ms) and longtasks ≤ 3.

## Gate
`npm run bench:suite -- --profiles low,high --repeats 2 --label in-out` — pass if high ≤ 2200 ms and the P0 stage timers show no single transition commit > 150 ms.