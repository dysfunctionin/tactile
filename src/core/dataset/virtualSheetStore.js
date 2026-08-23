import { cellId } from "../sheet/coordinates.js";

import { chunkKeyForCoordinates } from "./cellChunks.js";
import { sheetColumnIndex, sheetColumnName } from "./sheetColumns.js";
import { createVirtualSheet } from "./virtualSheet.js";

/**
 * The `"virtual"` counterpart to `SheetSnapshotDatasetStore`.
 *
 * Both answer the same window request, so the grid does not care which one it
 * is reading. The difference is that this one may answer with cells it does not
 * have yet: every cell carries the residency state of its block, and a caller
 * that ignores that state will render an unloaded sheet as an empty one.
 *
 * Aggregates are deliberately absent. Scanning a range here would defeat the
 * point by making every block resident; they belong in the backing store.
 */
export function createVirtualSheetDatasetStore({
  store,
  object,
  revision,
  cache,
  overscanChunks,
}) {
  if (!store) throw new TypeError("createVirtualSheetDatasetStore requires a chunk store.");
  const id = String(object.id);
  const sheet = createVirtualSheet({ store, objectId: id, cache, overscanChunks });
  const listeners = new Set();
  let snapshot = object;
  let currentRevision = String(revision);

  function notify() {
    for (const listener of [...listeners]) listener(currentRevision);
  }

  function descriptor() {
    return {
      id,
      objectId: id,
      title: snapshot.title,
      storageMode: "virtual",
      rowCount: snapshot.rows,
      columns: Array.from({ length: snapshot.columns }, (_, logicalIndex) => ({
        id: sheetColumnName(logicalIndex),
        name: String(logicalIndex + 1),
        logicalIndex,
      })),
      revision: currentRevision,
    };
  }

  return {
    sheet,
    descriptor,

    update(nextObject, nextRevision) {
      snapshot = nextObject;
      const next = String(nextRevision);
      if (next === currentRevision) return;
      currentRevision = next;
      // Marks resident blocks stale rather than dropping them, so the grid keeps
      // painting the previous values while the refresh is in flight.
      sheet.invalidate();
      notify();
    },

    async openCatalog(signal) {
      signal?.throwIfAborted();
      return { datasets: [descriptor()], revision: currentRevision };
    },

    async readWindow(request) {
      request.signal?.throwIfAborted();
      const indexes = request.columnIds.map(sheetColumnIndex);
      if (indexes.some((index) => index === null || index >= snapshot.columns)) {
        throw new RangeError(`Dataset ${String(request.datasetId)} received an invalid column projection.`);
      }

      const rowStart = Math.max(0, Number(request.rowStart));
      const rowEnd = Math.min(Number(request.rowEnd), snapshot.rows - 1);
      if (indexes.length && rowEnd >= rowStart) {
        // A projection can skip columns, so the residency request spans the
        // extremes rather than each one; blocks are wider than most gaps anyway.
        await sheet.ensureRange({
          rowStart,
          rowEnd,
          columnStart: Math.min(...indexes),
          columnEnd: Math.max(...indexes),
        });
      }
      request.signal?.throwIfAborted();

      // Residency is a property of the block, so it is resolved once per block
      // rather than once per cell.
      const blocks = new Map();
      const blockAt = (row, column) => {
        const key = chunkKeyForCoordinates(row, column);
        if (!blocks.has(key)) blocks.set(key, sheet.cache.get(id, key));
        return blocks.get(key);
      };

      const rows = [];
      for (let row = rowStart; row <= rowEnd; row += 1) {
        rows.push({
          id: `sheet-row:${row}`,
          logicalIndex: row,
          cells: indexes.map((column, projectionIndex) => {
            const block = blockAt(row, column);
            const record = block?.cells[cellId(row, column)];
            return {
              columnId: request.columnIds[projectionIndex],
              value: record?.value ?? "",
              ...(record ? { record } : {}),
              state: block ? block.state : "pending",
            };
          }),
        });
      }

      return {
        datasetId: request.datasetId,
        rowStart: request.rowStart,
        rows,
        columnIds: request.columnIds,
        totalRowCount: snapshot.rows,
        revision: currentRevision,
      };
    },

    async writeCells(changes) {
      await sheet.writeCells(changes);
      notify();
    },

    subscribe(_datasetId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    metrics() {
      return sheet.metrics();
    },

    async close() {
      listeners.clear();
    },
  };
}
