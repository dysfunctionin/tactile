import assert from "node:assert/strict";

import { defineSuite } from "../../harness/index.mjs";
import { largeSheet } from "../../scenarios/large-sheet.mjs";
import { removeSheetAxisCells, reorderSheetAxis, shiftCells } from "../../../src/core/sheet/axisCells.js";
import { FormulaEngine } from "../../../src/core/sheet/formulas.js";
import { repairWorkspaceTopology } from "../../../src/core/topology.js";
import { cloneHistoryWorkspace } from "../../../src/core/history/snapshot.js";
import { remapSheetAxisResult } from "../../../src/core/workers/structure/index.js";

const scenario = defineSuite({ type: "performance", suite: "large-sheet" });

/**
 * Each action is timed with `step` so the report shows per-operation latency
 * on a 250k-cell workspace rather than one aggregate number.
 */
scenario(
  "row and column edits stay responsive on a 250k-cell workspace",
  { setup: largeSheet, timeoutMs: 120_000 },
  async ({ workspace, rootSheet, spec, boundedEditAddress, isolatedEditAddress, step }) => {
    const engine = await step("build formula engine", () => new FormulaEngine(rootSheet));
    assert.equal(engine.getStats().formulaCount, spec.formulaCount);

    const dependent = await step("edit a referenced cell", () =>
      engine.updateCell(boundedEditAddress, { value: "2000", formula: "" }),
    );
    assert.ok(dependent.evaluatedAddresses.length > 0);

    const unreferenced = await step("edit an unreferenced cell", () =>
      engine.updateCell(isolatedEditAddress, { value: "unrelated", formula: "" }),
    );
    assert.deepEqual(unreferenced.evaluatedAddresses, []);

    const afterRowInsert = await step("insert a row", () => shiftCells(rootSheet, "row", 10));
    assert.ok(afterRowInsert);

    const afterRowDelete = await step("delete a row", () => removeSheetAxisCells(rootSheet, "row", 10));
    assert.ok(afterRowDelete);

    const afterColumnInsert = await step("insert a column", () => shiftCells(rootSheet, "column", 5));
    assert.ok(afterColumnInsert);

    const afterColumnDelete = await step("delete a column", () => removeSheetAxisCells(rootSheet, "column", 5));
    assert.ok(afterColumnDelete);

    const reordered = await step("move a column", () => reorderSheetAxis(rootSheet, "column", 3, 7));
    assert.ok(reordered);

    const remapped = await step("remap an axis for the structure worker", () =>
      remapSheetAxisResult(rootSheet, "row", 20, "insert"),
    );
    assert.ok(remapped);

    const snapshot = await step("clone the workspace for undo history", () => cloneHistoryWorkspace(workspace));
    assert.equal(Object.keys(snapshot.objects).length, spec.objectCount);

    const repaired = await step("repair workspace topology", () => repairWorkspaceTopology(workspace));
    assert.ok(repaired);
  },
);
