# 02 — Import + first render

## Current time
From suite runs (median, one repeat). `import-profile` seeds a fixture then measures first render:

| Profile | duration baseline | duration final-opt | frame p95 baseline → final |
|---|---|---|---|
| low | 1497 ms | 1532 ms | 66.7 → 33.4 ms |
| high | 12790 ms | 10945 ms | 100 → 1100 ms* |

\* High import's frame p95 is a first-paint spike of the 250k fixture; most frames are fine.

## Why it is slow (measured on the high fixture)
Import (fixture load) = JSON parse + normalize + first render. The first render **blocks for ~6.2 s
building and evaluating the formula engine**, which dominates the 10.9 s:

1. **Engine graph build ~3.6 s + full `recalculateAll` ~2.7 s** on first render of the root sheet
   (25k formulas) — `useFormulaProjection` builds the engine eagerly and recalculates everything
   (`useFormulaProjection.js:29-40`, `formulas.js:983-991`, see `11-formula-engine.md`). ~6.2 s
   synchronous, before first paint.
2. **Boot normalization runs several times ~0.7 s each**: import → `normalizeWorkspace` +
   `replaceWorkspace`, then the shadow re-normalizes and the engine store rebuilds (`model.js:368`,
   `shadow.js:244-267`), then the hydration effect re-clones (`useLocalWorkspace.js:234-236`).
3. **Shadow/persistence absorb the full transition**: the whole fixture diff + a ~250k-record
   engine/persistence pass (`shadow.js`, `browser/persistence.js`).
4. **JSON.parse ~0.4 s** of the 27.8 MB fixture; first render also awaits virtualization + scans.

## Plan
- **`11` engine (main)**: lazy engine build — parse/register only the visible band first; evaluate
  the rest in idle chunks or on a worker. Removes ~6 s of the synchronous wall.
- **P1/P10** Reduce boot to a single normalization; short-circuit normalize via identity cache; gate
  the differential diagnostics; don't re-clone the snapshot in the hydration effect.
- **P4** One engine; feed the shadow/worker the journaled delta (never a full re-serialize).
- **P2** Journal-init projections so first paint after import isn't O(cells) scans.

## Expected time
- low: **≤ 900 ms**; high: **≤ 3500 ms** (from 10945 ms).

## Gate
`npm run bench:suite -- --profiles low,high --repeats 3 --label import` — pass if high < 4000 ms, low < 900 ms, and no per-commit main-thread stall > 50 ms during the import (measured by P0 stage timers).