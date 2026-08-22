# 11 — Formula engine (the primary cause on big sheets)

This is the root cause behind `01`–`07` and `10`. Every scenario that commits on a formula-dense
sheet pays it. Measured against the **high fixture** (root sheet 500×201 = 100k cells, **25k
formulas**, 5000 range `SUM`s, 20k binary `=C2+D2` chain refs):

![measurement method](12-measurements.md)

| Primitive (100k cells / 25k formulas, Node) | Time |
|---|---|
| `createFormulaEngine` (dependency-graph build) | 3583 ms |
| `recalculateAll` (full eval, 25k formulas) | 2653 ms |
| `applyChanges` single plain-cell edit (`B1`) | 1482 ms |
| `applyChanges` row-shift diff (~10k shifted formulas) | 4727 ms |
| `applyChanges` add `=SUM(B2:B6)` (one new formula) | 4 ms |
| `adjustFormulaForAxis` + cells rebuilt (`shiftCells`) | 197 ms |
| `structuredClone(workspace)` (undo, 250k cells) | 613 ms |
| `normalizeWorkspace(workspace)` | 658 ms |
| `JSON.stringify(cachePayload)` | 179 ms |

Browser build is ~2–3× faster than cold Node, but the **ratios hold: the engine dominates every
formula-dense operation**.

## Why the engine is O(all-formulas), not O(changed)

1. **`_runRecalculation` iterates every formula address** even for incremental runs —
   `for (const address of this.graph.formulaAddresses())` (`formulas.js:948`) where
   `formulaAddresses()` spreads all 25k keys. Every incremental recalculation pays the 25k scan.
2. **`transitiveDependentsOf` builds per-address dependents from coarse row-indexed ranges**
   (`formulas.js:736-758`): ranges are indexed by **row only**, so any changed cell enumerates
   *every* range formula overlapping that row as a candidate, then filters by column per formula.
   On a sheet where most rows overlap a dozen SUM ranges, even a single edit fans out through
   hundreds of candidates; the `=C2+D2` chains then cascade the affected set across the sheet.
3. **Each changed formula is re-registered + re-parsed** via `graph.setFormula(formulaDescriptors(...))`
   (`applyChanges`, `formulas.js:1019-1027`); `formulaDescriptors` walks the AST even with the
   text cache. 10k shifted formulas on a row insert = 10k registrations.
4. **`engineSheet` copies the whole cells map** on first build (`useFormulaProjection.js:20-27`).
5. **Three engines evaluate the same change**: grid projection + FormulaBar preview worker + shadow
   formula worker (`FormulaBar.jsx`, `shadow.js:287-329`), the shadow one inited with a full-graph
   serialization (`includeGraph: true`).

## Why single edits cascade

The fixture’s chain refs (`=C2+D2` at row r reads row r+1) plus row-wide SUM ranges mean editing one
cell near the top invalidates a wide transitive band. With ranges indexed by row only, containment
checks are O(per-row-candidates × ranges) per changed address.

## Plan (deep fixes, in order)

1. **Never iterate all formulas for an incremental run**: keep dependents as address-keyed
   sets (a `Set` of affected addresses built during `applyChanges`), and make recalculation walk
   only that set in dependency order.
2. **Range index → coverage index**: replace row-only `rangeReverseDependencies` with a
   2-D coverage structure (interval map per column, or a sorted range list) so `dependentsOf`
   returns only formulas whose ranges actually contain the changed cell.
3. **Change-selective registration**: only call `setFormula`/`removeFormula` for formulas whose
   parsed inputs changed; reuse the previous registration unchanged otherwise.
4. **Shift-invariance via logical/physical axis mapping (P3)**: with offset addressing, an axis
   insert/delete/move does not change any formula’s address or reference text, so the engine graph
   stays intact and **structural ops re-evaluate ~zero formulas** instead of 10k+. This single
   change removes the 4.7 s term in `04-add-row-column`.
5. **Single engine**: drop the FormulaBar/shadow worker mirrors from the input path; a shared
   evaluation module runs once. If background eval is needed, post the journaled delta (not a graph
   serialization), never `includeGraph: true`.
6. **Lazy graph build + band-first evaluation**: first render builds/parses only the visible band;
   the full sheet evaluates in idle chunks or on the worker (removes the 6.2 s open/import term).
7. **Keep the AST cache** (already present) and add per-formula cached evaluation when inputs
   unchanged.

## Expected effect
- Single edit on 25k-formula sheet: **~1.4 s → < 15 ms** engine.
- Row insert on 25k-formula sheet: **~4.7 s → < 50 ms** engine (near-zero with P3 offset addressing).
- First open/import of the fixture: **6.2 s → < 800 ms** for the visible band (lazy build).

Gated by `npm run bench:suite` on the high profile: single-edit commit < 100 ms, add-row ×8 < 2.4 s,
import < 3.5 s.