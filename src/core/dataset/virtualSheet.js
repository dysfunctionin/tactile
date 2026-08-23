import { cellId } from "../sheet/coordinates.js";

import {
  CELL_CHUNK_COLUMNS,
  CELL_CHUNK_ROWS,
  LOOSE_CHUNK_KEY,
  chunkKeyForCellId,
  chunkKeysForRange,
} from "./cellChunks.js";
import { createChunkCache } from "./chunkCache.js";

/**
 * Partial cell residency for a sheet.
 *
 * `object.cells` on a virtual sheet holds only the blocks currently resident,
 * so a missing cell means "not loaded here", never "empty". Callers ask this
 * layer, which answers from cache and reports why a value is not final:
 *
 * - `ready`    the block is resident and current
 * - `stale`    the block is resident but a refresh is in flight; the previous
 *              value is returned so the grid dims it rather than blanking it
 * - `pending`  the block has never been resident; there is no value to show
 *
 * Concurrent requests for the same block share one read, so a scroll that
 * crosses a boundary twice does not issue the fetch twice.
 */

export const DEFAULT_OVERSCAN_CHUNKS = 1;

function boundedRange(range) {
  return {
    rowStart: Math.max(0, Math.min(range.rowStart, range.rowEnd)),
    rowEnd: Math.max(0, Math.max(range.rowStart, range.rowEnd)),
    columnStart: Math.max(0, Math.min(range.columnStart, range.columnEnd)),
    columnEnd: Math.max(0, Math.max(range.columnStart, range.columnEnd)),
  };
}

function expandByChunks(range, overscan) {
  if (overscan <= 0) return range;
  return {
    rowStart: Math.max(0, range.rowStart - overscan * CELL_CHUNK_ROWS),
    rowEnd: range.rowEnd + overscan * CELL_CHUNK_ROWS,
    columnStart: Math.max(0, range.columnStart - overscan * CELL_CHUNK_COLUMNS),
    columnEnd: range.columnEnd + overscan * CELL_CHUNK_COLUMNS,
  };
}

export function createVirtualSheet({
  store,
  objectId,
  cache = createChunkCache(),
  overscanChunks = DEFAULT_OVERSCAN_CHUNKS,
}) {
  if (!store) throw new TypeError("createVirtualSheet requires a chunk store.");
  const id = String(objectId);
  const inFlight = new Map();
  const listeners = new Set();

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  function loadChunks(chunkKeys) {
    const wanted = chunkKeys.filter((chunkKey) => {
      const entry = cache.get(id, chunkKey);
      return !entry || entry.state === "stale";
    });
    const missing = wanted.filter((chunkKey) => !inFlight.has(chunkKey));

    if (missing.length) {
      const read = store.readChunks(id, missing).then(
        (records) => {
          const found = new Set();
          for (const record of records) {
            cache.set(id, record.chunkKey, record.cells || {});
            found.add(record.chunkKey);
          }
          // A block with no row was never written, so it is resident and empty
          // rather than still loading; caching that fact stops a re-request.
          for (const chunkKey of missing) if (!found.has(chunkKey)) cache.set(id, chunkKey, {});
          return records;
        },
        (error) => {
          for (const chunkKey of missing) cache.delete(id, chunkKey);
          throw error;
        },
      );
      const settle = read.finally(() => {
        for (const chunkKey of missing) {
          if (inFlight.get(chunkKey) === settle) inFlight.delete(chunkKey);
        }
      });
      for (const chunkKey of missing) inFlight.set(chunkKey, settle);
    }

    const pending = wanted.map((chunkKey) => inFlight.get(chunkKey)).filter(Boolean);
    return pending.length ? Promise.all(pending).then(notify) : Promise.resolve();
  }

  return {
    objectId: id,
    cache,

    /**
     * Makes the blocks covering a range resident, with a margin so a scroll
     * that leaves the range does not immediately stall on a fetch.
     */
    async ensureRange(range) {
      const bounded = boundedRange(range);
      const visible = chunkKeysForRange(bounded);
      cache.pin(id, visible);
      const keys = chunkKeysForRange(expandByChunks(bounded, overscanChunks));
      // The loose block holds cells that predate the grid id scheme, so it has
      // to be resident whenever any part of the sheet is read.
      await loadChunks([...new Set([...keys, LOOSE_CHUNK_KEY])]);
      return visible;
    },

    /** Resident blocks only; never triggers a read. */
    peekCell(row, column) {
      const target = cellId(row, column);
      const entry = cache.get(id, chunkKeyForCellId(target));
      if (!entry) return { cell: null, state: "pending" };
      return { cell: entry.cells[target] ?? null, state: entry.state };
    },

    /** Resident blocks only, keyed by cell id, for a projection over a range. */
    peekRange(range) {
      const bounded = boundedRange(range);
      const cells = {};
      let state = "ready";
      for (const chunkKey of chunkKeysForRange(bounded)) {
        const entry = cache.get(id, chunkKey);
        if (!entry) {
          state = "pending";
          continue;
        }
        if (entry.state === "stale" && state === "ready") state = "stale";
        Object.assign(cells, entry.cells);
      }
      const loose = cache.get(id, LOOSE_CHUNK_KEY);
      if (loose) Object.assign(cells, loose.cells);
      return { cells, state };
    },

    async readRange(range) {
      await this.ensureRange(range);
      return this.peekRange(range);
    },

    /**
     * Writes through to the backing store so the block on disk and the block in
     * memory never disagree. The block must be resident first, or the write
     * would persist a chunk containing only the edited cells.
     */
    async writeCells(changes) {
      const byChunk = new Map();
      for (const [target, cell] of Object.entries(changes)) {
        const chunkKey = chunkKeyForCellId(target);
        let group = byChunk.get(chunkKey);
        if (!group) {
          group = {};
          byChunk.set(chunkKey, group);
        }
        group[target] = cell;
      }

      await loadChunks([...byChunk.keys()]);

      const put = [];
      const remove = [];
      for (const [chunkKey, group] of byChunk) {
        const cells = { ...(cache.get(id, chunkKey)?.cells || {}) };
        for (const [target, cell] of Object.entries(group)) {
          if (cell === null || cell === undefined) delete cells[target];
          else cells[target] = cell;
        }
        cache.set(id, chunkKey, cells);
        if (Object.keys(cells).length) put.push({ chunkKey, cells });
        else remove.push(chunkKey);
      }

      await store.writeChunks(id, put, remove);
      notify();
    },

    /** Keeps values readable while the next read is in flight. */
    invalidate() {
      cache.invalidateObject(id);
      notify();
    },

    async drop() {
      cache.dropObject(id);
      inFlight.clear();
      await store.dropObject(id);
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    metrics() {
      return { ...cache.metrics(), inFlight: inFlight.size };
    },
  };
}
