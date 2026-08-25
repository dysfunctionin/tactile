// Sheet `cells` dicts are the only structure mutated in place; everything else
// (cell records, assets, groups, filters, themes) is replaced wholesale on
// write. So an undo snapshot can share every cells map by reference, provided
// the next in-place mutation copies the map first.
const capturedCellMaps = new WeakSet();

/**
 * Undo snapshot of a workspace. O(objects), not O(cells): the deep clone this
 * replaces walked every cell record on each structural edit.
 */
export function cloneHistoryWorkspace(workspace) {
  for (const object of Object.values(workspace?.objects || {})) {
    if (object?.cells) capturedCellMaps.add(object.cells);
  }
  return { ...workspace, objects: { ...(workspace?.objects || {}) } };
}

/**
 * Returns a cells map safe to mutate in place, copying it once if an undo
 * snapshot still references it.
 */
export function cellsForMutation(cells) {
  if (!cells || !capturedCellMaps.has(cells)) return cells;
  return { ...cells };
}
