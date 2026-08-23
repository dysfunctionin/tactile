import { STORE_NAMES } from "./constants.js";
import { objectKeyRange, requestResult, transactionResult } from "./indexedDb.js";
import { cellChunkKey, cellChunkRecord } from "./records.js";

/**
 * Browser backing for the 64x64 cell blocks.
 *
 * Reads are keyed lookups rather than a scan, so a virtual sheet fetches only
 * the blocks it is about to render. The store is the same `cellChunks` object
 * store the snapshot path already writes, so both paths see one copy of a cell.
 */
export function createBrowserChunkStore(database, workspaceId) {
  const id = String(workspaceId);
  const store = STORE_NAMES.cellChunks;

  return {
    async readChunks(objectId, chunkKeys) {
      if (!chunkKeys.length) return [];
      const transaction = database.transaction([store], "readonly");
      const completed = transactionResult(transaction);
      const objectStore = transaction.objectStore(store);
      const pending = chunkKeys.map((chunkKey) =>
        requestResult(objectStore.get(cellChunkKey(id, objectId, chunkKey))),
      );
      const records = await Promise.all(pending);
      await completed;
      // A key with no row is absent rather than empty, so the caller can tell a
      // block that holds no cells from one that has not been fetched.
      return records
        .filter(Boolean)
        .map((record) => ({ chunkKey: String(record.chunkKey), cells: record.cells || {} }));
    },

    async listChunkKeys(objectId) {
      const transaction = database.transaction([store], "readonly");
      const completed = transactionResult(transaction);
      const keys = await requestResult(
        transaction.objectStore(store).getAllKeys(objectKeyRange(id, objectId)),
      );
      await completed;
      return (keys || []).map((key) => String(key[2])).sort();
    },

    async writeChunks(objectId, put, remove = []) {
      if (!put.length && !remove.length) return;
      const transaction = database.transaction([store], "readwrite");
      const completed = transactionResult(transaction);
      const objectStore = transaction.objectStore(store);
      for (const record of put) {
        objectStore.put(cellChunkRecord(id, objectId, record.chunkKey, record.cells || {}));
      }
      for (const chunkKey of remove) objectStore.delete(cellChunkKey(id, objectId, chunkKey));
      await completed;
    },

    async dropObject(objectId) {
      const transaction = database.transaction([store], "readwrite");
      const completed = transactionResult(transaction);
      transaction.objectStore(store).delete(objectKeyRange(id, objectId));
      await completed;
    },
  };
}
