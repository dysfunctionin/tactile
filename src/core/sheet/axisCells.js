import { cellAddress, cellId } from "./coordinates.js";
import { adjustFormulaForAxis, reorderFormulaForAxis } from "./structure.js";

export function shiftCells(object, axis, index) {
  const cells = {};
  Object.values(object.cells || {}).forEach((cell) => {
    const row = axis === "row" && cell.row >= index ? cell.row + 1 : cell.row;
    const column = axis === "column" && cell.column >= index ? cell.column + 1 : cell.column;
    if (row === cell.row && column === cell.column) {
      // Unchanged cell: keep the existing record (stable id/address/formula).
      cells[cell.id] = cell;
      return;
    }
    const shifted = {
      ...cell,
      id: cellId(row, column),
      address: cellAddress(row, column),
      row,
      column,
      formula: adjustFormulaForAxis(cell.formula, axis, index, "insert"),
    };
    cells[shifted.id] = shifted;
  });
  return cells;
}

export function removeSheetAxisCells(object, axis, index) {
  const cells = {};
  Object.values(object.cells || {}).forEach((cell) => {
    if ((axis === "row" && cell.row === index) || (axis === "column" && cell.column === index)) return;
    const row = axis === "row" && cell.row > index ? cell.row - 1 : cell.row;
    const column = axis === "column" && cell.column > index ? cell.column - 1 : cell.column;
    if (row === cell.row && column === cell.column) {
      // Unchanged cell: keep the existing record (stable id/address/formula).
      cells[cell.id] = cell;
      return;
    }
    const shifted = {
      ...cell,
      id: cellId(row, column),
      address: cellAddress(row, column),
      row,
      column,
      formula: adjustFormulaForAxis(cell.formula, axis, index, "delete"),
    };
    cells[shifted.id] = shifted;
  });
  return cells;
}

export function shiftAxisSizes(sizes, index, operation) {
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

export function reorderAxisSizes(sizes, indexMap) {
  const next = {};
  Object.entries(sizes || {}).forEach(([key, value]) => {
    const current = Number(key);
    const reordered = indexMap.get(current);
    if (Number.isInteger(reordered)) next[reordered] = value;
  });
  return next;
}

export function reorderSheetAxis(object, axis, from, to) {
  const length = axis === "row" ? object.rows : object.columns;
  if (from === to || from < 0 || to < 0 || from >= length || to >= length) return object;
  const order = Array.from({ length }, (_, index) => index);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const indexMap = new Map(order.map((original, next) => [original, next]));
  const cells = {};
  Object.values(object.cells || {}).forEach((cell) => {
    const row = axis === "row" ? indexMap.get(cell.row) : cell.row;
    const column = axis === "column" ? indexMap.get(cell.column) : cell.column;
    if (row === cell.row && column === cell.column) {
      // Cell sits on a stationary axis position: keep the existing record.
      cells[cell.id] = cell;
      return;
    }
    const shifted = {
      ...cell,
      id: cellId(row, column),
      address: cellAddress(row, column),
      row,
      column,
      formula: reorderFormulaForAxis(cell.formula, axis, indexMap),
    };
    cells[shifted.id] = shifted;
  });
  return {
    ...object,
    cells,
    rowHeights: axis === "row" ? reorderAxisSizes(object.rowHeights, indexMap) : object.rowHeights,
    columnWidths: axis === "column" ? reorderAxisSizes(object.columnWidths, indexMap) : object.columnWidths,
    filters: axis === "column"
      ? (object.filters || []).map((filter) => ({ ...filter, column: indexMap.get(filter.column) ?? filter.column }))
      : object.filters,
    conditionalFormats: (object.conditionalFormats || []).map((rule) => ({
      ...rule,
      range: reorderFormulaForAxis(`=${rule.range}`, axis, indexMap).slice(1),
    })),
  };
}
