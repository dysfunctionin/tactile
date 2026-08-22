# Performance plans

Playbooks for specific slow operations. Each file contains:

- **Current time** — measured from the suite runs in `perf-dashboard/app/public/data/runs/`
  (`baseline` → `final-opt`, `--repeats 1`). `low` = ~150-cell sheet, `high` = ~250k-cell sheet.
- **Why it is slow** — root cause with `src/...` references.
- **Plan** — ordered actions. Phases P0–P6 referenced below are defined here.
- **Expected time** — target after the plan.

## Root-cause summary — measured, in order of severity

All times measured on the high fixture (100k cells / **25k formulas** in the root sheet); see
[`12-measurements.md`](12-measurements.md).

1. **The formula engine is O(all-formulas) per operation, not O(changed)** — the single dominant
   cost on big sheets (`11-formula-engine.md`): incremental recalculation iterates every formula
   address; ranges are indexed by row only, so single edits fan out through wide dependent bands;
   a row insert re-registers + re-evaluates ~10k shifted formulas.
   - graph build **3.6 s** + full recalc **2.7 s** → first open/import (`01`, `02`, `06`, `07`).
   - one plain-cell edit **~1.4 s** → every commit, including typing Enter (`03`, `10`).
   - row-shift diff **~4.7 s** → add row/column (`04`).
2. **Snapshot work per commit** (`10-single-edit-latency.md`): the shadow differential runs
   4× `normalizeWorkspace` (658 ms each = **~2.6 s**) + a whole-workspace deep compare on every
   *small* commit (`shadow.js:408-417`, `legacyAdapter.ts:473-483`); `structuredClone(workspace)`
   undo (**613 ms**) per structural edit; boot-cache `JSON.stringify` (**179 ms**) per commit.
3. **Structural ops physically rebuild the sheet & flood persistence**: `shiftCells` re-keys
   100k cells (`197 ms`) and the transaction engine + IndexedDB write ~100k records per insert.
   The deep fix is logical→physical axis addressing (P3) so a row insert touches **zero** formulas
   and a handful of records (`04-add-row-column.md`).
4. **Render scans per commit**: `embeddedTypes` `Object.values` (~53 ms), `autoRowHeights`
   (~68 ms), and per-mounted-cell prop compute before memoized slots bail
   (`SheetGridCanvas.jsx:353-363`) — secondary, fixed by journal-driven projections (P2).
5. **Three formula engines** evaluate the same change (projection, FormulaBar worker, shadow
   worker with `includeGraph: true`) — deduplicate in P4.
6. **`formula-add high` is a harness bug, not a perf bug**: the target cell sits inside a
   collapsed row-group on the fixture, so the scenario times out waiting for a cell that never
   mounts. Measurements of the real op are tiny (`applyChanges` add-SUM = 4 ms). See
   [`05-formula-add.md`](05-formula-add.md).

## Current vs expected (times in ms, suite median)

| Operation | low now | high now | bottleneck today | low expected | high expected |
|---|---|---|---|---|---|
| [Load warm](01-load-warm.md) | 920 | fail* | engine build + eager recalc | ≤ 900 | ≤ 4500 |
| [Import + first render](02-import.md) | 1532 | 10945 | engine graph build 3.6 s + recalc 2.7 s | ≤ 900 | ≤ 3500 |
| [Typing burst (24 keys)](03-typing.md) — dur / input p95 | 2176 / 32 | 4434 / 264 | commit: engine 1.4 s + differential ~2.6 s | ≤ 1800 / ≤ 40 | ≤ 1800 / ≤ 60 |
| [Formula add](05-formula-add.md) | 1465 | 30872† | harness bug (hidden cell); op itself ~ms | ≤ 900 | ≤ 2500† |
| [Add row ×8](04-add-row-column.md) | 2154 | 15860 | engine re-eval ~4.7 s/op | ≤ 600 | ≤ 2400 |
| [Add column ×8](04-add-row-column.md) | 2116 | 11808 | engine re-eval + 250k cell re-key | ≤ 600 | ≤ 2400 |
| [Nested open/close](06-nested.md) | 8761 | 20176 | engine build per sheet + commit taxes | ≤ 5000 | ≤ 10000 |
| [In/out transition](07-in-out.md) | 1917 | 3291 | first-open engine build + commits | ≤ 1500 | ≤ 2200 |
| [Scroll vertical](08-scroll.md) | 2083 | 3665 | render prop compute on mounted band | ≤ 2000 | ≤ 2600 (fr ≤ 16.7) |
| [Scroll diagonal](08-scroll.md) | 1459 | 1780 | same | ≤ 1400 | ≤ 1700 |
| [File sidebar open](09-file-sidebar.md) | n/a | n/a | index rebuild after edit | < 50 | < 50 |
| [Single edit latency](10-single-edit-latency.md) | ~2 s | ~2 s | engine 1.4 s + differential ~2.6 s + stringify | < 80 | < 80 |

\* `high/load-warm` times out (>120 s) — the sheet never reaches first paint; the lazy engine-build
plan (`11`) targets exactly this.
† `formula-add high` is a harness/fixture bug (target cell `M9` is inside a collapsed row-group). Fix
the scenario, then gate on the real op — the engine work for one SUM is ~4 ms.

## Roadmap (phases P0–P6, defined in each file)

| Phase | Scope | Effort |
|---|---|---|
| P0 | Profile & gate: per-stage timers in the suite + budgets | 0.5 d |
| P1 | Kill O(workspace) per edit: diagnostics off hot path, coalesce reconcile + cache, normalize short-circuit, gate worker | 1–2 d |
| P2 | Incremental views: per-cell memo props, journal-driven auto-height, remove O(cells) scans | 1–2 d |
| P3 | Structural ops O(cells) → O(edit): logical→physical axis offset addressing, delta undo, record persistence | 2–4 d |
| P4 | Single engine, coalesced IDB commits | 1–2 d |
| P5 | Predictable frames + progress UX | 1 d |
| P6 | Native save debounce | 0.5–1 d |

Every plan is gated by the existing benchmark suite (`npm run bench:suite`), which feeds the live
dashboard (`perf-dashboard`).