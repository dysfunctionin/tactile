import assert from "node:assert/strict";

import { markPartialCells } from "../../../src/core/dataset/sheetIndex.js";
import { createWorkspaceEngine } from "../../../src/core/engine/index.ts";
import { invertPatch, mergePatchOperations } from "../../../src/core/history/patches.ts";
import { createBlankWorkspace } from "../../../src/core/model.ts";
import { cellAddress, cellId } from "../../../src/core/sheet/coordinates.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "shift-operations" });

function command(type, payload, sequence = 1) {
  return {
    commandId: `command-${sequence}`,
    issuedAt: `2026-08-24T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    source: "keyboard",
    type,
    ...payload,
  };
}

function cell(row, column, value) {
  return { id: cellId(row, column), address: cellAddress(row, column), row, column, value };
}

function engineWith({ partial, cells }) {
  const workspace = createBlankWorkspace({ id: "shift-workspace", name: "Shift" });
  if (cells) {
    workspace.objects.home.cells = Object.fromEntries(cells.map((entry) => [entry.id, entry]));
  }
  if (partial) markPartialCells(workspace.objects.home);
  return createWorkspaceEngine(workspace);
}

function shiftsOf(result) {
  return (result?.forwardPatch?.operations || []).filter((operation) => operation.kind === "shift-cells");
}

scenario("a complete sheet needs no stored shift", async () => {
  const engine = engineWith({ partial: false });

  const result = await engine.dispatch(command("insert-axis", { objectId: "home", axis: "row", index: 2 }));

  assert.deepEqual(shiftsOf(result), []);
});

scenario("a partial sheet asks for its stored cells to move", async () => {
  const engine = engineWith({ partial: true });

  const result = await engine.dispatch(command("insert-axis", { objectId: "home", axis: "row", index: 2 }));

  const shifts = shiftsOf(result);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].objectId, "home");
  assert.equal(shifts[0].axis, "row");
  assert.equal(shifts[0].index, 2);
  assert.equal(shifts[0].operation, "insert");
});

scenario("deleting an axis on a partial sheet asks for a delete shift", async () => {
  const engine = engineWith({ partial: true });

  const result = await engine.dispatch(command("delete-axis", { objectId: "home", axis: "column", index: 3 }));

  const shifts = shiftsOf(result);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].axis, "column");
  assert.equal(shifts[0].operation, "delete");
});

scenario("a partial sheet tells persistence not to rewrite its blocks", async () => {
  const engine = engineWith({ partial: true });

  const result = await engine.dispatch(command("insert-axis", { objectId: "home", axis: "row", index: 2 }));

  const replace = result.forwardPatch.operations.find((operation) => operation.kind === "replace-object");
  assert.equal(replace.partialCells, true);
});

scenario("undoing a shift moves the cells back", () => {
  const forward = {
    id: "patch-1",
    baseRevision: "r1",
    targetRevision: "r2",
    operations: [{ kind: "shift-cells", objectId: "home", axis: "row", index: 4, operation: "insert", token: "a" }],
  };

  const [inverted] = invertPatch(forward).operations;

  assert.equal(inverted.operation, "delete");
  assert.equal(inverted.index, 4);
  assert.equal(inverted.axis, "row");
});

scenario("two shifts at the same index stay two moves", () => {
  const shift = (token) => ({
    kind: "shift-cells",
    objectId: "home",
    axis: "row",
    index: 4,
    operation: "insert",
    token,
  });

  const merged = mergePatchOperations([shift("a"), shift("b")]);

  assert.equal(merged.length, 2);
});

scenario("a delete carries the line it takes out", async () => {
  const engine = engineWith({ partial: true, cells: [cell(3, 0, "kept"), cell(4, 0, "gone"), cell(4, 1, "also")] });

  const result = await engine.dispatch(command("delete-axis", { objectId: "home", axis: "row", index: 4 }));

  const [shift] = shiftsOf(result);
  assert.deepEqual(Object.keys(shift.removed).sort(), [cellId(4, 0), cellId(4, 1)].sort());
  assert.equal(shift.cells, undefined);
});

scenario("undoing a delete puts the line back", () => {
  const removed = { [cellId(4, 0)]: cell(4, 0, "gone") };
  const forward = {
    id: "patch-1",
    baseRevision: "r1",
    targetRevision: "r2",
    operations: [
      { kind: "shift-cells", objectId: "home", axis: "row", index: 4, operation: "delete", token: "a", removed },
    ],
  };

  const [inverted] = invertPatch(forward).operations;

  assert.equal(inverted.operation, "insert");
  assert.deepEqual(Object.keys(inverted.cells), [cellId(4, 0)]);
  assert.equal(inverted.removed, undefined);
});

scenario("moving a row on a partial sheet lifts it out and drops it back", async () => {
  const engine = engineWith({ partial: true, cells: [cell(1, 0, "moved"), cell(5, 0, "settled")] });

  const result = await engine.dispatch(command("move-axis", { objectId: "home", axis: "row", from: 1, to: 4 }));

  const shifts = shiftsOf(result);
  assert.equal(shifts.length, 2);
  assert.equal(shifts[0].operation, "delete");
  assert.equal(shifts[0].index, 1);
  assert.deepEqual(Object.keys(shifts[0].removed), [cellId(1, 0)]);
  assert.equal(shifts[1].operation, "insert");
  assert.equal(shifts[1].index, 4);
  assert.deepEqual(Object.values(shifts[1].cells).map((entry) => entry.value), ["moved"]);
});

scenario("moving a row on a complete sheet needs no stored shift", async () => {
  const engine = engineWith({ partial: false, cells: [cell(1, 0, "moved")] });

  const result = await engine.dispatch(command("move-axis", { objectId: "home", axis: "row", from: 1, to: 4 }));

  assert.deepEqual(shiftsOf(result), []);
});
