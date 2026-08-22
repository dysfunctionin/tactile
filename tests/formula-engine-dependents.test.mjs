import assert from "node:assert/strict";
import test from "node:test";

import { createCellRecord, createSheetObject } from "../src/model.js";
import { createFormulaEngine } from "../src/sheet/formulas.js";

function sheetWithRanges() {
  const sheet = createSheetObject({ id: "ranges", rows: 2500, columns: 20 });
  for (let row = 0; row < 5; row += 1) {
    sheet.cells[`r${row + 1}c1`] = createCellRecord(row, 0, { value: String(row + 1) });
    sheet.cells[`r${row + 1}c3`] = createCellRecord(row, 2, { value: String(row + 11) });
  }
  // Small range B1:B3, multi-column range A1:B5, and a large >1024-row range.
  sheet.cells.r1c5 = createCellRecord(0, 4, { formula: "=SUM(B1:B3)" });
  sheet.cells.r1c6 = createCellRecord(0, 5, { formula: "=SUM(A1:B5)" });
  sheet.cells.r10c5 = createCellRecord(9, 4, { formula: "=SUM(A1:A2500)" });
  return sheet;
}

function engineWithRanges() {
  const engine = createFormulaEngine(sheetWithRanges());
  engine.recalculateAll();
  return engine;
}

test("engine re-evaluates a range formula when an inside cell changes", () => {
  const engine = engineWithRanges();
  engine.updateCell("B2", { value: "99" });
  const evaluated = engine.lastCalculation.evaluatedAddresses;
  assert.ok(evaluated.includes("E1"), `expected E1 (=SUM(B1:B3)) in evaluated: ${evaluated.join(",")}`);
});

test("engine leaves a range formula untouched when an outside cell changes", () => {
  const engine = engineWithRanges();
  engine.updateCell("D5", { value: "99" });
  const evaluated = engine.lastCalculation.evaluatedAddresses;
  assert.equal(evaluated.includes("E1"), false, `E1 should not re-evaluate for an outside edit: ${evaluated.join(",")}`);
  assert.equal(evaluated.includes("F1"), false, `F1 should not re-evaluate for an outside edit: ${evaluated.join(",")}`);
});

test("multi-column ranges re-evaluate only on column-inside edits", () => {
  const engine = engineWithRanges();
  engine.updateCell("A2", { value: "7" }); // inside A1:B5
  assert.ok(engine.lastCalculation.evaluatedAddresses.includes("F1"));
  const engine2 = engineWithRanges();
  engine2.updateCell("C3", { value: "7" }); // outside A1:B5
  assert.equal(engine2.lastCalculation.evaluatedAddresses.includes("F1"), false);
});

test("wide (>1024 row) ranges stay exact: inside hits, outside misses", () => {
  const engine = engineWithRanges();
  engine.updateCell("A1500", { value: "42" });
  assert.ok(engine.lastCalculation.evaluatedAddresses.includes("E10"));
  const engine2 = engineWithRanges();
  engine2.updateCell("B1500", { value: "42" }); // same row, different column
  assert.equal(engine2.lastCalculation.evaluatedAddresses.includes("E10"), false);
  assert.equal(engine2.lastCalculation.evaluatedAddresses.includes("E1"), false);
});

test("registry removal keeps subsequent range lookups exact", () => {
  const engine = engineWithRanges();
  engine.updateCell("E1", { formula: "" }); // drop =SUM(B1:B3)
  engine.updateCell("B2", { value: "111" });
  assert.equal(engine.lastCalculation.evaluatedAddresses.includes("E1"), false);
  // The wide A-range formula in the same sheet still resolves when its own
  // inputs change.
  engine.updateCell("A1500", { value: "777" });
  assert.ok(engine.lastCalculation.evaluatedAddresses.includes("E10"));
  // And stays out of an unrelated column's edits.
  engine.updateCell("B500", { value: "888" });
  assert.equal(engine.lastCalculation.evaluatedAddresses.includes("E10"), false);
});