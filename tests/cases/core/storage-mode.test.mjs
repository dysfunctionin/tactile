import assert from "node:assert/strict";

import {
  VIRTUAL_CELL_THRESHOLD,
  createStorageModePolicy,
  sheetCellCount,
} from "../../../src/core/dataset/storageMode.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "storage-mode" });

scenario("a small sheet stays eager", () => {
  const policy = createStorageModePolicy({ threshold: 100 });

  assert.equal(policy.modeFor("sheet-1", 99), "eager");
});

scenario("a sheet at the threshold goes virtual", () => {
  const policy = createStorageModePolicy({ threshold: 100 });

  assert.equal(policy.modeFor("sheet-1", 100), "virtual");
});

scenario("a virtual sheet does not fall back when its cell count drops", () => {
  const policy = createStorageModePolicy({ threshold: 100 });
  policy.modeFor("sheet-1", 500);

  // Deleting rows must not send the sheet back to eager, because its blocks are
  // on disk and reverting would mean loading every one of them again.
  assert.equal(policy.modeFor("sheet-1", 1), "virtual");
});

scenario("each sheet is judged on its own size", () => {
  const policy = createStorageModePolicy({ threshold: 100 });

  assert.equal(policy.modeFor("sheet-1", 500), "virtual");
  assert.equal(policy.modeFor("sheet-2", 5), "eager");
});

scenario("forgetting a sheet lets the next open decide again", () => {
  const policy = createStorageModePolicy({ threshold: 100 });
  policy.modeFor("sheet-1", 500);

  policy.forget("sheet-1");

  assert.equal(policy.modeFor("sheet-1", 1), "eager");
});

scenario("the mode is taken from the cells a sheet stores, not the grid it declares", () => {
  const policy = createStorageModePolicy({ threshold: 3 });
  // A sheet can declare a million rows and hold three cells; the footprint that
  // matters is what is stored.
  const sparse = { id: "sheet-1", rows: 1_000_000, columns: 1_000, cells: { r1c1: { value: "1" } } };

  assert.equal(sheetCellCount(sparse), 1);
  assert.equal(policy.modeForSheet(sparse), "eager");
});

scenario("the default threshold is used when none is given", () => {
  const policy = createStorageModePolicy();

  assert.equal(policy.threshold, VIRTUAL_CELL_THRESHOLD);
  assert.equal(policy.modeFor("sheet-1", VIRTUAL_CELL_THRESHOLD), "virtual");
});
