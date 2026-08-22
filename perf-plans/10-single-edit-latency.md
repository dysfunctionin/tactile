# 10 — Single-edit latency (the cross-cutting cause)

This file documents the per-commit cost that makes "simple things" slow on big sheets. Measured
numbers against the high fixture (100k cells, 25k formulas) are in [`12-measurements.md`](12-measurements.md)
and the engine deep-dive is in [`11-formula-engine.md`](11-formula-engine.md).

## Current time
One cell edit (e.g. typing Enter, a paste, a format) on the high fixture, measured by primitive:

| Stage | Cost (Node, main thread) |
|---|---|
| Renders: `useFormulaProjection` → engine `applyChanges` | **~1.4 s** (sync — blocks the commit render) |
| Shadow differential: 4× `normalizeWorkspace` + whole-workspace deep-compare (≤20k changed cells) | **~2.6 s** (microtasks) |
| Boot-cache flush: `JSON.stringify(workspace)` | **~0.18 s** (macrotask) |
| Render scans (`embeddedTypes` 53 ms, `autoRowHeights` 68 ms, canvas prop compute) | ~0.12 s |
| Shadow engine/persistence for 1 cell (dispatch + 1 IDB record) | ~0.05 s |

**Total ≈ 4 s of main-thread load per single edit** on the 250k workspace. The suite's typing
scenario (4434 ms high) is dominated by exactly this one commit; a user doing 20 quick edits
accumulates ~80 s of jank.

## Why it is slow — one commit runs, on the main thread:
1. **Engine `applyChanges` is O(all-formulas), not O(changed)** (`11-formula-engine.md`):
   incremental recalculation iterates every formula address, ranges are indexed by row only, and
   the transitive dependent collapse fans out through the dense sheet.
2. **Shadow differential diagnostics normalize the whole workspace 4×** (`shadow.js:408-417`,
   `legacyAdapter.ts:473-483`): each `normalizeWorkspace` rebuilds every sheet's cells
   (~658 ms on 250k cells) + a full deep compare of the workspace tree. It runs whenever the change
   is ≤20 000 cells — i.e. every normal edit.
3. **Boot-cache `JSON.stringify(workspace)`** flush per commit (`storage.js:28-55`).
4. **Render cascade**: new sheet object identity re-runs projections; the canvas recomputes every
   mounted cell's props before memoized slots bail (`SheetGridCanvas.jsx:353-363`); `autoRowHeights`
   and `embeddedTypes` rescan all cells.
5. Structural commits additionally pay `structuredClone(workspace)` (~0.6 s) + the full axis rebuild
   (`04-add-row-column.md`).

## Plan (in priority order)
1. **`11` engine**: change-selective recalculation + coverage range index — removes the 1.4 s sync
   term. This alone makes single edits feel instant even without touching the shadow path.
2. **Gate the differential diagnostics** — run only when explicitly enabled / once per N revisions.
   Removes the ~2.6 s term.
3. **Coalesce** reconcile (one per rAF with the newest workspace) and **throttle the cache flush**
   to ≤1/s + `pagehide`. Removes the stringify macrotask from the cadence.
4. **`normalizeWorkspace` short-circuit** via identity cache so remaining calls are cheap.
5. **Journal-driven projections (P2)**: per-cell memoized props, journal-incremented auto-height and
   `embeddedTypes`, and a stable projection memo for selection-only changes — removes the ~0.12 s
   scans and makes the canvas compute only actually-changed cells.
6. **P3/P4** Structural ops O(edit) (offset addressing + delta undo + one IDB transaction per rAF).

## Expected time
- One cell edit on the 250k fixture: **~4 s → < 80 ms** total main-thread load
  (engine < 15 ms, differential 0, stringify deferred, scans < 20 ms); 0 long tasks during a
  10-edit burst.

## Gate
P0 adds a `single-edit` stage-timer view to the suite: commit → render(engine) → shadow → persist →
cache. Pass if engine+shadow+persist < 50 ms combined and the cache flush never blocks a frame
during an edit burst on the high fixture.