import { createCellRecord, createSheetObject } from "../../src/core/workspace/model.js";
import { cellAddress, cellId } from "../../src/core/sheet/coordinates.js";

export { cellAddress, cellId };

/**
 * Builds a sheet by asking `fill` for each coordinate. Returning null keeps the
 * cell absent so sheets stay sparse.
 */
export function buildSheet({ id, title, rows, columns, fill }) {
  const cells = {};
  let used = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const patch = fill(row, column);
      if (!patch) continue;
      cells[cellId(row, column)] = createCellRecord(row, column, patch);
      used += 1;
    }
  }
  return { sheet: createSheetObject({ id, title, rows, columns, cells }), usedCellCount: used };
}

export function countUsedCells(workspace) {
  let total = 0;
  for (const object of Object.values(workspace.objects)) {
    if (object?.type === "sheet") total += Object.keys(object.cells || {}).length;
  }
  return total;
}

export function countFormulas(workspace) {
  let total = 0;
  for (const object of Object.values(workspace.objects)) {
    if (object?.type !== "sheet") continue;
    for (const cell of Object.values(object.cells || {})) {
      if (cell?.formula) total += 1;
    }
  }
  return total;
}

export function scenarioCounts(workspace) {
  return {
    objects: Object.keys(workspace.objects).length,
    usedCells: countUsedCells(workspace),
    formulas: countFormulas(workspace),
  };
}
