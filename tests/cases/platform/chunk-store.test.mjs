import assert from "node:assert/strict";

import { createMemoryChunkStore, readChunksForRange } from "../../../src/core/dataset/chunkStore.js";
import { CHUNK_STORE_COMMANDS, createNativeChunkStore } from "../../../src/platform/tauri/chunkStore.ts";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "platform", suite: "chunk-store" });

/** Stands in for the Rust command layer, recording exactly what crossed IPC. */
function nativeBackend() {
  const rows = new Map();
  const calls = [];

  const invoke = async (command, payload) => {
    calls.push({ command, payload });
    const prefix = `${payload.workspaceId}/${payload.objectId}/`;
    switch (command) {
      case CHUNK_STORE_COMMANDS.read:
        return payload.chunkKeys
          .filter((chunkKey) => rows.has(`${prefix}${chunkKey}`))
          .map((chunkKey) => ({ chunkKey, cells: rows.get(`${prefix}${chunkKey}`) }));
      case CHUNK_STORE_COMMANDS.list:
        return [...rows.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length))
          .sort();
      case CHUNK_STORE_COMMANDS.write:
        for (const record of payload.write.put) rows.set(`${prefix}${record.chunkKey}`, record.cells);
        for (const chunkKey of payload.write.delete) rows.delete(`${prefix}${chunkKey}`);
        return 1;
      case CHUNK_STORE_COMMANDS.dropObject:
        for (const key of [...rows.keys()]) if (key.startsWith(prefix)) rows.delete(key);
        return 1;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };

  return { invoke, rows, calls };
}

scenario("the native store round-trips a chunk through the command layer", async () => {
  const backend = nativeBackend();
  const store = createNativeChunkStore("workspace-1", { invoke: backend.invoke });

  await store.writeChunks("sheet-1", [{ chunkKey: "0:0", cells: { r1c1: { value: "42" } } }]);
  const [chunk] = await store.readChunks("sheet-1", ["0:0"]);

  assert.equal(chunk.chunkKey, "0:0");
  assert.deepEqual(chunk.cells, { r1c1: { value: "42" } });
  // Chunk contents stay opaque JSON across IPC so the format is not forked.
  assert.equal(typeof backend.rows.get("workspace-1/sheet-1/0:0"), "string");
});

scenario("the native store reads only the requested blocks", async () => {
  const backend = nativeBackend();
  const store = createNativeChunkStore("workspace-1", { invoke: backend.invoke });

  await store.writeChunks("sheet-1", [
    { chunkKey: "0:0", cells: { r1c1: { value: "a" } } },
    { chunkKey: "9:9", cells: { r577c577: { value: "b" } } },
  ]);
  backend.calls.length = 0;
  const found = await store.readChunks("sheet-1", ["0:0"]);

  assert.equal(found.length, 1);
  assert.deepEqual(backend.calls[0].payload.chunkKeys, ["0:0"]);
});

scenario("a block that was never written is absent rather than empty", async () => {
  const backend = nativeBackend();
  const store = createNativeChunkStore("workspace-1", { invoke: backend.invoke });

  await store.writeChunks("sheet-1", [{ chunkKey: "0:0", cells: {} }]);
  const found = await store.readChunks("sheet-1", ["0:0", "1:0"]);

  // "written empty" and "not fetched" must stay distinguishable, or a virtual
  // sheet cannot tell a blank block from one it still has to load.
  assert.deepEqual(
    found.map((record) => record.chunkKey),
    ["0:0"],
  );
});

scenario("dropping an object clears only that object's blocks", async () => {
  const backend = nativeBackend();
  const store = createNativeChunkStore("workspace-1", { invoke: backend.invoke });

  await store.writeChunks("sheet-1", [{ chunkKey: "0:0", cells: { r1c1: { value: "a" } } }]);
  await store.writeChunks("sheet-2", [{ chunkKey: "0:0", cells: { r1c1: { value: "b" } } }]);
  await store.dropObject("sheet-1");

  assert.deepEqual(await store.listChunkKeys("sheet-1"), []);
  assert.deepEqual(await store.listChunkKeys("sheet-2"), ["0:0"]);
});

scenario("a corrupt chunk payload fails loudly instead of reading as empty", async () => {
  const invoke = async (command) =>
    command === CHUNK_STORE_COMMANDS.read ? [{ chunkKey: "0:0", cells: "{not json" }] : [];
  const store = createNativeChunkStore("workspace-1", { invoke });

  await assert.rejects(() => store.readChunks("sheet-1", ["0:0"]), /malformed/);
});

scenario("a range read asks for every block the range covers", async () => {
  const store = createMemoryChunkStore();
  await store.writeChunks("sheet-1", [
    { chunkKey: "0:0", cells: { r1c1: { value: "a" } } },
    { chunkKey: "1:0", cells: { r65c1: { value: "b" } } },
  ]);

  const found = await readChunksForRange(store, "sheet-1", {
    rowStart: 0,
    rowEnd: 64,
    columnStart: 0,
    columnEnd: 0,
  });

  assert.deepEqual(
    found.map((record) => record.chunkKey).sort(),
    ["0:0", "1:0"],
  );
});
