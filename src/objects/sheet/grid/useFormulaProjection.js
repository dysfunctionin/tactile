import { useCallback, useEffect, useRef, useState } from "react";
import { createFormulaEngine } from "../../../sheet/formulas.js";
import { cellAddress, coordinatesFromCellId } from "../../../sheet/coordinates.js";
import { cellChangeVersion, cellChangesSince } from "./cellChangeJournal.js";
import { clearCalculationStatus, reportCalculationStatus } from "./calculationStatus.js";

function formulaRelevant(cell) {
  return Boolean(cell?.formula || cell?.value);
}

function formulaInputChanged(previous, cell) {
  return previous?.formula !== cell?.formula || previous?.value !== cell?.value;
}

function addressForCell(id, cell) {
  if (cell?.address) return cell.address;
  const coordinates = coordinatesFromCellId(id);
  return coordinates ? cellAddress(coordinates.row, coordinates.column) : "";
}

function engineSheet(object) {
  return {
    ...object,
    // FormulaEngine.applyChanges mutates its sheet. Keep that private from
    // the render workspace, whose sparse cells map is shared by the editor.
    cells: { ...(object.cells || {}) },
  };
}

function createProjectionState(object, priorityAddresses) {
  const engine = createFormulaEngine(engineSheet(object), { autoRecalculate: false });
  engine.setPriorityAddresses(priorityAddresses);
  engine.recalculateAll();
  const cells = object.cells || {};
  return {
    objectId: object.id,
    ready: true,
    cells,
    cellRefs: new Map(Object.entries(cells)),
    journalVersion: cellChangeVersion(cells),
    engine,
    values: engine.getFormulaValues(),
  };
}

function changeForCell(state, cells, id) {
  const previous = state.cellRefs.get(id);
  const cell = cells[id];
  if (previous === cell) return null;
  if (cell) state.cellRefs.set(id, cell);
  else state.cellRefs.delete(id);
  if (!formulaRelevant(previous) && !formulaRelevant(cell)) return null;
  if (!formulaInputChanged(previous, cell)) return null;
  const address = addressForCell(id, cell || previous);
  if (!address) return null;
  return cell ? { address, cell } : { address, delete: true };
}

function changesForCellIds(state, cells, ids) {
  return ids.map((id) => changeForCell(state, cells, id)).filter(Boolean);
}

function fullChangesSinceLastProjection(state, object) {
  const cells = object.cells || {};
  const changes = [];

  for (const [id, cell] of Object.entries(cells)) {
    const previous = state.cellRefs.get(id);
    if (previous === cell) continue;
    state.cellRefs.set(id, cell);
    if (!formulaRelevant(previous) && !formulaRelevant(cell)) continue;
    if (!formulaInputChanged(previous, cell)) continue;
    const address = addressForCell(id, cell || previous);
    if (address) changes.push({ address, cell: cell || null });
  }

  for (const [id, previous] of state.cellRefs) {
    if (Object.prototype.hasOwnProperty.call(cells, id)) continue;
    state.cellRefs.delete(id);
    if (!formulaRelevant(previous)) continue;
    const address = addressForCell(id, previous);
    if (address) changes.push({ address, delete: true });
  }

  return changes;
}

function changesSinceLastProjection(state, object) {
  const cells = object.cells || {};
  if (state.cells === cells) {
    const journal = cellChangesSince(cells, state.journalVersion);
    if (journal) {
      state.journalVersion = journal.version;
      return changesForCellIds(state, cells, journal.ids);
    }
  }

  state.cells = cells;
  state.journalVersion = cellChangeVersion(cells);
  return fullChangesSinceLastProjection(state, object);
}

function updateProjectionState(state, object, changes) {
  if (!changes.length) return;
  state.engine.sheet.rows = object.rows;
  state.engine.sheet.columns = object.columns;
  const calculation = state.engine.applyChanges(changes);
  for (const address of calculation.evaluatedAddresses || []) {
    if (calculation.values.has(address)) state.values.set(address, calculation.values.get(address));
  }
  for (const change of changes) {
    const cell = state.engine.getCell(change.address);
    if (!cell?.formula) state.values.delete(change.address);
  }
}

const DRAIN_SLICE_MS = 6;
const BAND_SLICE_MS = 8;
const EMPTY_VALUES = new Map();

function scheduleIdle(callback) {
  if (typeof window === "undefined") return null;
  if (typeof window.requestIdleCallback === "function") {
    return { kind: "idle", id: window.requestIdleCallback(callback, { timeout: 250 }) };
  }
  return { kind: "timeout", id: window.setTimeout(callback, 0) };
}

function cancelIdle(handle) {
  if (!handle || typeof window === "undefined") return;
  if (handle.kind === "idle") window.cancelIdleCallback?.(handle.id);
  else window.clearTimeout(handle.id);
}

function drainInto(state, budgetMs) {
  const slice = state.engine.drainInvalidated({ budgetMs });
  if (!slice.evaluatedAddresses.length) return false;
  // Values map is mutated in place; the ready tick is what re-renders the grid.
  for (const [address, value] of slice.values) state.values.set(address, value);
  return true;
}

export function useFormulaProjection(object) {
  const stateRef = useRef(null);
  const objectRef = useRef(object);
  objectRef.current = object;
  const bandRef = useRef(null);
  const buildScheduledRef = useRef(false);
  const [, setReadyTick] = useState(0);

  // Imperative rather than a prop: the mounted band is derived from the virtual
  // window, which itself depends on formula values through column filters.
  const setPriorityBand = useCallback((band) => {
    bandRef.current = band;
    const state = stateRef.current;
    if (!state?.ready) return;
    state.engine.setPriorityAddresses(band);
    if (!state.engine.invalidated.size) return;
    if (drainInto(state, BAND_SLICE_MS)) setReadyTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    const ensureBuild = (target) => {
      if (buildScheduledRef.current) return;
      stateRef.current = { objectId: target.id, ready: false, values: new Map() };
      buildScheduledRef.current = true;
      const schedule = () => {
        if (objectRef.current?.id !== target.id) return; // stale: cross-sheet effect already rebuilt
        buildScheduledRef.current = false;
        stateRef.current = createProjectionState(objectRef.current, bandRef.current);
        setReadyTick((tick) => tick + 1);
      };
      // Build after first paint (idle priority) so a large sheet's first render
      // is not blocked by graph construction + full recalculation. Formula cells
      // render blank until the engine catches up; `setReadyTick` swaps in values.
      if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(schedule, { timeout: 4000 });
      } else if (typeof window !== "undefined") {
        window.setTimeout(schedule, 0);
      } else {
        buildScheduledRef.current = false;
      }
    };
    const current = stateRef.current;
    if (current?.ready && current.objectId === object.id) return undefined;
    if (current?.objectId !== object.id) {
      stateRef.current = null;
      buildScheduledRef.current = false;
    }
    ensureBuild(object);
    return undefined;
  }, [object]);

  // Off-band dependents settle over idle slices so a single edit never blocks
  // a frame on the full dependent set.
  useEffect(() => {
    const state = stateRef.current;
    if (!state?.ready || !state.engine.invalidated.size) return undefined;
    let cancelled = false;
    let handle = null;
    const step = () => {
      if (cancelled) return;
      const current = stateRef.current;
      if (!current?.ready) return;
      if (drainInto(current, DRAIN_SLICE_MS)) setReadyTick((tick) => tick + 1);
      else if (current.engine.invalidated.size) handle = scheduleIdle(step);
    };
    handle = scheduleIdle(step);
    return () => {
      cancelled = true;
      cancelIdle(handle);
    };
  });

  const state = stateRef.current;
  const pending = state?.ready && state.objectId === object.id ? state.engine.invalidated.size : 0;
  useEffect(() => {
    reportCalculationStatus(object.id, pending);
  }, [object.id, pending]);
  useEffect(() => () => clearCalculationStatus(object.id), [object.id]);

  if (state?.ready && state.objectId === object.id) {
    const changes = changesSinceLastProjection(state, object);
    updateProjectionState(state, object, changes);
    return { values: state.values, pending: state.engine.invalidated.size, setPriorityBand };
  }
  return {
    values: stateRef.current?.values || EMPTY_VALUES,
    pending: 0,
    setPriorityBand,
  };
}

