import assert from "node:assert/strict";
import test from "node:test";

import { projectAutoRowHeights } from "../src/objects/sheet/grid/autoRowHeightProjection.js";
import { recordCellChanges, recordStructureChange } from "../src/objects/sheet/grid/cellChangeJournal.js";

function sheet(cells) {
  return { id: "sheet", type: "sheet", rows: 100, columns: 10, cells };
}

test("auto row heights consume journaled cell changes without rebuilding state", () => {
  const cells = {
    r1c1: { id: "r1c1", row: 0, column: 0, value: "one line", style: { wrap: true } },
    r2c1: { id: "r2c1", row: 1, column: 0, value: "short" },
  };
  const width = () => 100;
  const initial = projectAutoRowHeights(null, sheet(cells), width);
  assert.deepEqual(initial.heights, {});

  cells.r1c1 = { ...cells.r1c1, value: "a long wrapped value that occupies more than one rendered line" };
  recordCellChanges(cells, ["r1c1"]);
  const changed = projectAutoRowHeights(initial.state, sheet(cells), width);

  assert.equal(changed.state, initial.state);
  assert.ok(changed.heights[0] > 0);
  assert.equal(changed.heights[1], undefined);
});

test("live drafts update only their projected row and do not mutate committed state", () => {
  const cells = {
    r1c1: { id: "r1c1", row: 0, column: 0, value: "short" },
  };
  const width = () => 80;
  const initial = projectAutoRowHeights(null, sheet(cells), width);
  const drafts = new Map([
    ["r1c1", { value: "a live draft that wraps across several visual lines" }],
  ]);

  const drafted = projectAutoRowHeights(initial.state, sheet(cells), width, drafts);
  const committed = projectAutoRowHeights(drafted.state, sheet(cells), width);

  assert.ok(drafted.heights[0] > 0);
  assert.equal(committed.heights[0], undefined);
});

test("structural changes remap existing height contributions", () => {
  const cells = {
    r2c1: { id: "r2c1", row: 1, column: 0, value: "a long wrapped value that occupies more than one rendered line", style: { wrap: true } },
  };
  const width = () => 100;
  const initial = projectAutoRowHeights(null, sheet(cells), width);
  const shiftedCells = {
    r3c1: { ...cells.r2c1, id: "r3c1", row: 2 },
  };
  recordStructureChange(shiftedCells, cells, "row", 1, "insert");

  const shifted = projectAutoRowHeights(initial.state, sheet(shiftedCells), width);

  assert.equal(shifted.heights[1], undefined);
  assert.equal(shifted.heights[2], initial.heights[1]);
});