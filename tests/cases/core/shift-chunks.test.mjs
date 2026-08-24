import assert from "node:assert/strict";

import { chunkKeyForCellId } from "../../../src/core/dataset/cellChunks.js";
import { createMemoryChunkStore, seedChunks } from "../../../src/core/dataset/chunkStore.js";
import { readAllCells } from "../../../src/core/dataset/hydrate.js";
import { bandForIndex, bandOfChunkKey, shiftCellsForAxis, shiftStoredCells, writeCellsIntoChunks } from "../../../src/core/dataset/shiftChunks.js";
import { cellAddress, cellId } from "../../../src/core/sheet/coordinates.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "shift-chunks" });

function cell(row, column, value) {
  const id = cellId(row, column);
  return { id, address: cellAddress(row, column), row, column, value };
}

function cellsAt(coordinates) {
  const cells = {};
  for (const [row, column, value] of coordinates) {
    const record = cell(row, column, value);
    cells[record.id] = record;
  }
  return cells;
}

/** Records what a single shift read, so the tests can prove it stayed narrow. */
function countingStore(inner) {
  let peak = 0;
  const reads = [];
  return {
    peak: () => peak,
    reads: () => reads,
    readKeys: () => reads.flat(),
    listChunkKeys: (objectId) => inner.listChunkKeys(objectId),
    async readChunks(objectId, chunkKeys) {
      reads.push([...chunkKeys]);
      const records = await inner.readChunks(objectId, chunkKeys);
      peak = Math.max(peak, records.reduce((total, record) => total + Object.keys(record.cells).length, 0));
      return records;
    },
    writeChunks: (objectId, put, remove) => inner.writeChunks(objectId, put, remove),
  };
}

async function seeded(cells) {
  const store = createMemoryChunkStore();
  await seedChunks(store, "sheet", cells);
  return store;
}

scenario("an inserted row pushes a cell into the next block", async () => {
  const store = await seeded(cellsAt([[63, 0, "last-of-block"]]));
  assert.equal(chunkKeyForCellId(cellId(63, 0)), "0:0");

  await shiftStoredCells(store, "sheet", { axis: "row", index: 0, operation: "insert" });

  const cells = await readAllCells(store, "sheet");
  assert.deepEqual(Object.keys(cells), [cellId(64, 0)]);
  assert.equal(cells[cellId(64, 0)].value, "last-of-block");
  assert.deepEqual((await store.listChunkKeys("sheet")).sort(), ["1:0"]);
});

scenario("a deleted row pulls a cell back into the previous block", async () => {
  const store = await seeded(cellsAt([[64, 0, "first-of-block"]]));

  await shiftStoredCells(store, "sheet", { axis: "row", index: 0, operation: "delete" });

  const cells = await readAllCells(store, "sheet");
  assert.deepEqual(Object.keys(cells), [cellId(63, 0)]);
  assert.equal(cells[cellId(63, 0)].value, "first-of-block");
});

scenario("cells before the index keep their coordinates", async () => {
  const store = await seeded(cellsAt([[10, 0, "above"], [200, 0, "below"]]));

  await shiftStoredCells(store, "sheet", { axis: "row", index: 100, operation: "insert" });

  const cells = await readAllCells(store, "sheet");
  assert.equal(cells[cellId(10, 0)].value, "above");
  assert.equal(cells[cellId(201, 0)].value, "below");
  assert.equal(cells[cellId(200, 0)], undefined);
});

scenario("blocks before the index are never read", async () => {
  const inner = await seeded(cellsAt([[10, 0, "above"], [500, 0, "below"]]));
  const store = countingStore(inner);

  await shiftStoredCells(store, "sheet", { axis: "row", index: 400, operation: "insert" });

  assert.equal(bandForIndex(400, "row"), 6);
  assert.deepEqual(store.readKeys(), ["7:0"]);
  assert.equal((await readAllCells(inner, "sheet"))[cellId(10, 0)].value, "above");
});

scenario("a deleted row drops the cells on that row", async () => {
  const store = await seeded(cellsAt([[5, 0, "doomed"], [5, 3, "also-doomed"], [6, 0, "survivor"]]));

  await shiftStoredCells(store, "sheet", { axis: "row", index: 5, operation: "delete" });

  const cells = await readAllCells(store, "sheet");
  assert.deepEqual(Object.keys(cells), [cellId(5, 0)]);
  assert.equal(cells[cellId(5, 0)].value, "survivor");
});

scenario("a block emptied by the shift is removed", async () => {
  const store = await seeded(cellsAt([[64, 0, "only"]]));
  assert.deepEqual(await store.listChunkKeys("sheet"), ["1:0"]);

  await shiftStoredCells(store, "sheet", { axis: "row", index: 0, operation: "delete" });

  assert.deepEqual(await store.listChunkKeys("sheet"), ["0:0"]);
});

scenario("a shift never holds more than a couple of blocks at once", async () => {
  const wide = [];
  for (let row = 0; row < 640; row += 1) wide.push([row, 0, `row-${row}`]);
  const inner = await seeded(cellsAt(wide));
  const store = countingStore(inner);

  await shiftStoredCells(store, "sheet", { axis: "row", index: 0, operation: "insert" });

  assert.equal(store.reads().length, 10);
  assert.ok(store.peak() <= 64, `held ${store.peak()} cells at once`);
  const cells = await readAllCells(inner, "sheet");
  assert.equal(Object.keys(cells).length, 640);
  assert.equal(cells[cellId(640, 0)].value, "row-639");
});

scenario("an inserted column pushes a cell into the next block", async () => {
  const store = await seeded(cellsAt([[0, 63, "edge"]]));

  await shiftStoredCells(store, "sheet", { axis: "column", index: 0, operation: "insert" });

  const cells = await readAllCells(store, "sheet");
  assert.deepEqual(Object.keys(cells), [cellId(0, 64)]);
  assert.deepEqual(await store.listChunkKeys("sheet"), ["0:1"]);
});

scenario("shifting rewrites the formulas it moves", () => {
  const cells = { [cellId(5, 0)]: { ...cell(5, 0, ""), formula: "=A10" } };

  const shifted = shiftCellsForAxis(cells, "row", 0, "insert");

  assert.equal(shifted[cellId(6, 0)].formula, "=A11");
});

scenario("loose cells have no band and are left alone", async () => {
  const store = createMemoryChunkStore();
  await store.writeChunks("sheet", [{ chunkKey: "loose", cells: { legacy: { id: "legacy", value: "kept" } } }], []);

  await shiftStoredCells(store, "sheet", { axis: "row", index: 0, operation: "insert" });

  assert.equal(bandOfChunkKey("loose", "row"), null);
  const cells = await readAllCells(store, "sheet");
  assert.equal(cells.legacy.value, "kept");
});

scenario("writing cells into blocks leaves the rest of each block alone", async () => {
  const store = createMemoryChunkStore();
  await seedChunks(store, "sheet", cellsAt([[0, 0, "keep"], [1, 0, "stale"]]));

  await writeCellsIntoChunks(store, "sheet", cellsAt([[1, 0, "fresh"], [70, 0, "new"]]));

  const cells = await readAllCells(store, "sheet");
  assert.equal(cells[cellId(0, 0)].value, "keep");
  assert.equal(cells[cellId(1, 0)].value, "fresh");
  assert.equal(cells[cellId(70, 0)].value, "new");
  assert.equal(chunkKeyForCellId(cellId(70, 0)), "1:0");
});
