import assert from "node:assert/strict";

import { markPartialCells } from "../../../src/core/dataset/sheetIndex.js";
import { createWorkspaceEngine } from "../../../src/core/engine/index.ts";
import { invertPatch, mergePatchOperations } from "../../../src/core/history/patches.ts";
import { createBlankWorkspace } from "../../../src/core/model.ts";
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

function engineWith({ partial }) {
  const workspace = createBlankWorkspace({ id: "shift-workspace", name: "Shift" });
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
