import assert from "node:assert/strict";

import { createMemoryChunkStore, seedChunks } from "../../../src/core/dataset/chunkStore.js";
import {
  buildSheetIndex,
  emptySheetIndex,
  mergeSheetIndex,
  readSheetIndex,
  sheetIndexSize,
} from "../../../src/core/dataset/sheetIndex.js";
import { cellId } from "../../../src/core/sheet/coordinates.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "sheet-index" });

function value(id, text) {
  return { id, address: id, value: text };
}

function formula(id, expression) {
  return { id, address: id, formula: expression };
}

function embed(id, objectId) {
  return { id, address: id, value: "", embed: { objectId, linkId: `link-${id}` } };
}

/** One cell per block, by stepping a full block height between rows. */
function formulasAcrossBlocks(count) {
  const cells = {};
  for (let block = 0; block < count; block += 1) {
    const id = cellId(block * 64, 0);
    cells[id] = formula(id, "=B1");
  }
  return cells;
}

scenario("keeps only the cells that carry topology or a formula", () => {
  const index = buildSheetIndex({
    A1: value("A1", "plain"),
    A2: formula("A2", "=A1+1"),
    A3: embed("A3", "note-1"),
  });

  assert.deepEqual(Object.keys(index.formulas), ["A2"]);
  assert.deepEqual(Object.keys(index.embeds), ["A3"]);
});

scenario("counts a cell that is both an embed and a formula in both sets", () => {
  const cell = { id: "A1", address: "A1", formula: "=B1", embed: { objectId: "note-1" } };

  const index = buildSheetIndex({ A1: cell });

  assert.equal(index.embeds.A1, cell);
  assert.equal(index.formulas.A1, cell);
});

scenario("ignores an embed with no target object", () => {
  const index = buildSheetIndex({ A1: { id: "A1", embed: { linkId: "orphan" } } });

  assert.equal(sheetIndexSize(index), 0);
});

scenario("reads an index back from stored blocks", async () => {
  const store = createMemoryChunkStore();
  const near = cellId(0, 0);
  const far = cellId(400, 70);
  await seedChunks(store, "sheet-1", {
    [near]: value(near, "plain"),
    [cellId(1, 1)]: formula(cellId(1, 1), "=A1*2"),
    [far]: embed(far, "note-1"),
  });

  const index = await readSheetIndex(store, "sheet-1");

  assert.deepEqual(Object.keys(index.formulas), [cellId(1, 1)]);
  assert.deepEqual(Object.keys(index.embeds), [far]);
});

scenario("reads the same index whatever the batch size", async () => {
  const store = createMemoryChunkStore();
  await seedChunks(store, "sheet-1", formulasAcrossBlocks(40));

  const whole = await readSheetIndex(store, "sheet-1", { batchSize: 1_000 });
  const batched = await readSheetIndex(store, "sheet-1", { batchSize: 2 });

  assert.equal(Object.keys(batched.formulas).length, 40);
  assert.deepEqual(Object.keys(batched.formulas).sort(), Object.keys(whole.formulas).sort());
});

scenario("never reads more blocks at once than the batch allows", async () => {
  const store = createMemoryChunkStore();
  await seedChunks(store, "sheet-1", formulasAcrossBlocks(10));

  const batches = [];
  const counting = {
    ...store,
    readChunks: (objectId, keys) => {
      batches.push(keys.length);
      return store.readChunks(objectId, keys);
    },
  };
  await readSheetIndex(counting, "sheet-1", { batchSize: 3 });

  assert.ok(batches.length > 1, "a sheet spanning many blocks must be read in more than one batch");
  assert.ok(Math.max(...batches) <= 3);
});

scenario("reads an empty index for a sheet with no blocks", async () => {
  assert.deepEqual(await readSheetIndex(createMemoryChunkStore(), "sheet-1"), emptySheetIndex());
});

scenario("drops a cell that stops being a formula", () => {
  const index = buildSheetIndex({ A1: formula("A1", "=B1") });

  mergeSheetIndex(index, { A1: value("A1", "literal now") });

  assert.equal(sheetIndexSize(index), 0);
});

scenario("drops a cell that stops being an embed", () => {
  const index = buildSheetIndex({ A1: embed("A1", "note-1") });

  // A repaired relationship must not outlive the embed the user removed.
  mergeSheetIndex(index, { A1: value("A1", "") });

  assert.deepEqual(index.embeds, {});
});

scenario("drops a deleted cell", () => {
  const index = buildSheetIndex({ A1: formula("A1", "=B1"), A2: embed("A2", "note-1") });

  mergeSheetIndex(index, { A1: null, A2: undefined });

  assert.equal(sheetIndexSize(index), 0);
});

scenario("adds a cell that becomes a formula", () => {
  const index = emptySheetIndex();

  mergeSheetIndex(index, { A1: formula("A1", "=B1") });

  assert.deepEqual(Object.keys(index.formulas), ["A1"]);
});
