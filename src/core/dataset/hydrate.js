// Whole-map reads for sheets that only keep part of themselves in memory.
//
// A virtual sheet is resident for the blocks the grid asked for, which is the
// point of it. Anything that serializes a workspace needs the opposite: every
// cell, including the ones no one has scrolled to. Export, the native folder
// mirror, and any future whole-sheet scan have to come through here, otherwise
// they would write out whichever handful of blocks happened to be on screen and
// the user would lose the rest.

import { cellsFromChunks } from "./cellChunks.js";

/** Every cell a sheet has in the backing store, block order irrelevant. */
export async function readAllCells(store, objectId) {
  const keys = await store.listChunkKeys(objectId);
  if (!keys.length) return {};
  return cellsFromChunks(await store.readChunks(objectId, keys));
}

/**
 * Returns `workspace` with the named sheets filled in from `store`.
 *
 * Cells already in memory win over stored ones: an edit is written through to
 * its block, but a write that has not landed yet would otherwise be reverted by
 * the copy on disk.
 */
export async function hydrateWorkspaceCells(store, workspace, objectIds) {
  if (!store || !objectIds?.length) return workspace;

  const objects = { ...(workspace?.objects || {}) };
  let changed = false;

  for (const objectId of objectIds) {
    const object = objects[objectId];
    if (object?.type !== "sheet") continue;
    const stored = await readAllCells(store, objectId);
    if (!Object.keys(stored).length) continue;
    objects[objectId] = { ...object, cells: { ...stored, ...(object.cells || {}) } };
    changed = true;
  }

  return changed ? { ...workspace, objects } : workspace;
}
