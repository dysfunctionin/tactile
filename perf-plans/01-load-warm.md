# 01 — Load warm (app start with warm browser cache)

## Current time
From suite runs (median, one repeat):

| Profile | baseline | final-opt | frame p95 |
|---|---|---|---|
| low | 927 ms | 920 ms | — |
| high | fail/timeout (>120 s waiting for A1) | fail/timeout | — |

`high/load-warm` never reaches the first cell within the harness's 120 s window on a warm reload — the 250k-cell fixture restores too slowly. This is a correctness-budget failure, not just a speed issue.

## Why it is slow
`high/load-warm` never reaches first paint within 120 s. Measured pieces on the 250k fixture:

1. **Engine graph build ~3.6 s + full recalc ~2.7 s** sync on first render of the formula-dense
   root sheet (`useFormulaProjection.js:29-40`, see `11-formula-engine.md`). That alone is ~6 s of
   un-painted main thread; combined with the passes below and record-persistence replay on a cold
   warm-reload page, the A1 cell misses its deadline repeatedly.
2. **Boot runs ~4–6 redundant full-workspace passes**: `loadWorkspaceCache` JSON.parse, `loadWorkspace`
   IDB read, `normalizeWorkspace` ×2–3 (`useLocalWorkspace.js:34-45,216-239`), `createWave2Shadow`
   re-normalize + engine store build (`shadow.js:244-267`), and the hydration effect re-clones the
   snapshot (`useLocalWorkspace.js:234-236`). Each normalize is ~658 ms on 250k cells.
3. **Warm-reload persistence replay** (record adapter initialization reads/rebuilds the store).
4. First render also does `autoRowHeights` (~68 ms) + `embeddedTypes` (~53 ms) scans.

## Plan
- **`11` engine (main)**: lazy band-first engine build — parse/register/evaluate only visible
  formulas; the rest evaluates on idle/worker. Removes the ~6 s first-paint block; the A1 cell
  renders immediately.
- **P1/P10** Collapse boot to ONE normalization + identity-cheap normalize short-circuit; skip the
  hydration re-clone; gate the differential diagnostics; skip record-persistence replay until idle
  (the localStorage cache already covers first paint).
- **P6** Native runtime: debounce/pipeline the portable-package rebuild so warm reload doesn't
  re-serialize on entry.

## Expected time
- low: **≤ 900 ms** (currently 920); high: **≤ 4500 ms** measured — the 120 s timeout disappears
  with the lazy engine build, since A1 paints before any full-sheet work.

## Gate
`npm run bench:suite -- --profiles low,high --repeats 3 --label load-warm` — pass if high warm-load median < 4500 ms and low < 900 ms.