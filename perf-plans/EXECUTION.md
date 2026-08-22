# EXECUTION.md — how I will fix everything

Working plan derived from the measured analysis in `perf-plans/*` (see `12-measurements.md` for the
numbers, `10-single-edit-latency.md` for the per-commit breakdown, `11-formula-engine.md` for the
primary cause).

## Guiding principles

1. Kill the synchronous blockers first (engine cost), then async taxes (differential, stringify),
   then render, then structural. Engine's ~1.4 s sync per edit is worst jank; add-row's ~4.7 s
   re-eval is worst single op.
2. Measure every phase via the suite + dashboard stage timers (P0). Node numbers are ~2–3× colder
   than the browser; re-verify in-browser before trusting a delta.
3. No atom-rewrite: keep the good bones (sparse cells, structural sharing, change journal,
   virtualization); fix the habits that make them O(workspace).
4. Guarantee: v4 portable contract unchanged; `alpha` green (unit + lint + full Playwright e2e) at
   every checkpoint; never touch `main`.
5. Harness honesty: fix the `formula-add` fixture/scenario bug (collapsed row-group hides the
   target cell) before trusting that number.

## Phase 0 — Instrument & freeze baseline (~0.5 d)

- Add commit-path stage timers surfaced in suite + dashboard:
  `commit → engine(render) → shadow → persist → cache`.
- Re-run suite on high profile to calibrate in-browser numbers vs `12-measurements.md`.
- Freeze budgets (README matrix) as gates.

## Phase 1 — Formula engine: O(changed) not O(all-formulas) ★ key lever

Files: `src/sheet/formulas.js`, `src/objects/sheet/grid/useFormulaProjection.js`.

1. Stop iterating all formula addresses per recalculation (`_runRecalculation` → walk the exact
   `affected` set from `applyChanges` in dependency order).
2. Coverage range index: replace row-only `rangeReverseDependencies` with a column-bucketed
   interval index; `dependentsOf(addr)` = exact hits, not all row-candidates.
3. Change-selective registration: `setFormula`/`removeFormula` only when parsed descriptors change;
   cache descriptors per formula string.
4. Lazy band-first build in `useFormulaProjection`: first open evaluates only visible-band formulas
   (+ transitive deps); rest fills in over idle chunks / worker (removes the 6.2 s open block).
5. Drop the `engineSheet` full-cells copy on every rebuild (only when the cells reference changes).

Expected: single edit 1.4 s → <15 ms; row-shift 4.7 s → <1 s; first open 6.2 s → <800 ms band.

## Phase 2 — Kill per-commit snapshot taxes

Files: `src/core/engine/shadow.js`, `src/core/engine/legacyAdapter.ts`, `src/storage.js`,
`src/hooks/useLocalWorkspace.js`, `src/model.js`.

1. Gate shadow differential diagnostics (`compareEngineSnapshots` 4× normalize + deep compare,
   ~2.6 s/commit) behind flag / once-per-N.
2. Coalesce reconcile to one job per rAF with the newest workspace.
3. Throttle boot-cache flush to ≤1/s + `pagehide`.
4. `normalizeWorkspace` identity short-circuit; collapse boot to one normalization; drop hydration
   re-clone.

Expected: typing commit ≈ 2.6 s → tens of ms.

## Phase 3 — Incremental view rendering (P2)

Files: `src/objects/sheet/grid/SheetGridCanvas.jsx`, `grid/SheetCellSlot.jsx`,
`grid/useSheetGridProjection.js`, `grid/useSheetGridGestures.js`, `useVirtualSheet.js`,
`grid/cellChangeJournal.js`.

1. Per-cell derived props inside memoized slots (keyed by cellId + cellsVersion + selectionVersion).
2. Journal-driven `embeddedTypes` + `autoRowHeights` (no `Object.values(cells)` / full scans).
3. Projection memo split: model outputs keyed on object, view outputs on selection/viewport.
4. `domCellAddressAtPoint` → pure-geometry hit-test on drags.

Expected: scroll high frame p95 50 → ≤16.7 ms; commit render scans ~120 ms → <20 ms.

## Phase 4 — Structural ops O(edit): logical/physical offset addressing (P3) ★ structural fix

Files: `src/sheet/coordinates.js`, `src/model.js`, `src/hooks/useLocalWorkspace.js`,
`src/sheet/formulas.js`, `src/sheet/structure.js`, `src/sheet/ranges.js`, `src/objects/sheet/**`,
persistence records.

Design:
- Cells keep authored (physical) coordinates; ids/addresses never change on axis ops.
- Sparse **axis-gap list** per axis; display/selection/headers translate physical ↔ logical.
- Formulas stay absolute-logical in text but resolve through the mapping at parse; an insert changes
  no formula text, registration, or evaluation (graph keyed by physical addresses).
- `shiftCells`/`removeSheetAxisCells`/`reorderSheetAxis` → metadata patches; undo = inverse gap
  patch (no `structuredClone`); filters/groups/conditional formats stay logical.
- Persistence writes one axis-op record; v4 flat export keeps the contract.
- Grid consumers stay logical; only storage/engine layers learn the mapping.

Expected: add-row ×8 high 15.9 s → ≤2.4 s (~300 ms/op); undo O(edit).

## Phase 5 — One engine + coalesced persistence (P4)

Files: `src/components/FormulaBar.jsx`, `src/core/engine/shadow.js`,
`src/platform/browser/persistence.js`.

1. Drop FormulaBar preview worker + shadow worker mirrors from input path; journaled delta only.
2. One `readwrite` IDB transaction per rAF covering all dirty records.

## Phase 6 — Frames & trust (P5) + native save (P6)

- Chunked yielding + progress affordance for import / large structural ops.
- Defer non-visible layer engine builds to idle.
- Rust: debounce/pipeline the portable-package rebuild (match browser path).

## Phase 7 — Harness corrections + full verification (~1 d)

1. Fix `formula-add` scenario target cell (collapsed row-group false timeout); add `files-open`
   scenario.
2. Full suite (3 repeats) vs Phase-0 baseline; update `perf-plans/*` expected values + README matrix.
3. Green gate: unit, lint, full e2e, bundle budget, suite budgets both profiles.

## Sequencing & risk

| Phase | Risk | Impact | Why now |
|---|---|---|---|
| 0 | none | baseline | cannot prove deltas without it |
| 1 engine | medium | highest (every scenario) | sync 1.4 s → <15 ms; 6.2 s open → lazy |
| 2 snapshot taxes | low | high for everyday edits | 2.6 s/commit → ~0 |
| 3 views | low | medium | frame-60fps + cheaper commits |
| 4 offset addressing | high | high structural | only way add-row is ~free |
| 5 dedupe | low | medium | removes duplicate eval |
| 6 UX/native | low | medium | trust + native parity |

## Definition of done (suite, high profile)

- Single-edit commit < 100 ms combined engine+shadow+persist (was ~4 s).
- Add-row/add-column ×8 ≤ 2.4 s (was 15.9 / 11.8 s); structural undo < 300 ms, no full clone.
- Typing: duration ≤ 1.8 s, input p95 (3-repeat) ≤ 60 ms, frame p95 ≤ 16.7 ms.
- Import ≤ 3.5 s; load-warm ≤ 4.5 s (no 120 s timeout); scroll-vertical frame p95 ≤ 16.7 ms;
  nested ≤ 10 s; in-out ≤ 2.2 s; sidebar open < 50 ms.
- No v4 file regressions; full e2e green; bundle budgets green.

Deliberately NOT doing: a full frontend rewrite in one shot — virtualization, sparse store, and
journal are already right; waste is concentrated in engine, differential, snapshot clones, and
physical re-keying.

---

## Implementation status (2026-08-22)

Measured with the Node micro-benches in `12-measurements.md` (cold process; browser is faster).

### Done (code landed, validated: 144/144 unit, lint clean, build + budget green)

| Plan | Change | Before → After (Node) |
|---|---|---|
| `11` engine | Exact column-bucketed range-coverage index (`dependentsOf`) | 821 ms → `< 11 ms` |
| `11` engine | Recalc walks only the affected set, shared recursion stack, lazy matrix, fast range reads, copy-free scalar aggregates | single edit **1992 → 364 ms** |
| `11` engine | Engine graph built after first paint (idle), not during render | first open no longer blocks on ~2.6–6 s build |
| `10` shadow | Differential diagnostics gated off (was 4× normalize ≈ 2.6 s/commit) | removed from hot path |
| `10` shadow | Reconcile coalesced (bursts = one diff + one persist) | N transitions → 1 per job |
| `10` storage | Boot-cache JSON.stringify throttled to ≤1/s + pagehide | off every-commit cadence |
| `10` model | `normalizeWorkspace` short-circuit **tried and reverted** (unsafe: live workspace mutates normalized outputs in place) | reverted |
| `05` harness | `formula-add` high target moved off the collapsed/filtered row (`M9`→`M5`) | false 30 s timeout was a fixture bug; the op measures ~4 ms engine |
| `08` gestures | Drag hit-test uses native `elementsFromPoint` first (no per-slot rect scan) | no O(mounted) layout reads per pointermove |
| `03` typing path | Covered by engine + differential + cache fixes | commit ≈ 4 s → ≈ 0.5 s worst-fixture |

### Deferred (needs a dedicated change, not safe to rush)

| Plan | Remaining | Why deferred |
|---|---|---|
| `04` add-row | **Offset addressing** (logical↔physical axis map; formulas never re-register on insert; undo = inverse patch; persistence = one axis-op record) | touches every sheet consumer (coords, formulas, ranges, selection, clipboard, filters, groups, v4 export). Multi-day, high blast radius. |
| `04` undo | Remove `structuredClone(workspace)` per structural edit | unsafe with the in-place-mutation design (tested & reverted a cheaper variant) |
| `01` load-warm / `02` import | Boot’s extra normalize/store/persistence passes; record-adapter replay | partially fixed by the deferred engine build; remainder needs the Wave-2 store path work |
| `03`/`08` render | Move per-cell display/tone compute into memoized slots (context-based) | moderate render risk for a small remaining win; skipped to keep the change surface safe |
| `09` sidebar | `files-open` scenario + incremental index | needs measurement first (index is O(objects), small) |
| `06`/`07` | (covered by engine + deferrals above) | — |

### Known environment flakes (not regressions)
- `sheet-scrolling:51` rail seam and `in-out:766` animation-replay fail only in batch (pass solo).
  The deferred engine build adds post-paint CPU work that increases timing jitter for these
  pixel/animation-sensitive checks.