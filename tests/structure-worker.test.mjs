import assert from "node:assert/strict";
import test from "node:test";

import { remapSheetAxisResult } from "../src/workers/structure/index.js";

function sheet() {
  return {
    id: "sheet",
    type: "sheet",
    title: "Sheet",
    rows: 256,
    columns: 64,
    cells: {
      r1c1: { id: "r1c1", address: "A1", row: 0, column: 0, value: "1", formula: "" },
      r2c1: { id: "r2c1", address: "A2", row: 1, column: 0, value: "", formula: "=A1+A2" },
      r3c2: {
        id: "r3c2", address: "B3", row: 2, column: 1, value: "", formula: "",
        embed: { objectId: "child", linkId: "link" },
      },
    },
    rowHeights: { 1: 40 },
    columnWidths: { 1: 180 },
    rowGroups: [{ id: "rows", start: 1, end: 3 }],
    columnGroups: [],
    filters: [{ id: "filter", column: 1, value: "x" }],
    conditionalFormats: [{ id: "rule", range: "A1:B3", kind: "positive" }],
  };
}

test("structure worker inserts globally and reports moved embeds", () => {
  const result = remapSheetAxisResult(sheet(), "row", 1, "insert");

  assert.equal(result.object.rows, 257);
  assert.equal(result.object.cells.r3c1.formula, "=A1+A3");
  assert.equal(result.object.cells.r4c2.embed.objectId, "child");
  assert.deepEqual(result.embeddedLinks, [{
    objectId: "child", linkId: "link", sourceCellId: "r4c2", sourceAddress: "B4",
  }]);
  assert.deepEqual(result.object.rowHeights, { 2: 40 });
  assert.equal(result.object.conditionalFormats[0].range, "A1:B4");
});

test("structure worker deletes the target axis and shifts following cells", () => {
  const result = remapSheetAxisResult(sheet(), "column", 0, "delete");

  assert.equal(result.object.columns, 64);
  assert.equal(result.object.cells.r3c1.embed.objectId, "child");
  assert.equal(result.object.cells.r1c1, undefined);
  assert.deepEqual(result.object.columnWidths, { 0: 180 });
  assert.deepEqual(result.object.filters, [{ id: "filter", column: 0, value: "x" }]);
});