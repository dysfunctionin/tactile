import { chunkKeysForRange, groupCellsIntoChunks } from "./cellChunks.js";

/**
 * Backing store for the 64x64 cell blocks defined in ADR 0002.
 *
 * Every backend speaks this shape, so the virtual sheet path is written once
 * against blocks rather than once per platform. A key that was never written is
 * absent from a read result, which is how the caller distinguishes a block that
 * holds no cells from one that has not been fetched.
 *
 * @typedef {{ chunkKey: string, cells: Record<string, unknown> }} ChunkRecord
 *
 * @typedef {object} CellChunkStore
 * @property {(objectId: string, chunkKeys: readonly string[]) => Promise<ChunkRecord[]>} readChunks
 * @property {(objectId: string) => Promise<string[]>} listChunkKeys
 * @property {(objectId: string, put: readonly ChunkRecord[], remove?: readonly string[]) => Promise<void>} writeChunks
 * @property {(objectId: string) => Promise<void>} dropObject
 */

/** Reads the blocks covering a rectangular range in one round trip. */
export async function readChunksForRange(store, objectId, range) {
  const keys = chunkKeysForRange(range);
  if (!keys.length) return [];
  return store.readChunks(objectId, keys);
}

/**
 * Writes a sheet's cells into the store as blocks, unless blocks are already
 * there.
 *
 * A sheet cannot serve reads from blocks it never wrote, so a sheet that is
 * about to turn virtual has to be seeded first or it would render as empty.
 * Existing blocks are left alone because they are the newer copy: the snapshot
 * path writes them on every save, while `cells` here is whatever the caller
 * happens to be holding.
 */
export async function seedChunks(store, objectId, cells) {
  const existing = await store.listChunkKeys(objectId);
  if (existing.length) return false;
  const put = [...groupCellsIntoChunks(cells).values()];
  if (!put.length) return false;
  await store.writeChunks(objectId, put, []);
  return true;
}

/** In-memory implementation used by tests and by the pre-persistence boot path. */
export function createMemoryChunkStore() {
  const objects = new Map();

  function bucket(objectId) {
    let chunks = objects.get(String(objectId));
    if (!chunks) {
      chunks = new Map();
      objects.set(String(objectId), chunks);
    }
    return chunks;
  }

  return {
    async readChunks(objectId, chunkKeys) {
      const chunks = objects.get(String(objectId));
      if (!chunks) return [];
      const found = [];
      for (const chunkKey of chunkKeys) {
        const cells = chunks.get(String(chunkKey));
        if (cells) found.push({ chunkKey: String(chunkKey), cells: { ...cells } });
      }
      return found;
    },
    async listChunkKeys(objectId) {
      return [...(objects.get(String(objectId))?.keys() || [])].sort();
    },
    async writeChunks(objectId, put, remove = []) {
      const chunks = bucket(objectId);
      for (const record of put) chunks.set(String(record.chunkKey), { ...record.cells });
      for (const chunkKey of remove) chunks.delete(String(chunkKey));
    },
    async dropObject(objectId) {
      objects.delete(String(objectId));
    },
  };
}
