import assert from "node:assert/strict";

import { createMemoryChunkStore } from "../../../src/core/dataset/chunkStore.js";
import { createChunkCache } from "../../../src/core/dataset/chunkCache.js";
import { createVirtualSheet } from "../../../src/core/dataset/virtualSheet.js";
import { cellId } from "../../../src/core/sheet/coordinates.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "virtual-sheet" });

function cell(value) {
  return { value };
}

/** A store that records every block key it was asked for. */
function countingStore(seed = {}) {
  const store = createMemoryChunkStore();
  const reads = [];
  const original = store.readChunks.bind(store);
  store.readChunks = async (objectId, chunkKeys) => {
    reads.push([...chunkKeys]);
    return original(objectId, chunkKeys);
  };
  const seeded = Object.entries(seed).map(([chunkKey, cells]) => ({ chunkKey, cells }));
  return { store, reads, ready: seeded.length ? store.writeChunks("sheet-1", seeded) : Promise.resolve() };
}

scenario("a cell in a resident block reads ready", async () => {
  const { store, ready } = countingStore({ "0:0": { [cellId(0, 0)]: cell("42") } });
  await ready;
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", overscanChunks: 0 });

  await sheet.ensureRange({ rowStart: 0, rowEnd: 10, columnStart: 0, columnEnd: 10 });

  assert.deepEqual(sheet.peekCell(0, 0), { cell: { value: "42" }, state: "ready" });
});

scenario("a cell in a block that was never fetched reads pending", async () => {
  const { store, ready } = countingStore({ "0:0": { [cellId(0, 0)]: cell("42") } });
  await ready;
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", overscanChunks: 0 });

  // Nothing has been ensured, so the block is absent rather than empty.
  assert.deepEqual(sheet.peekCell(0, 0), { cell: null, state: "pending" });
});

scenario("an invalidated block keeps its previous value so the grid can dim it", async () => {
  const { store, ready } = countingStore({ "0:0": { [cellId(0, 0)]: cell("42") } });
  await ready;
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", overscanChunks: 0 });
  await sheet.ensureRange({ rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 });

  sheet.invalidate();

  // Blanking here is what would make a scroll flash empty on every revision.
  assert.deepEqual(sheet.peekCell(0, 0), { cell: { value: "42" }, state: "stale" });
});

scenario("a block that holds no cells becomes resident instead of re-fetching", async () => {
  const { store, reads, ready } = countingStore();
  await ready;
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", overscanChunks: 0 });

  await sheet.ensureRange({ rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 });
  const afterFirst = reads.length;
  await sheet.ensureRange({ rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 });

  assert.equal(reads.length, afterFirst);
  assert.deepEqual(sheet.peekCell(0, 0), { cell: null, state: "ready" });
});

scenario("concurrent requests for the same block share one read", async () => {
  const { store, reads, ready } = countingStore({ "0:0": { [cellId(0, 0)]: cell("42") } });
  await ready;
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", overscanChunks: 0 });

  await Promise.all([
    sheet.ensureRange({ rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 }),
    sheet.ensureRange({ rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 }),
  ]);

  assert.equal(reads.length, 1);
});

scenario("only the blocks a range covers are read", async () => {
  const { store, reads, ready } = countingStore();
  await ready;
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", overscanChunks: 0 });

  await sheet.ensureRange({ rowStart: 0, rowEnd: 10, columnStart: 0, columnEnd: 10 });

  // One 64x64 block plus the loose block, not the whole sheet.
  assert.deepEqual(reads[0].sort(), ["0:0", "loose"]);
});

scenario("a write merges into the resident block rather than replacing it", async () => {
  const { store, ready } = countingStore({ "0:0": { [cellId(0, 0)]: cell("42") } });
  await ready;
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", overscanChunks: 0 });

  await sheet.writeCells({ [cellId(1, 0)]: cell("7") });

  const [chunk] = await store.readChunks("sheet-1", ["0:0"]);
  // Writing without loading first would persist a block holding only the edit.
  assert.deepEqual(chunk.cells, { [cellId(0, 0)]: { value: "42" }, [cellId(1, 0)]: { value: "7" } });
});

scenario("clearing every cell in a block removes the block", async () => {
  const { store, ready } = countingStore({ "0:0": { [cellId(0, 0)]: cell("42") } });
  await ready;
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", overscanChunks: 0 });

  await sheet.writeCells({ [cellId(0, 0)]: null });

  assert.deepEqual(await store.listChunkKeys("sheet-1"), []);
});

scenario("a failed read leaves the block unresident instead of caching a blank", async () => {
  const store = createMemoryChunkStore();
  let fail = true;
  store.readChunks = async () => {
    if (fail) throw new Error("backing store unavailable");
    return [{ chunkKey: "0:0", cells: { [cellId(0, 0)]: cell("42") } }];
  };
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", overscanChunks: 0 });

  await assert.rejects(() => sheet.ensureRange({ rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 }));
  // Caching an empty block here would make the failure look like an empty sheet.
  assert.equal(sheet.peekCell(0, 0).state, "pending");

  fail = false;
  await sheet.ensureRange({ rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 });
  assert.deepEqual(sheet.peekCell(0, 0), { cell: { value: "42" }, state: "ready" });
});

scenario("the cache evicts the least recently used block once it is over budget", () => {
  const cache = createChunkCache({ maxBytes: 400 });
  cache.set("sheet-1", "0:0", { a: cell("first") });
  cache.set("sheet-1", "1:0", { a: cell("second") });
  cache.get("sheet-1", "0:0");
  cache.set("sheet-1", "2:0", { a: cell("third") });

  assert.equal(cache.has("sheet-1", "0:0"), true);
  assert.equal(cache.has("sheet-1", "1:0"), false);
  assert.equal(cache.metrics().evictions, 1);
});

scenario("a pinned block survives eviction while it is on screen", () => {
  const cache = createChunkCache({ maxBytes: 400 });
  cache.set("sheet-1", "0:0", { a: cell("visible") });
  cache.pin("sheet-1", ["0:0"]);
  cache.set("sheet-1", "1:0", { a: cell("second") });
  cache.set("sheet-1", "2:0", { a: cell("third") });

  // Evicting the visible window would make the sheet re-fetch what it is painting.
  assert.equal(cache.has("sheet-1", "0:0"), true);
});

scenario("dropping an object clears only its blocks", async () => {
  const store = createMemoryChunkStore();
  await store.writeChunks("sheet-1", [{ chunkKey: "0:0", cells: { a: cell("one") } }]);
  await store.writeChunks("sheet-2", [{ chunkKey: "0:0", cells: { a: cell("two") } }]);
  const cache = createChunkCache();
  const sheet = createVirtualSheet({ store, objectId: "sheet-1", cache, overscanChunks: 0 });
  await sheet.ensureRange({ rowStart: 0, rowEnd: 1, columnStart: 0, columnEnd: 1 });
  cache.set("sheet-2", "0:0", { a: cell("two") });

  await sheet.drop();

  assert.equal(cache.has("sheet-1", "0:0"), false);
  assert.equal(cache.has("sheet-2", "0:0"), true);
  assert.deepEqual(await store.listChunkKeys("sheet-2"), ["0:0"]);
});
