import assert from "node:assert/strict";
import test from "node:test";

import { cellsForMutation, cloneHistoryWorkspace } from "../src/core/history/snapshot.js";
import { createCellRecord, createSheetObject } from "../src/model.js";

function workspaceWithCell(value) {
  const sheet = createSheetObject({ id: "sheet", title: "Sheet" });
  sheet.cells.r1c1 = createCellRecord(0, 0, { value });
  return { id: "workspace", objects: { sheet } };
}

test("a snapshot shares cells maps instead of deep cloning them", () => {
  const workspace = workspaceWithCell("before");
  const snapshot = cloneHistoryWorkspace(workspace);

  assert.notEqual(snapshot, workspace);
  assert.notEqual(snapshot.objects, workspace.objects);
  assert.equal(snapshot.objects.sheet, workspace.objects.sheet);
});

test("mutating a captured cells map copies it and leaves the snapshot exact", () => {
  const workspace = workspaceWithCell("before");
  const original = workspace.objects.sheet.cells;
  const snapshot = cloneHistoryWorkspace(workspace);

  const cells = cellsForMutation(workspace.objects.sheet.cells);
  assert.notEqual(cells, original, "a captured map must be copied before mutation");

  cells.r1c1 = createCellRecord(0, 0, { value: "after" });
  cells.r2c2 = createCellRecord(1, 1, { value: "added" });

  assert.equal(snapshot.objects.sheet.cells.r1c1.value, "before");
  assert.equal(snapshot.objects.sheet.cells.r2c2, undefined);
  assert.equal(cells.r1c1.value, "after");
});

test("a map that no snapshot references is mutated in place", () => {
  const workspace = workspaceWithCell("before");
  const cells = workspace.objects.sheet.cells;
  assert.equal(cellsForMutation(cells), cells);
});

test("a copied map is reused until the next snapshot captures it", () => {
  const workspace = workspaceWithCell("before");
  cloneHistoryWorkspace(workspace);

  const first = cellsForMutation(workspace.objects.sheet.cells);
  assert.equal(cellsForMutation(first), first, "copying once per snapshot is enough");

  cloneHistoryWorkspace({ ...workspace, objects: { sheet: { ...workspace.objects.sheet, cells: first } } });
  assert.notEqual(cellsForMutation(first), first, "a fresh snapshot re-arms copy-on-write");
});

test("deleting a cell after a snapshot does not affect the snapshot", () => {
  const workspace = workspaceWithCell("before");
  const snapshot = cloneHistoryWorkspace(workspace);

  const cells = cellsForMutation(workspace.objects.sheet.cells);
  delete cells.r1c1;

  assert.equal(snapshot.objects.sheet.cells.r1c1.value, "before");
  assert.equal(cells.r1c1, undefined);
});
