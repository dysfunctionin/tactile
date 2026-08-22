import { coordinatesFromCellId } from "../../../sheet/coordinates.js";
import {
  CELL_LINE_HEIGHT,
  CELL_V_PADDING,
  DEFAULT_CELL_FONT,
  wrappedLineCount,
} from "../../../sheet/textMeasure.js";
import { cellChangesSince, cellChangeVersion } from "./cellChangeJournal.js";

function contributionFor(id, cell, columnWidthForIndex, valueOverride, forceWrap = false) {
  const value = valueOverride === undefined ? cell?.value : valueOverride;
  if (!forceWrap && !cell?.style?.wrap && !String(value ?? "").includes("\n")) return null;
  const coordinates = coordinatesFromCellId(id);
  if (!coordinates) return null;
  const fontSize = Number(cell?.style?.fontSize) || DEFAULT_CELL_FONT;
  const columnWidth = columnWidthForIndex?.(coordinates.column) || 0;
  const lines = wrappedLineCount(value, columnWidth, fontSize, Boolean(cell?.style?.bold));
  if (lines <= 1) return null;
  return {
    row: coordinates.row,
    height: Math.ceil(lines * fontSize * CELL_LINE_HEIGHT + CELL_V_PADDING),
  };
}

function setContribution(state, id, contribution) {
  const previous = state.cells.get(id);
  if (previous) {
    const row = state.rows.get(previous.row);
    row?.delete(id);
    if (!row?.size) state.rows.delete(previous.row);
  }
  if (!contribution) {
    state.cells.delete(id);
    return;
  }
  state.cells.set(id, contribution);
  let row = state.rows.get(contribution.row);
  if (!row) {
    row = new Map();
    state.rows.set(contribution.row, row);
  }
  row.set(id, contribution.height);
}

function createState(object, columnWidthForIndex) {
  const state = {
    objectId: object.id,
    sourceCells: object.cells || {},
    columnWidthForIndex,
    journalVersion: cellChangeVersion(object.cells),
    cells: new Map(),
    rows: new Map(),
  };
  Object.entries(object.cells || {}).forEach(([id, cell]) => {
    setContribution(state, id, contributionFor(id, cell, columnWidthForIndex));
  });
  return state;
}

function materialize(state) {
  const heights = {};
  state.rows.forEach((cells, row) => {
    heights[row] = Math.max(...cells.values());
  });
  return heights;
}

export function projectAutoRowHeights(previousState, object, columnWidthForIndex, liveDrafts = null) {
  let state = previousState;
  const sourceCells = object.cells || {};
  const journal = state?.sourceCells === sourceCells
    ? cellChangesSince(sourceCells, state.journalVersion)
    : null;
  if (
    !state
    || state.objectId !== object.id
    || state.columnWidthForIndex !== columnWidthForIndex
    || !journal
  ) {
    state = createState(object, columnWidthForIndex);
  } else {
    state.journalVersion = journal.version;
    journal.ids.forEach((id) => {
      setContribution(state, id, contributionFor(id, sourceCells[id], columnWidthForIndex));
    });
  }

  if (!liveDrafts?.size) return { state, heights: materialize(state) };
  const draftState = {
    ...state,
    cells: new Map(state.cells),
    rows: new Map([...state.rows].map(([row, cells]) => [row, new Map(cells)])),
  };
  liveDrafts.forEach((draft, id) => {
    const value = draft?.formula ? draft.displayValue || draft.formula : draft?.value;
    setContribution(
      draftState,
      id,
      contributionFor(id, sourceCells[id] || {}, columnWidthForIndex, value, true),
    );
  });
  return { state, heights: materialize(draftState) };
}