// The parts of a sheet that have to stay known even when its cells do not.
//
// Two readers cannot tolerate a partially resident sheet: topology repair walks
// embedded cells to find the parent/child relationships between objects, and
// the formula engine has to know a formula exists before it can be invalidated.
// Both are sparse - a large sheet is mostly values - so keeping just those cells
// resident costs a fraction of the sheet and removes the reason to hold it all.
//
// The index is derived from the blocks rather than maintained alongside them.
// A cache that is written in one place and read in another drifts; reading the
// blocks means the index cannot disagree with what is stored.

import { cellsFromChunks } from "./cellChunks.js";

// Blocks are read in batches so building the index never needs the whole sheet
// in memory at once, which is the situation the index exists to avoid.
export const DEFAULT_INDEX_BATCH_CHUNKS = 32;

export function emptySheetIndex() {
  return { embeds: {}, formulas: {} };
}

export function buildSheetIndex(cells, into = emptySheetIndex()) {
  for (const [fallbackId, cell] of Object.entries(cells || {})) {
    const id = String(cell?.id || fallbackId);
    if (cell?.embed?.objectId) into.embeds[id] = cell;
    if (cell?.formula) into.formulas[id] = cell;
  }
  return into;
}

export async function readSheetIndex(store, objectId, { batchSize = DEFAULT_INDEX_BATCH_CHUNKS } = {}) {
  const keys = await store.listChunkKeys(objectId);
  const index = emptySheetIndex();
  for (let start = 0; start < keys.length; start += batchSize) {
    const records = await store.readChunks(objectId, keys.slice(start, start + batchSize));
    buildSheetIndex(cellsFromChunks(records), index);
  }
  return index;
}

/**
 * Applies cell changes to an index in place.
 *
 * A cell that stops being a formula, or stops being an embed, has to leave the
 * index; otherwise topology would keep repairing a relationship the user
 * deleted.
 */
export function mergeSheetIndex(index, changes) {
  for (const [fallbackId, cell] of Object.entries(changes || {})) {
    const id = String(cell?.id || fallbackId);
    if (cell?.embed?.objectId) index.embeds[id] = cell;
    else delete index.embeds[id];
    if (cell?.formula) index.formulas[id] = cell;
    else delete index.formulas[id];
  }
  return index;
}

export function sheetIndexSize(index) {
  return Object.keys(index?.embeds || {}).length + Object.keys(index?.formulas || {}).length;
}

/**
 * The cells a sheet must keep even when the rest of it is paged out.
 *
 * Topology repair and a full formula rebuild both run synchronously during
 * render, so the cells they need cannot be fetched on demand. Keeping them
 * resident lets both carry on reading `object.cells` unchanged.
 */
export function sheetResidencyFloor(cells) {
  const index = buildSheetIndex(cells);
  return { ...index.embeds, ...index.formulas };
}

// Symbols survive object spread but never reach JSON, so a sheet stays marked
// through the copies the workspace makes on every edit without the mark
// leaking into a saved or exported file.
export const PARTIAL_CELLS = Symbol.for("tactile.partialCells");

/** Marks a sheet whose `cells` is a floor rather than the whole sheet. */
export function markPartialCells(object) {
  object[PARTIAL_CELLS] = true;
  return object;
}

export function isPartialCells(object) {
  return Boolean(object?.[PARTIAL_CELLS]);
}

/**
 * Whether it is safe to rewrite a sheet's stored blocks from `object.cells`.
 *
 * A partial sheet's blocks are where its cells came from and are already
 * current, so rewriting from the floor would delete everything outside it.
 */
export function canRewriteCells(object) {
  return !isPartialCells(object);
}
