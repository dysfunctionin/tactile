# 05 — Formula add

## Current time
From suite runs (`formula-add` = ~50×10 formula cells; median, one repeat):

| Profile | baseline | final-opt | frame p95 | longtasks |
|---|---|---|---|---|
| low | 1474 ms | 1465 ms | 16.8 ms | 0 |
| high | 30858 ms (≈timeout) | 30872 ms (≈timeout) | 16.7 ms | 0 |

High profile is stuck at the scenario timeout (~30 s). Frame p95 is at budget, so the killer is
**synchronous evaluation/commit time**, not paint.

## Why it is slow — CORRECTION: it mostly isn't; the high run is a harness bug

Measured directly: adding `=SUM(B2:B6)` to the 100k-cell / 25k-formula sheet costs **~4 ms** of
engine work (`12-measurements.md`). The suite's high-formula-add ≈ 30 s "timeout" is **not** app
perf:

- The high scenario writes to **M9 (row index 8)** — inside the fixture's **collapsed row-group
  `perf-root-sheet-rows-a` (rows 6–18)**. A collapsed-group row never mounts in the DOM, so the
  scenario's `cell.waitFor({attached})` times out at 30 s.
- Fix: point the scenario at a visible cell (e.g., a row outside collapsed groups with no filter),
  then re-measure. Low-profile formula-add (1.47 s) is the realistic cost, dominated by the
  preview-worker round-trips while typing the formula and the normal commit taxes.

What remains real and slow on big formula sheets:
1. **Any commit pays the engine + differential + stringify taxes** described in `11` and `10`
   (single edit ≈ 1.4 s engine + 2.6 s differential on the high fixture) — a formula edit is just a
   commit.
2. Typing the formula chars goes through the FormulaBar preview worker per keystroke (duplicate
   evaluation; the app's own engine also evaluates on commit).
3. Evaluation itself is bounded by the dependency cascade reachable from the new formula's inputs
   (`formulas.js:736-758` row-indexed range fan-out).

## Plan
1. **Fix the scenario** (use a visible target cell, e.g. `N9`/`B9`, outside collapsed groups) and
   make the harness report a real number on high. This is a test bug, not an app bug.
2. Apply the `11` engine fixes: change-selective recalculation + coverage range index (bounds any
   dependency fan-out), so editing/adding formulas is O(inputs+dependents), not O(25k).
3. **P1.4/P4** One engine — stop duplicating evaluation in the FormulaBar preview worker and the
   shadow worker on the input path.
4. **P1/P10** Differential diagnostics off hot path + throttled cache so the surrounding commit is
   cheap on the high fixture.

## Expected time
- low: **≤ 900 ms** (formula-add is typing+commit dominated); high: **≤ 2500 ms** once the scenario
  is fixed and gates on a real target cell (the commit plus one SUM evaluation, no duplicate
  workers); no dependency fan-out beyond the affected set.

## Gate
Fix the scenario target cell first, then `npm run bench:suite -- --profiles low,high --repeats 2 --label formula` — pass if high duration ≤ 2500 ms, no timeout, and P0 stage timers show the formula commit < 100 ms engine.