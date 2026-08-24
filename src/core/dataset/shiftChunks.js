// Row and column insert/delete shift every cell at or past the index by one.
// That is not a block-aligned move: a one-row shift pushes the last row of
// each block into the next one, so the stored blocks cannot simply be rekeyed
// and every block at or past the index has to be rewritten.
//
// The rewrite streams. A one-step shift can only move a cell into an adjacent
// band, so once band N has been read, band N-2 can receive nothing further and
// is written out. Only a couple of bands are ever held in memory, which is the
// whole point: a partial sheet must be able to shift cells it has never loaded.

import { cellAddress, cellId } from "../sheet/coordinates.js";
import { adjustFormulaForAxis } from "../sheet/structure.js";
import { cellsFromChunks, chunkColumnFor, chunkRowFor, groupCellsIntoChunks, parseChunkKey } from "./cellChunks.js";

// Cells outside the r{n}c{n} scheme have no coordinates to shift.
export function bandOfChunkKey(key, axis) {
  const parsed = parseChunkKey(key);
  if (!parsed) return null;
  return axis === "row" ? parsed.chunkRow : parsed.chunkColumn;
}

export function bandForIndex(index, axis) {
  return axis === "row" ? chunkRowFor(index) : chunkColumnFor(index);
}

function shiftedCoordinate(current, index, operation) {
  if (operation === "insert") return current >= index ? current + 1 : current;
  return current > index ? current - 1 : current;
}

export function shiftCellsForAxis(cells, axis, index, operation) {
  const next = {};
  for (const [fallbackId, cell] of Object.entries(cells || {})) {
    if (!cell) continue;
    const current = axis === "row" ? cell.row : cell.column;
    if (operation === "delete" && current === index) continue;
    const moved = shiftedCoordinate(current, index, operation);
    if (moved === current) {
      next[String(cell.id || fallbackId)] = cell;
      continue;
    }
    const row = axis === "row" ? moved : cell.row;
    const column = axis === "column" ? moved : cell.column;
    const shifted = {
      ...cell,
      id: cellId(row, column),
      address: cellAddress(row, column),
      row,
      column,
      formula: adjustFormulaForAxis(cell.formula, axis, index, operation),
    };
    next[shifted.id] = shifted;
  }
  return next;
}

export async function shiftStoredCells(store, objectId, { axis, index, operation }) {
  const keys = await store.listChunkKeys(objectId);
  const first = bandForIndex(Math.max(0, index), axis);
  const byBand = new Map();
  const sourceKeys = new Set();
  for (const key of keys) {
    const band = bandOfChunkKey(key, axis);
    if (band === null || band < first) continue;
    sourceKeys.add(key);
    if (!byBand.has(band)) byBand.set(band, []);
    byBand.get(band).push(key);
  }
  if (!byBand.size) return { bands: 0, written: 0, removed: 0 };

  const pending = new Map();
  const written = new Set();

  const flushThrough = async (limit) => {
    const put = [];
    for (const [key, cells] of [...pending]) {
      const band = bandOfChunkKey(key, axis);
      if (band === null || band > limit) continue;
      pending.delete(key);
      if (!Object.keys(cells).length) continue;
      put.push({ chunkKey: key, cells });
      written.add(key);
    }
    if (put.length) await store.writeChunks(objectId, put, []);
  };

  for (const band of [...byBand.keys()].sort((a, b) => a - b)) {
    // Never flush a band that a yet-unread band could still contribute to.
    await flushThrough(band - 2);
    const records = await store.readChunks(objectId, byBand.get(band));
    const shifted = shiftCellsForAxis(cellsFromChunks(records), axis, index, operation);
    for (const [key, chunk] of groupCellsIntoChunks(shifted)) {
      const target = pending.get(key) || {};
      Object.assign(target, chunk.cells);
      pending.set(key, target);
    }
  }
  await flushThrough(Number.POSITIVE_INFINITY);

  const removed = [...sourceKeys].filter((key) => !written.has(key));
  if (removed.length) await store.writeChunks(objectId, [], removed);
  return { bands: byBand.size, written: written.size, removed: removed.length };
}

/** Merges cells into their blocks, leaving the rest of each block alone. */
export async function writeCellsIntoChunks(store, objectId, cells) {
  const grouped = [...groupCellsIntoChunks(cells).values()];
  if (!grouped.length) return;
  const existing = await store.readChunks(
    objectId,
    grouped.map((chunk) => chunk.chunkKey),
  );
  const byKey = new Map(existing.map((record) => [record.chunkKey, record.cells || {}]));
  await store.writeChunks(
    objectId,
    grouped.map((chunk) => ({
      chunkKey: chunk.chunkKey,
      cells: { ...(byKey.get(chunk.chunkKey) || {}), ...chunk.cells },
    })),
    [],
  );
}
