import { createPerformanceWorkspace } from "../generate-fixture.mjs";
import { normalizeWorkspace } from "../../src/model.js";
import { createFormulaEngine } from "../../src/sheet/formulas.js";
import { cellAddress } from "../../src/sheet/coordinates.js";
import {
  removeSheetAxisCells,
  reorderSheetAxis,
  shiftCells,
} from "../../src/sheet/axisCells.js";
import { autoRowHeightsIncremental } from "../../src/sheet/textMeasure.js";
import { cloneHistoryWorkspace } from "../../src/core/history/snapshot.js";
import { recordCellChanges } from "../../src/objects/sheet/grid/cellChangeJournal.js";
import { buildAxisGeometry, buildVirtualRange, rangeContains } from "../../src/objects/sheet/useVirtualSheet.js";

const ROOT_SHEET_ID = "perf-root-sheet";

// Fixture column map (see benchmarks/generate-fixture.mjs):
//   A..J  plain values, K..ET plain filler, EU..GR (150..199) formulas.
// K300 has no dependents; B300 feeds the row-local chain/fan-out/range bands;
// B5 additionally sits inside the absolute $B$1:$B$32 aggregate ranges.
const ISOLATED_ADDRESS = "K300";
const ROW_FANOUT_ADDRESS = "B300";
const WIDE_FANOUT_ADDRESS = "B5";
const CHAIN_ADDRESS = "EU300";

export function createContext() {
  const workspace = normalizeWorkspace(createPerformanceWorkspace());
  return { workspace, rootSheet: workspace.objects[ROOT_SHEET_ID] };
}

function engineSheet(object) {
  return { ...object, cells: { ...(object.cells || {}) } };
}

function buildEngine(context) {
  return createFormulaEngine(engineSheet(context.rootSheet));
}

// A 1440x900 viewport mounts roughly 12 columns x 30 rows plus overscan.
function bandAddresses(rowStart, rowEnd, columnStart, columnEnd) {
  const addresses = new Set();
  for (let row = rowStart; row <= rowEnd; row += 1) {
    for (let column = columnStart; column <= columnEnd; column += 1) {
      addresses.add(cellAddress(row, column));
    }
  }
  return addresses;
}

function editCase({ name, address, budgetMs, phase, note, warmup = 3, iterations = 12 }) {
  return {
    name,
    budgetMs,
    phase,
    note,
    warmup,
    iterations,
    setup: (context) => buildEngine(context),
    run: (engine, _context, index) => {
      engine.applyChanges([{ address, patch: { value: String(1000 + index) } }]);
    },
  };
}

function bandedEditCase({ name, address, budgetMs, phase, note }) {
  return {
    name,
    budgetMs,
    phase,
    note,
    warmup: 3,
    iterations: 12,
    setup: (context) => {
      const engine = buildEngine(context);
      engine.setPriorityAddresses(bandAddresses(0, 34, 0, 15));
      return engine;
    },
    run: (engine, _context, index) => {
      engine.applyChanges([{ address, patch: { value: String(1000 + index) } }]);
    },
  };
}

export const CASES = [
  {
    name: "normalize-workspace",
    budgetMs: 50,
    phase: "P5",
    note: "Import/replace path only; commitCellChanges does not normalize.",
    warmup: 1,
    iterations: 3,
    setup: () => createPerformanceWorkspace(),
    run: (raw) => {
      normalizeWorkspace(raw);
    },
  },
  {
    name: "engine-build-root",
    budgetMs: Infinity,
    phase: "reference",
    note: "Unbanded reference: full graph build plus full recalc over 25k formulas.",
    warmup: 1,
    iterations: 2,
    run: (_state, context) => {
      buildEngine(context);
    },
  },
  editCase({
    name: "edit-isolated-cell",
    address: ISOLATED_ADDRESS,
    budgetMs: 1,
    phase: "done",
    note: "Plain cell with no dependents.",
  }),
  editCase({
    name: "edit-row-fanout-cell",
    address: ROW_FANOUT_ADDRESS,
    budgetMs: Infinity,
    phase: "reference",
    warmup: 1,
    iterations: 4,
    note: "Unbanded reference: every dependent evaluated synchronously.",
  }),
  editCase({
    name: "edit-wide-fanout-cell",
    address: WIDE_FANOUT_ADDRESS,
    budgetMs: Infinity,
    phase: "reference",
    warmup: 1,
    iterations: 3,
    note: "Unbanded reference: ~5k SUMIF/COUNTIF dependents evaluated synchronously.",
  }),
  editCase({
    name: "edit-chain-formula-cell",
    address: CHAIN_ADDRESS,
    budgetMs: 16,
    phase: "P2",
    note: "Overwrites a chain formula cell with a literal.",
  }),
  {
    name: "edit-wide-fanout-banded",
    budgetMs: 16,
    phase: "P5",
    note: "Same B5 edit with the mounted band as the priority set; off-screen dependents defer.",
    warmup: 3,
    iterations: 12,
    setup: (context) => {
      const engine = buildEngine(context);
      engine.setPriorityAddresses(bandAddresses(0, 34, 0, 15));
      return engine;
    },
    run: (engine, _context, index) => {
      engine.applyChanges([{ address: WIDE_FANOUT_ADDRESS, patch: { value: String(1000 + index) } }]);
    },
  },
  bandedEditCase({
    name: "edit-row-fanout-banded",
    address: ROW_FANOUT_ADDRESS,
    budgetMs: 16,
    phase: "P5",
    note: "Row-local chain cascade with only the mounted band evaluated synchronously.",
  }),
  {
    name: "drain-deferred-8ms",
    budgetMs: 16,
    phase: "P5",
    note: "One progressive drain slice after a wide fan-out edit.",
    warmup: 3,
    iterations: 12,
    setup: (context) => {
      const engine = buildEngine(context);
      engine.setPriorityAddresses(bandAddresses(0, 34, 0, 15));
      return engine;
    },
    prepare: (engine, _context, index) => {
      engine.applyChanges([{ address: WIDE_FANOUT_ADDRESS, patch: { value: String(2000 + index) } }]);
      return engine;
    },
    run: (engine) => {
      engine.drainInvalidated({ budgetMs: 8 });
    },
  },
  {
    name: "engine-build-root-banded",
    budgetMs: Infinity,
    phase: "reference",
    note: "Reference: full graph registration with band-only first evaluation.",
    warmup: 1,
    iterations: 2,
    run: (_state, context) => {
      const engine = createFormulaEngine(engineSheet(context.rootSheet), { autoRecalculate: false });
      engine.setPriorityAddresses(bandAddresses(0, 34, 0, 15));
      engine.recalculateAll();
    },
  },
  {
    name: "engine-build-band-scoped",
    budgetMs: 16,
    phase: "P5",
    note: "Graph registration limited to the mounted band; the worker owns the full graph.",
    warmup: 3,
    iterations: 10,
    setup: () => bandAddresses(0, 34, 0, 15),
    run: (band, context) => {
      const sheet = { ...context.rootSheet, cells: context.rootSheet.cells };
      createFormulaEngine(sheet, { registerOnly: band, readOnlyCells: true });
    },
  },
  {
    name: "scroll-into-formula-band",
    budgetMs: 16,
    phase: "P5",
    note: "Scrolling onto ~560 never-evaluated chain/fan-out formulas: register plus evaluate.",
    warmup: 3,
    iterations: 10,
    setup: (context) => ({
      sheet: { ...context.rootSheet, cells: context.rootSheet.cells },
      home: bandAddresses(0, 34, 0, 15),
      formulaBand: bandAddresses(0, 34, 150, 165),
    }),
    prepare: (state) => ({
      ...state,
      engine: createFormulaEngine(state.sheet, { registerOnly: state.home, readOnlyCells: true }),
    }),
    run: (state) => {
      state.engine.setPriorityAddresses(state.formulaBand);
      state.engine.registerFormulasIn(state.formulaBand);
      state.engine.drainInvalidated({ budgetMs: Infinity });
    },
  },
  {
    name: "formula-add",
    budgetMs: 10,
    phase: "done",
    note: "Author one =SUM(B..F) into a previously plain cell.",
    warmup: 3,
    iterations: 12,
    setup: (context) => buildEngine(context),
    run: (engine, _context, index) => {
      const row = 400 + index;
      engine.applyChanges([{ address: `K${row}`, patch: { formula: `=SUM(B${row}:F${row})`, value: "" } }]);
    },
  },
  {
    name: "graph-dependents-of",
    budgetMs: 1,
    phase: "done",
    warmup: 3,
    iterations: 50,
    setup: (context) => buildEngine(context),
    run: (engine) => {
      engine.getDependents(ROW_FANOUT_ADDRESS);
    },
  },
  {
    name: "history-snapshot",
    budgetMs: 16,
    phase: "P2",
    note: "Undo snapshot taken on every structural or object-level commit.",
    warmup: 3,
    iterations: 10,
    run: (_state, context) => {
      cloneHistoryWorkspace(context.workspace);
    },
  },
  {
    name: "history-snapshot-deep-clone",
    budgetMs: Infinity,
    phase: "reference",
    note: "Unbanded reference: the structuredClone the snapshot used to perform.",
    warmup: 1,
    iterations: 2,
    run: (_state, context) => {
      structuredClone(context.workspace);
    },
  },
  {
    name: "insert-row-cells",
    budgetMs: 25,
    phase: "P4",
    note: "shiftCells re-keys every cell at or below the insert index.",
    warmup: 1,
    iterations: 5,
    run: (_state, context) => {
      shiftCells(context.rootSheet, "row", 12);
    },
  },
  {
    name: "insert-column-cells",
    budgetMs: 25,
    phase: "P4",
    note: "shiftCells re-keys every cell right of the insert index and rewrites formulas.",
    warmup: 1,
    iterations: 5,
    run: (_state, context) => {
      shiftCells(context.rootSheet, "column", 12);
    },
  },
  {
    name: "delete-row-cells",
    budgetMs: 25,
    phase: "P4",
    warmup: 1,
    iterations: 5,
    run: (_state, context) => {
      removeSheetAxisCells(context.rootSheet, "row", 12);
    },
  },
  {
    name: "reorder-column",
    budgetMs: 25,
    phase: "P4",
    warmup: 1,
    iterations: 5,
    run: (_state, context) => {
      reorderSheetAxis(context.rootSheet, "column", 3, 40);
    },
  },
  {
    name: "auto-row-heights-incremental",
    budgetMs: 1,
    phase: "done",
    note: "Per-keystroke journal-incremental path over a mutated cells map.",
    warmup: 3,
    iterations: 20,
    setup: (context) => {
      const cells = { ...context.rootSheet.cells };
      const object = { ...context.rootSheet, cells };
      const columnWidthForIndex = () => 126;
      autoRowHeightsIncremental(object, columnWidthForIndex);
      return { object, cells, columnWidthForIndex };
    },
    prepare: (state, _context, index) => {
      const id = "r300c11";
      state.cells[id] = { ...state.cells[id], value: `edit-${index}` };
      recordCellChanges(state.cells, [id]);
      return state;
    },
    run: (state) => {
      autoRowHeightsIncremental(state.object, state.columnWidthForIndex);
    },
  },
  {
    name: "virtual-scroll-72-frames",
    budgetMs: 5,
    phase: "done",
    note: "Window recompute for a 72-frame diagonal scroll over the root sheet.",
    warmup: 3,
    iterations: 20,
    setup: (context) => {
      const { rows, columns } = context.rootSheet;
      const rowIndexes = Array.from({ length: rows }, (_, index) => index);
      const columnIndexes = Array.from({ length: columns }, (_, index) => index);
      return {
        rowGeometry: buildAxisGeometry(rowIndexes, context.rootSheet.rowHeights, 31, 24, 96),
        columnGeometry: buildAxisGeometry(columnIndexes, context.rootSheet.columnWidths, 126, 56, 420),
        rows,
        columns,
      };
    },
    run: (state) => {
      const metrics = { rowHeaderWidth: 34, columnHeaderHeight: 25 };
      const base = { width: 1440, height: 900, scrollLeft: 0, scrollTop: 0 };
      let renderRange = buildVirtualRange(
        state.rowGeometry,
        state.columnGeometry,
        state.rows,
        state.columns,
        metrics,
        base,
        5,
      );
      for (let frame = 1; frame <= 72; frame += 1) {
        const viewport = { ...base, scrollTop: frame * 40, scrollLeft: frame * 30 };
        const visible = buildVirtualRange(
          state.rowGeometry,
          state.columnGeometry,
          state.rows,
          state.columns,
          metrics,
          viewport,
          0,
        );
        if (!rangeContains(renderRange, visible)) {
          renderRange = buildVirtualRange(
            state.rowGeometry,
            state.columnGeometry,
            state.rows,
            state.columns,
            metrics,
            viewport,
            5,
          );
        }
      }
    },
  },
];
