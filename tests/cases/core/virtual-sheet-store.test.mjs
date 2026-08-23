import assert from "node:assert/strict";

import { createMemoryChunkStore } from "../../../src/core/dataset/chunkStore.js";
import { sheetColumnName } from "../../../src/core/dataset/sheetColumns.js";
import { createVirtualSheetDatasetStore } from "../../../src/core/dataset/virtualSheetStore.js";
import { cellId } from "../../../src/core/sheet/coordinates.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "virtual-sheet-store" });

const OBJECT = { id: "sheet-1", title: "Sheet", rows: 500, columns: 40 };

function countingStore(seed = {}) {
  const store = createMemoryChunkStore();
  const reads = [];
  const original = store.readChunks.bind(store);
  store.readChunks = async (objectId, chunkKeys) => {
    reads.push([...chunkKeys]);
    return original(objectId, chunkKeys);
  };
  const seeded = Object.entries(seed).map(([chunkKey, cells]) => ({ chunkKey, cells }));
  return { store, reads, ready: seeded.length ? store.writeChunks(OBJECT.id, seeded) : Promise.resolve() };
}

function createStore(seed, options = {}) {
  const counting = countingStore(seed);
  return {
    ...counting,
    dataset: createVirtualSheetDatasetStore({
      store: counting.store,
      object: OBJECT,
      revision: "r1",
      overscanChunks: 0,
      ...options,
    }),
  };
}

function windowRequest(overrides = {}) {
  return {
    datasetId: OBJECT.id,
    rowStart: 0,
    rowEnd: 2,
    columnIds: [sheetColumnName(0), sheetColumnName(1)],
    ...overrides,
  };
}

scenario("a window projects resident cells with their values", async () => {
  const { dataset, ready } = createStore({
    "0:0": { [cellId(0, 0)]: { value: "left" }, [cellId(0, 1)]: { value: "right" } },
  });
  await ready;

  const result = await dataset.readWindow(windowRequest({ rowEnd: 0 }));

  assert.equal(result.rows.length, 1);
  assert.deepEqual(
    result.rows[0].cells.map((cell) => [cell.value, cell.state]),
    [["left", "ready"], ["right", "ready"]],
  );
});

scenario("a cell that was never written reads ready and empty rather than pending", async () => {
  const { dataset, ready } = createStore({ "0:0": { [cellId(0, 0)]: { value: "left" } } });
  await ready;

  const result = await dataset.readWindow(windowRequest({ rowEnd: 0 }));

  // The block is resident, so the absent cell is genuinely empty. Reporting it
  // as pending would leave the grid waiting for a value that will never arrive.
  assert.deepEqual(result.rows[0].cells[1], { columnId: sheetColumnName(1), value: "", state: "ready" });
});

scenario("a window reads only the blocks it covers", async () => {
  const { dataset, reads, ready } = createStore({ "0:0": { [cellId(0, 0)]: { value: "left" } } });
  await ready;

  await dataset.readWindow(windowRequest({ rowEnd: 2 }));

  assert.deepEqual(reads, [["0:0", "loose"]]);
});

scenario("a projection that skips columns still lands on the right cells", async () => {
  const { dataset, ready } = createStore({
    "0:0": { [cellId(0, 0)]: { value: "a" }, [cellId(0, 3)]: { value: "d" } },
  });
  await ready;

  const result = await dataset.readWindow(windowRequest({
    rowEnd: 0,
    columnIds: [sheetColumnName(0), sheetColumnName(3)],
  }));

  assert.deepEqual(result.rows[0].cells.map((cell) => cell.value), ["a", "d"]);
});

scenario("a revision change keeps values readable while marking them stale", async () => {
  const { dataset, ready } = createStore({ "0:0": { [cellId(0, 0)]: { value: "before" } } });
  await ready;
  await dataset.readWindow(windowRequest({ rowEnd: 0 }));

  dataset.update({ ...OBJECT, title: "Renamed" }, "r2");

  assert.deepEqual(dataset.sheet.peekCell(0, 0), { cell: { value: "before" }, state: "stale" });
});

scenario("a revision change notifies subscribers once", async () => {
  const { dataset } = createStore();
  const seen = [];
  dataset.subscribe(OBJECT.id, (revision) => seen.push(revision));

  dataset.update(OBJECT, "r2");
  dataset.update(OBJECT, "r2");

  assert.deepEqual(seen, ["r2"]);
});

scenario("a window clamps to the row count the sheet declares", async () => {
  const { dataset } = createStore();

  const result = await dataset.readWindow(windowRequest({ rowStart: 498, rowEnd: 600 }));

  assert.equal(result.rows.length, 2);
  assert.equal(result.totalRowCount, 500);
});

scenario("an unknown column projection is rejected", async () => {
  const { dataset } = createStore();

  await assert.rejects(
    () => dataset.readWindow(windowRequest({ columnIds: ["not-a-sheet-column"] })),
    /invalid column projection/,
  );
});

scenario("a column beyond the sheet width is rejected", async () => {
  const { dataset } = createStore();

  await assert.rejects(
    () => dataset.readWindow(windowRequest({ columnIds: [sheetColumnName(40)] })),
    /invalid column projection/,
  );
});

scenario("the descriptor reports virtual storage", async () => {
  const { dataset } = createStore();

  const descriptor = dataset.descriptor();

  assert.equal(descriptor.storageMode, "virtual");
  assert.equal(descriptor.rowCount, 500);
  assert.equal(descriptor.columns.length, 40);
});

scenario("a write is visible to the next window", async () => {
  const { dataset } = createStore();

  await dataset.writeCells({ [cellId(1, 1)]: { value: "typed" } });
  const result = await dataset.readWindow(windowRequest({ rowStart: 1, rowEnd: 1 }));

  assert.equal(result.rows[0].cells[1].value, "typed");
});

scenario("an aborted request never reaches the store", async () => {
  const { dataset, reads } = createStore();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => dataset.readWindow(windowRequest({ signal: controller.signal })));
  assert.deepEqual(reads, []);
});
