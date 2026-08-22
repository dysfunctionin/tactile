import { cellAddress, columnLabel, coordinatesFromCellId } from "./coordinates.js";
import { formatCellValue } from "./formatting.js";
import { formatFormulaResult } from "./formulas.js";
import { isBareUrlValue } from "../model.js";
import { cellChangeVersion, cellChangesSince } from "../objects/sheet/grid/cellChangeJournal.js";

let textMeasureContext = null;
// Narrow bounded cache keyed by (bold, fontSize, text). autoRowHeights and
// autofit re-measure the same cell strings across render passes (every draft
// tick/commit), so the canvas measureText round-trip is the per-keystroke hot
// spot. FIFO eviction bounds the cache while keeping recent measurements live.
const TEXT_MEASURE_CACHE_LIMIT = 8_192;
const TEXT_MEASURE_CACHE = new Map();

export function measureTextWidth(text, fontSize = DEFAULT_CELL_FONT, bold = false) {
  const source = String(text ?? "");
  if (typeof document === "undefined") return source.length * fontSize * 0.58;
  const key = `${bold ? 1 : 0}|${fontSize}|${source}`;
  // Don't trust cached widths until the webfonts have finished loading: a
  // measurement taken against the fallback stack would be cached forever
  // otherwise. Once document.fonts settles, the cache is populated correctly.
  const fontsReady = !document.fonts || document.fonts.status === "loaded";
  if (fontsReady) {
    const cached = TEXT_MEASURE_CACHE.get(key);
    if (cached !== undefined) return cached;
  }
  if (!textMeasureContext) textMeasureContext = document.createElement("canvas").getContext("2d");
  const context = textMeasureContext;
  context.font = `${bold ? "700 " : "400 "}${fontSize}px "Public Sans Variable", "Segoe UI Variable", Arial, sans-serif`;
  const width = context.measureText(source).width;
  if (fontsReady) {
    if (TEXT_MEASURE_CACHE.size >= TEXT_MEASURE_CACHE_LIMIT) {
      TEXT_MEASURE_CACHE.delete(TEXT_MEASURE_CACHE.keys().next().value);
    }
    TEXT_MEASURE_CACHE.set(key, width);
  }
  return width;
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
 *
 * With `onlyDrafts` set, the full stored-cell scan is skipped and only the
 * live drafts are measured. The grid uses this on every keystroke: the base
 * map (all stored cells) is memoized on the committed sheet object, and the
 * draft-only pass (a single cell) runs per keystroke, so typing never pays
 * the O(stored cells) scan. Consumers must merge this into the base map
 * taking the per-row maximum (a draft can make a row taller, never shorter).
 */
export function autoRowHeights(object, columnWidthForIndex, liveDrafts = null, onlyDrafts = false) {
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
  if (!onlyDrafts) {
    Object.entries(object.cells || {}).forEach(([id, cell]) => {
      consider(id, cell?.value, cell?.style?.wrap);
    });
  }
  if (liveDrafts) {
    liveDrafts.forEach((draft, id) => {
      const value = draft?.formula ? draft.displayValue || draft.formula : draft?.value;
      consider(id, value, true);
    });
  }
  return heights;
}

/**
 * Merge draft auto-heights over the base map taking the tallest per row.
 * Auto height can only grow a row while editing, never shrink it.
 */
export function mergeAutoRowHeights(base, drafts) {
  if (!drafts) return base;
  const merged = { ...base };
  for (const [row, height] of Object.entries(drafts)) {
    if (height > (merged[row] || 0)) merged[row] = height;
  }
  return merged;
}

/**
 * Journal-incremental auto-height base map. The grid's sheet `object` identity
 * changes on every commit, but its `cells` map is mutated in place, so keying
 * the memo on `object.cells` keeps the full O(stored cells) scan off the
 * per-edit render path. The cell-change journal tells us which ids actually
 * changed; only when a wrap-relevant cell (or a deleted/unknown cell) is among
 * them do we re-run the scan. Knowing which ids were wrap-relevant on the last
 * full scan lets wrap-toggles in both directions invalidate correctly.
 */
const AUTO_HEIGHT_CACHE = new WeakMap();

/**
 * One pass over the stored cells producing both the auto-height map and the
 * set of wrap-relevant ids. These were two separate O(stored cells) scans, and
 * every sheet open pays them on a fresh cells map.
 */
function scanAutoRowHeights(object, columnWidthForIndex) {
  const heights = {};
  const wrapIds = new Set();
  Object.entries(object?.cells || {}).forEach(([id, cell]) => {
    if (!cell) return;
    const value = cell.value;
    const wrap = Boolean(cell.style?.wrap);
    const text = String(value ?? "");
    if (!wrap && !text.includes("\n")) return;
    wrapIds.add(id);
    const coordinates = coordinatesFromCellId(id);
    if (!coordinates) return;
    const fontSize = Number(cell.style?.fontSize) || DEFAULT_CELL_FONT;
    const columnWidth = columnWidthForIndex?.(coordinates.column) || 0;
    const lines = wrappedLineCount(text, columnWidth, fontSize, Boolean(cell.style?.bold));
    if (lines <= 1) return;
    const height = Math.ceil(lines * fontSize * CELL_LINE_HEIGHT + CELL_V_PADDING);
    if (height > (heights[coordinates.row] || 0)) heights[coordinates.row] = height;
  });
  return { heights, wrapIds };
}

export function autoRowHeightsIncremental(object, columnWidthForIndex) {
  const cells = object?.cells || {};
  const version = cellChangeVersion(cells);
  const cached = AUTO_HEIGHT_CACHE.get(cells);
  if (cached && cached.widthsFor === columnWidthForIndex && cached.version === version) {
    return cached.heights;
  }
  if (cached && cached.widthsFor === columnWidthForIndex) {
    const journal = cellChangesSince(cells, cached.version);
    if (journal) {
      const touchesWrap = journal.ids.some((id) => {
        const cell = cells?.[id];
        return cached.wrap.has(id)
          || Boolean(cell && (cell?.style?.wrap || String(cell?.value ?? "").includes("\n")));
      });
      if (!touchesWrap) {
        cached.version = version;
        AUTO_HEIGHT_CACHE.set(cells, cached);
        return cached.heights;
      }
    }
  }
  const { heights, wrapIds } = scanAutoRowHeights(object, columnWidthForIndex);
  AUTO_HEIGHT_CACHE.set(cells, {
    version,
    widthsFor: columnWidthForIndex,
    heights,
    wrap: wrapIds,
  });
  return heights;
}
