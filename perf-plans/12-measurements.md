# 12 — Measured primitives (reproducible)

Micro-benchmarks measured **in Node** against the real high fixture
(`benchmarks/.generated/native-workspaces/high/workspace.json`: 100 objects, 250k cells across 6
sheets, root sheet 500×201 = 100k cells with **25k formulas**, 27.8 MB JSON). Re-run with:

```
node benchmarks/.generated/bench-primitives.mjs
node benchmarks/.generated/bench-primitives2.mjs
```

Cold Node process; the browser is typically 2–3× faster (warm V8 ICs, bigger heap). Use these for
**relative severity**, then confirm on the suite’s dashboard.

| Primitive | Time |
|---|---|
| JSON.parse (27.8 MB fixture) | 385 ms |
| `shiftCells`-style rows re-keyed + formula re-adjust (100k cells, 25k formulas, insert @ row 3) | 197 ms |
| `structuredClone` of whole workspace (100 objects, 250k cells) | 613 ms |
| `normalizeWorkspace(workspace)` | 658 ms |
| `repairWorkspaceTopology(objects)` | ~0 ms |
| `JSON.stringify(cachePayload(workspace))` (boot cache flush) | 179 ms |
| `JSON.stringify(workspace)` full | 185 ms |
| `createFormulaEngine` graph build (25k formulas) | 3583 ms |
| engine `recalculateAll` (25k formulas) | 2653 ms |
| engine `applyChanges` single plain-cell edit (B1) | 1482 ms |
| engine `applyChanges` add `=SUM(B2:B6)` | 4 ms |
| engine `applyChanges` row-shift diff (10 010 shifted formulas) | 4727 ms |
| engine `applyChanges` two-cell change (warm engine) | 1351 ms |
| `autoRowHeights` over root (100k cells) | 68 ms |
| `Object.values(object.cells)` scan (embeddedTypes use) | 53 ms |
| changed-cell union + reference compare over 100k keys (shadow `changedCellIds`) | 89 ms |

## What the numbers imply

1. **The formula engine is the whole story on big sheets** — see `11-formula-engine.md`.
   Graph build 3.6 s + full recalc 2.7 s dominate open/import; a 1-cell edit costs 1.4 s on a
   formula-dense sheet; a row insert costs ~4.7 s in re-registration/evaluation.
2. **Snapshot work is the second story**: normalize 658 ms ×4 runs on every small-commit
   differential (`shadow.js`), structuredClone 613 ms per structural edit, stringify 179 ms per
   commit. See `10-single-edit-latency.md`.
3. `autoRowHeights` (68 ms) and cells scans (53 ms) are secondary but matter when run per render.

## Standalone add-row → observed scenario calibration

Browser measured: add-row ×8 high ≈ 15 860 ms ≈ **2 s/op**. Node stack per op:
engine re-eval ~4.7 s + clone 0.6 s + shift 0.2 s + diff/patch/IDB ~0.5–1 s ≈ 6 s, matching the
2 s/op once the V8 warm-up/times-3 factor and async IDB are accounted for.