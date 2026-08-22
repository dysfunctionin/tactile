# 04 — Add row / add column (structural inserts ×8)

## Current time
From suite runs (`add-row`/`add-column` = 8 inserts; median, one repeat):

| Scenario | Profile | baseline | final-opt | frame p95 | longtasks |
|---|---|---|---|---|---|
| add-row ×8 | low | 2200 ms | 2154 ms | 16.8 → 16.7 ms | 1 |
| add-row ×8 | high | 15869 ms | 15860 ms | 16.7 ms | 0 |
| add-column ×8 | low | 2193 ms | 2116 ms | 16.7 ms | 1 |
| add-column ×8 | high | 19493 ms | 11808 ms | 16.7 ms | 3 |

Per insert that's roughly **2.0 s (low) / 2.0 s (high row) / 1.5–2.4 s (high column)**.

## Why it is slow (measured, per insert on high)
The fixture inserts at B4 = **row index 3**, so every insert re-shifts ~99.9k of the 100k root cells
and re-registers ~10k of the 25k formulas. Per insert, in order of cost:

1. **Formula engine re-registration + re-evaluation — ~4.7 s measured (dominant).** A row-3 insert
   shifts the addresses of every formula below it; `applyChanges` re-registers each via
   `setFormula` and re-evaluates through the row-indexed range dependent collapse
   (`formulas.js:1019-1035,736-758`, see `11-formula-engine.md`). On the 250k sheet this is the
   whole ballgame — and it is *pure* avoidable work: the values barely change, they just move.
2. **Undo snapshot — `structuredClone(workspace)` ~613 ms** (`useLocalWorkspace.js:56-69,286-305`);
   the `insert:…` history key never coalesces.
3. **Physical re-key — `shiftCells` ~197 ms** (`useLocalWorkspace.js:81-112`) recreates ~100k cell
   records and regex-rewrites every shifted formula (`src/sheet/structure.js`).
4. **Persistence flood**: the transaction engine materializes a ~100k-op patch + inverse + history,
   and IndexedDB writes ~100k cell records (`shadow.js`, `browser/persistence.js`).
5. Render re-scans: `embeddedTypes` (~53 ms) + `autoRowHeights` (~68 ms) + geometry rebuild.

Node stack ≈ 6 s/op ≈ observed ~2 s/op in the warm browser build.

## Plan
- **`11` engine first**: change-selective recalculation + coverage index cut the 4.7 s even before
  addressing changes (< 1 s). **P3 offset addressing removes it entirely** — a row insert changes no
  formula's address or reference, so the engine re-evaluates ≈0 formulas.
- **P3 (core)** Logical→physical axis mapping: keep cell records at their authored coordinates; a
  display/offset list derives logical position. Insert = O(1) metadata; no cell-id/address/formula
  rewrites; undo = inverse metadata patch (no `structuredClone`); persistence = one axis-op record
  instead of ~100k cell records. Portable v4 file still round-trips via the flattened export.
- **P1** Differential diagnostics off hot path + coalesced reconcile for the remaining taxes.
- **P2** Journal-driven auto-height/embeddedTypes scans off the commit render.

## Expected time
- low: **≤ 600 ms** for 8 inserts (**≤ 75 ms/op**); high: **≤ 2400 ms** for 8 inserts (**≤ 300 ms/op**) — from 15860/15860/11808 at final-opt.

## Gate
`npm run bench:suite -- --profiles low,high --repeats 2 --label structural` — pass if high add-row/add-column ≤ 2400 ms and per-op stage timer (P0) ≤ 300 ms; undo/redo of an insert completes < 300 ms with no full-workspace clone (verified via heap/GC trace).