// Which sheets pay for partial residency.
//
// Virtual residency trades a synchronous read for a bounded footprint. That is
// a bad trade for a small sheet, where holding every cell costs less than the
// bookkeeping, so the mode is chosen per sheet rather than per workspace.

export const VIRTUAL_CELL_THRESHOLD = 50_000;

export function sheetCellCount(object) {
  return Object.keys(object?.cells || {}).length;
}

export function createStorageModePolicy({ threshold = VIRTUAL_CELL_THRESHOLD } = {}) {
  const modes = new Map();

  return {
    threshold,

    modeFor(objectId, cellCount) {
      const id = String(objectId);
      // Sticky in one direction only. A sheet that crossed the threshold keeps
      // its blocks on disk, so falling back to eager would mean loading every
      // one of them again just because an edit dropped the count.
      if (modes.get(id) === "virtual") return "virtual";
      const mode = cellCount >= threshold ? "virtual" : "eager";
      modes.set(id, mode);
      return mode;
    },

    modeForSheet(object) {
      return this.modeFor(object.id, sheetCellCount(object));
    },

    /** Called when an object is closed or deleted; the next open decides again. */
    forget(objectId) {
      modes.delete(String(objectId));
    },
  };
}
