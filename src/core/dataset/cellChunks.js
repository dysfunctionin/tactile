// The persistence-facing chunk layout. A chunk is the smallest unit any
// backing store reads, writes, evicts or caches, so this file is the single
// place that decides how cells group together across the browser and native
// adapters.

import { coordinatesFromCellId } from "../sheet/coordinates.js";

export const CELL_CHUNK_ROWS = 64;
export const CELL_CHUNK_COLUMNS = 64;

// Cells whose id predates the r{n}c{n} scheme cannot be placed on the grid, so
// they share one chunk that always loads with the object.
export const LOOSE_CHUNK_KEY = "loose";

export function chunkRowFor(row) {
  return Math.floor(row / CELL_CHUNK_ROWS);
}

export function chunkColumnFor(column) {
  return Math.floor(column / CELL_CHUNK_COLUMNS);
}

export function chunkKey(chunkRow, chunkColumn) {
  return `${chunkRow}:${chunkColumn}`;
}

export function chunkKeyForCoordinates(row, column) {
  return chunkKey(chunkRowFor(row), chunkColumnFor(column));
}

export function chunkKeyForCellId(id) {
  const coordinates = coordinatesFromCellId(id);
  if (!coordinates) return LOOSE_CHUNK_KEY;
  return chunkKeyForCoordinates(coordinates.row, coordinates.column);
}

export function parseChunkKey(key) {
  if (key === LOOSE_CHUNK_KEY) return null;
  const match = /^(\d+):(\d+)$/.exec(String(key || ""));
  if (!match) return null;
  return { chunkRow: Number(match[1]), chunkColumn: Number(match[2]) };
}

export function chunkKeysForRange({ rowStart, rowEnd, columnStart, columnEnd }) {
  const keys = [];
  const firstRow = chunkRowFor(Math.max(0, rowStart));
  const lastRow = chunkRowFor(Math.max(0, rowEnd));
  const firstColumn = chunkColumnFor(Math.max(0, columnStart));
  const lastColumn = chunkColumnFor(Math.max(0, columnEnd));
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      keys.push(chunkKey(row, column));
    }
  }
  return keys;
}

export function groupCellsIntoChunks(cells) {
  const chunks = new Map();
  for (const [fallbackId, cell] of Object.entries(cells || {})) {
    const id = String(cell?.id || fallbackId);
    const key = chunkKeyForCellId(id);
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = { chunkKey: key, cells: {} };
      chunks.set(key, chunk);
    }
    chunk.cells[id] = cell;
  }
  return chunks;
}

export function cellsFromChunks(chunkRecords) {
  const cells = {};
  for (const record of chunkRecords || []) {
    Object.assign(cells, record?.cells || {});
  }
  return cells;
}
