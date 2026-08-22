# 08 — Scroll (vertical / diagonal)

## Current time
From suite runs (`scroll-vertical` = scripted 72-frame vertical scroll; median, one repeat):

| Scenario | Profile | duration baseline → final | frame p95 baseline → final | input p95 baseline → final | longtasks |
|---|---|---|---|---|---|
| scroll-vertical | low | 2053 → 2083 ms | 33.3 → 33.3 ms | 16 → 24 ms | 1 |
| scroll-vertical | high | 4358 → 3665 ms | 66.7 → 50.0 ms | 280 → 240 ms | 6 → 5 |
| scroll-diagonal | low | 1451 → 1459 ms | 16.8 → 16.7 ms | — | 0 |
| scroll-diagonal | high | 1894 → 1780 ms | 33.4 → 33.4 ms | — | 1 |

High-profile vertical scroll is the only frame-budget offender still over 16.7 ms (66.7 → 50 ms p95).

## Why it is slow
Scrolling itself is well virtualized (band + hysteresis + directional overscan). Remaining costs:

1. **Frame p95 over budget on the high fixture** — per-frame `cellDisplayText` recompute for the newly-mounted window plus `measureTextWidth` misses. The text-measure cache helps single-line values, but wrapped/long cells miss (`textMeasure.js:14-37`), and scroll-mounted rows run full display formatting.
2. **Per-scroll gesture: `domCellAddressAtPoint` calls `getBoundingClientRect()` on every mounted slot** during drag/smooth scroll hit-tests (`useSheetGridGestures.js:44`), O(mounted) layout reads per pointermove.
3. **Selection-range coalescing** paints once per rAF (`queueSelectionRangeUpdate`) but computes range membership for every mounted cell each update.
4. Mounted window may grow past the visible slice if the viewport is large (overscan 3 + hysteresis 2 + directional ahead up to 6), then every rebase pays cellDisplayText for all of them.

## Plan
- **P2.1** Per-cell memo cache for display/tone/range so scroll-rebase computes only newly-visible cells (unchanged). Cell props computed inside the memoized slot, not in the parent map.
- **P2.2** Text measure: add a measurement short-circuit for values that provably fit (width ≤ column width single-line) and a wrap-aware cache; skip `measureText` for non-wrapped short values.
- **P2.5** `domCellAddressAtPoint` → pure-geometry hit-test (already exists at `cellAddressAtPoint`) instead of per-slot `getBoundingClientRect`; keep one cached rect set per frame if DOM probing is needed.
- **P2.4** Bounds on the mounted band are already present — keep; verify cellDisplayText cost per scroll-rebase via P0 timers.
- **P3** High-fixture scroll-through rows benefits from offset addressing (no full-axis geometry rebuild when axis metadata absent).

## Expected time
- scroll-vertical: low **≤ 2000 ms**, high **≤ 3000 ms** with **frame p95 ≤ 16.7 ms** (from 50 ms) and longtasks ≤ 3.
- scroll-diagonal: low **≤ 1400 ms**, high **≤ 1800 ms**, frame p95 ≤ 16.7 ms.

## Gate
`npm run bench:suite -- --profiles low,high --repeats 2 --label scroll` — pass if high scroll-vertical frame p95 ≤ 16.7 ms and duration ≤ 3000 ms.