import { cellAddress } from "../../sheet/coordinates.js";
import {
  adjustAxisGroups,
  adjustColumnFilters,
  adjustConditionalFormats,
  adjustFormulaForAxis,
} from "../../sheet/structure.js";

function shiftAxisSizes(sizes, index, operation) {
  const next = {};
  Object.entries(sizes || {}).forEach(([key, value]) => {
    const current = Number(key);
    if (!Number.isInteger(current)) return;
    if (operation === "delete" && current === index) return;
    const shifted = operation === "insert" && current >= index
      ? current + 1
      : operation === "delete" && current > index
        ? current - 1
        : current;
    next[shifted] = value;
  });
  return next;
}

export function remapSheetAxisResult(object, axis, index, operation) {
  const cells = {};
  const embeddedLinks = [];
  Object.values(object.cells || {}).forEach((cell) => {
    if (operation === "delete"
      && ((axis === "row" && cell.row === index) || (axis === "column" && cell.column === index))) return;
    const row = axis === "row"
      ? operation === "insert" && cell.row >= index
        ? cell.row + 1
        : operation === "delete" && cell.row > index
          ? cell.row - 1
          : cell.row
      : cell.row;
    const column = axis === "column"
      ? operation === "insert" && cell.column >= index
        ? cell.column + 1
        : operation === "delete" && cell.column > index
          ? cell.column - 1
          : cell.column
      : cell.column;
    const shifted = {
      ...cell,
      id: `r${row + 1}c${column + 1}`,
      address: cellAddress(row, column),
      row,
      column,
      formula: adjustFormulaForAxis(cell.formula, axis, index, operation),
    };
    cells[shifted.id] = shifted;
    if (shifted.embed?.objectId) {
      embeddedLinks.push({
        objectId: shifted.embed.objectId,
        linkId: shifted.embed.linkId,
        sourceCellId: shifted.id,
        sourceAddress: shifted.address,
      });
    }
  });
  return { object: {
    ...object,
    rows: axis === "row"
      ? Math.max(256, object.rows + (operation === "insert" ? 1 : -1))
      : object.rows,
    columns: axis === "column"
      ? Math.max(64, object.columns + (operation === "insert" ? 1 : -1))
      : object.columns,
    cells,
    rowHeights: axis === "row" ? shiftAxisSizes(object.rowHeights, index, operation) : object.rowHeights,
    columnWidths: axis === "column" ? shiftAxisSizes(object.columnWidths, index, operation) : object.columnWidths,
    rowGroups: axis === "row" ? adjustAxisGroups(object.rowGroups, index, operation) : object.rowGroups,
    columnGroups: axis === "column" ? adjustAxisGroups(object.columnGroups, index, operation) : object.columnGroups,
    filters: axis === "column" ? adjustColumnFilters(object.filters, index, operation) : object.filters,
    conditionalFormats: adjustConditionalFormats(object.conditionalFormats, axis, index, operation),
  }, embeddedLinks };
}

export function remapSheetAxis(object, axis, index, operation) {
  return remapSheetAxisResult(object, axis, index, operation).object;
}