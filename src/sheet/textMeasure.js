import { cellAddress, columnLabel, coordinatesFromCellId } from "./coordinates.js";
import { formatCellValue } from "./formatting.js";
import { formatFormulaResult } from "./formulas.js";
import { isBareUrlValue } from "../model.js";

let textMeasureContext = null;

export function measureTextWidth(text, fontSize = DEFAULT_CELL_FONT, bold = false) {
  const source = String(text ?? "");
  if (typeof document === "undefined") return source.length * fontSize * 0.58;
  if (!textMeasureContext) textMeasureContext = document.createElement("canvas").getContext("2d");
  const context = textMeasureContext;
  context.font = `${bold ? "700 " : "400 "}${fontSize}px "Public Sans Variable", "Segoe UI Variable", Arial, sans-serif`;
  return context.measureText(source).width;
}

export const DEFAULT_CELL_FONT = 11.5;
export const CELL_H_PADDING = 16; // 0 8px on the tile face
export const COLUMN_FIT_GAP = 10; // breathing room beyond the tile face padding
export const EMBED_ICON_WIDTH = 14; // ObjectGlyph/IconExternalLink size in embedded & link cells
export const EMBED_ICON_GAP = 6; // .cell-content flex gap between the icon and its label
export const CELL_V_PADDING = 14; // vertical breathing above/below one line
export const CELL_LINE_HEIGHT = 1.18;
export const AUTO_FIT_COLUMN_MAX = 420;
export const AUTO_FIT_ROW_MAX = 96;

/**
 * The widest single rendered line of a cell value. Multi-line values are
 * measured line by line so embedded newlines never inflate the column width.
 */
function widestLineWidth(text, fontSize = DEFAULT_CELL_FONT, bold = false) {
  let widest = 0;
  String(text ?? "").split("\n").forEach((line) => {
    const width = measureTextWidth(line, fontSize, bold);
    if (width > widest) widest = width;
  });
  return widest;
}

function displayValueForCell(cell, row, column, formulaValues) {
  if (cell?.formula) return formatFormulaResult(formulaValues?.get(cellAddress(row, column)));
  if (cell?.embed) return cell.value || "";
  return formatCellValue(cell?.value, cell?.style);
}

export function wrappedLineCount(text, columnWidth, fontSize = DEFAULT_CELL_FONT, bold = false) {
  const segments = String(text ?? "").split("\n");
  const usableWidth = Math.max(40, (Number(columnWidth) || 40) - CELL_H_PADDING);
  let lines = 0;
  segments.forEach((segment) => {
    if (!segment) {
      lines += 1;
      return;
    }
    lines += Math.max(1, Math.ceil(measureTextWidth(segment, fontSize, bold) / usableWidth));
  });
  return Math.max(1, lines);
}

/**
 * The natural width of a column: the widest rendered cell content (including
 * formula results and per-cell font size) plus tile face padding and a little
 * breathing room. Multi-line values contribute their widest single line so an
 * embedded newline never inflates the width. The caller caps the result.
 */
export function naturalColumnWidth(object, column, formulaValues) {
  return columnFitWidth(measureColumnWidths(object, formulaValues), column);
}

/**
 * Single-pass column measurement for fast multi-column fit. Returns
 * Map<columnIndex, fittedWidth> computed in one sweep over the sparse cells
 * map, instead of re-scanning every cell once per column.
 */
export function measureColumnWidths(object, formulaValues, displayForCell = null) {
  const widths = new Map();
  Object.entries(object.cells || {}).forEach(([id, cell]) => {
    const coordinates = coordinatesFromCellId(id);
    if (!coordinates) return;
    const fontSize = Number(cell?.style?.fontSize) || DEFAULT_CELL_FONT;
    const text = displayForCell
      ? displayForCell(cell, coordinates.row, coordinates.column)
      : displayValueForCell(cell, coordinates.row, coordinates.column, formulaValues);
    const hasPillIcon = Boolean(cell?.embed) || isBareUrlValue(cell?.value);
    const width = widestLineWidth(text, fontSize, Boolean(cell?.style?.bold))
      + CELL_H_PADDING
      + COLUMN_FIT_GAP
      + (hasPillIcon ? EMBED_ICON_WIDTH + EMBED_ICON_GAP : 0);
    const current = widths.get(coordinates.column);
    if (width > (current || 0)) widths.set(coordinates.column, width);
  });
  return widths;
}

/**
 * The fitted width for a column from a `measureColumnWidths` result, ensuring
 * the header label always fits.
 */
export function columnFitWidth(widths, column) {
  const headerWidth = measureTextWidth(columnLabel(column), 10) + CELL_H_PADDING + COLUMN_FIT_GAP;
  return Math.ceil(Math.max(widths.get(column) || 0, headerWidth));
}

/**
 * The natural height of a row: the tallest cell in the row once wrapping and
 * explicit newlines are accounted for at the row's column widths. Non-wrapped
 * single-line rows resolve to their largest font size. `columnWidthForIndex`
 * lets wrapped cells count their lines against the real column they sit in.
 */
export function naturalRowHeight(object, row, columnWidthForIndex) {
  return rowFitHeight(measureRowHeights(object, columnWidthForIndex), row);
}

/**
 * Single-pass row measurement for fast multi-row fit. Returns
 * Map<rowIndex, fittedHeight> computed in one sweep over the sparse cells map.
 * Wrapped cells count their lines against the current column width via
 * `columnWidthForIndex`.
 */
export function measureRowHeights(object, columnWidthForIndex) {
  const heights = new Map();
  Object.entries(object.cells || {}).forEach(([id, cell]) => {
    const coordinates = coordinatesFromCellId(id);
    if (!coordinates) return;
    const fontSize = Number(cell?.style?.fontSize) || DEFAULT_CELL_FONT;
    const value = cell?.value ?? "";
    const wraps = Boolean(cell?.style?.wrap) || String(value).includes("\n");
    const columnWidth = columnWidthForIndex?.(coordinates.column) || 0;
    const lines = wraps
      ? wrappedLineCount(value, columnWidth, fontSize, Boolean(cell?.style?.bold))
      : 1;
    const height = Math.ceil(lines * fontSize * CELL_LINE_HEIGHT + CELL_V_PADDING);
    const current = heights.get(coordinates.row);
    if (height > (current || 0)) heights.set(coordinates.row, height);
  });
  return heights;
}

/**
 * The fitted height for a row from a `measureRowHeights` result, ensuring the
 * single-line baseline always fits.
 */
export function rowFitHeight(heights, row) {
  const baseline = Math.ceil(DEFAULT_CELL_FONT * CELL_LINE_HEIGHT + CELL_V_PADDING);
  return Math.ceil(Math.max(heights.get(row) || 0, baseline));
}

/**
 * The height a row needs to show wrapped or explicitly multi-line content.
 * Non-wrapped, single-line rows report null so the sheet keeps its compact
 * default/explicit height instead of inflating every row.
 */
export function autoRowHeight(object, row, columnWidthForIndex) {
  let maxHeight = 0;
  Object.entries(object.cells || {}).forEach(([id, cell]) => {
    const coordinates = coordinatesFromCellId(id);
    if (!coordinates || coordinates.row !== row) return;
    const value = cell?.value ?? "";
    if (!cell?.style?.wrap && !String(value).includes("\n")) return;
    const fontSize = Number(cell?.style?.fontSize) || DEFAULT_CELL_FONT;
    const columnWidth = columnWidthForIndex?.(coordinates.column) || 0;
    const lines = wrappedLineCount(value, columnWidth, fontSize, Boolean(cell?.style?.bold));
    if (lines <= 1) return;
    const height = Math.ceil(lines * fontSize * CELL_LINE_HEIGHT + CELL_V_PADDING);
    if (height > maxHeight) maxHeight = height;
  });
  return maxHeight > 0 ? maxHeight : null;
}

/**
 * Compute auto heights only for rows that contain wrapped or multi-line cells.
 * Returns a sparse map keyed by row index. `liveDrafts` is an optional map of
 * cellId -> { value, formula, displayValue } so rows can grow while a cell is
 * being edited inline, before the value is committed to the object.
 */
export function autoRowHeights(object, columnWidthForIndex, liveDrafts = null) {
  const heights = {};
  const consider = (id, value, wrap) => {
    if (!wrap && !String(value ?? "").includes("\n")) return;
    const coordinates = coordinatesFromCellId(id);
    if (!coordinates) return;
    const cell = object.cells?.[id] || {};
    const fontSize = Number(cell?.style?.fontSize) || DEFAULT_CELL_FONT;
    const columnWidth = columnWidthForIndex?.(coordinates.column) || 0;
    const lines = wrappedLineCount(value, columnWidth, fontSize, Boolean(cell?.style?.bold));
    if (lines <= 1) return;
    const height = Math.ceil(lines * fontSize * CELL_LINE_HEIGHT + CELL_V_PADDING);
    if (height > (heights[coordinates.row] || 0)) heights[coordinates.row] = height;
  };
  Object.entries(object.cells || {}).forEach(([id, cell]) => {
    consider(id, cell?.value, cell?.style?.wrap);
  });
  if (liveDrafts) {
    liveDrafts.forEach((draft, id) => {
      const value = draft?.formula ? draft.displayValue || draft.formula : draft?.value;
      consider(id, value, true);
    });
  }
  return heights;
}
