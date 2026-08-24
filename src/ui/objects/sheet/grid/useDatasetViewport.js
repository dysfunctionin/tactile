import { useEffect, useMemo, useState } from "react";

import {
  createStorageModePolicy,
  createVirtualSheetDatasetStore,
  seedChunks,
  sheetColumnName,
} from "../../../../core/dataset/index.ts";
import { cellId } from "../../../../core/sheet/coordinates.js";
import { activeChunkStore } from "../../../../platform/chunkStore.js";
import { cellChangeVersion } from "./cellChangeJournal.js";

// One policy for the session, so a sheet keeps the mode it was opened with even
// as the user moves between it and another.
const policy = createStorageModePolicy();

const sourceIds = new WeakMap();
let sourceSequence = 0;

function sourceRevision(cells) {
  if (!sourceIds.has(cells)) sourceIds.set(cells, ++sourceSequence);
  return `${sourceIds.get(cells)}:${cellChangeVersion(cells)}`;
}

function bounds(entries, key) {
  let low = Infinity;
  let high = -Infinity;
  for (const entry of entries) {
    if (entry[key] < low) low = entry[key];
    if (entry[key] > high) high = entry[key];
  }
  return high < low ? null : { low, high };
}

/**
 * The cells the grid should paint for the current viewport.
 *
 * Returns `null` for an eager sheet, which is every sheet under the residency
 * threshold. That is deliberate: the caller then reads `object.cells` exactly
 * as it always has, so the common path gains no async hop and no second copy of
 * the viewport.
 *
 * For a virtual sheet it returns a map of cell id to `{ record, state }`, where
 * state is the residency of the block the cell came from.
 */
export function useDatasetViewport(object, visibleRows, visibleColumns) {
  // Keyed on the cells reference rather than the change journal: an edit
  // mutates that map in place, and counting its keys on every keystroke would
  // cost more than the mode decision saves.
  const mode = useMemo(
    () => (policy.isVirtual(object.id) ? "virtual" : policy.modeForSheet(object)),
    [object.id, object.cells],
  );

  const runtime = useMemo(() => {
    if (mode !== "virtual") return null;
    const store = activeChunkStore();
    if (!store) return null;
    return {
      dataset: createVirtualSheetDatasetStore({
        store,
        object,
        revision: sourceRevision(object.cells),
      }),
      // A sheet cannot read blocks it never wrote. Seeding once from the cells
      // already in memory is what lets an existing workspace turn virtual.
      seeded: seedChunks(store, object.id, object.cells),
    };
  }, [mode, object.id]);

  const revision = sourceRevision(object.cells);
  runtime?.dataset.update(object, revision);

  const rowBounds = bounds(visibleRows, "row");
  const columnBounds = bounds(visibleColumns, "column");
  const viewportKey = rowBounds && columnBounds
    ? `${rowBounds.low}-${rowBounds.high}:${columnBounds.low}-${columnBounds.high}`
    : "";
  const [settled, setSettled] = useState(null);

  useEffect(() => () => {
    runtime?.dataset.close();
  }, [runtime]);

  useEffect(() => {
    if (!runtime || !viewportKey) return undefined;
    const controller = new AbortController();
    const firstColumn = columnBounds.low;
    const columnIds = [];
    for (let column = firstColumn; column <= columnBounds.high; column += 1) {
      columnIds.push(sheetColumnName(column));
    }

    runtime.seeded
      .then(() => runtime.dataset.readWindow({
        datasetId: object.id,
        rowStart: rowBounds.low,
        rowEnd: rowBounds.high,
        columnIds,
        signal: controller.signal,
      }))
      .then((result) => {
        if (controller.signal.aborted) return;
        const cells = new Map();
        for (const row of result.rows) {
          row.cells.forEach((entry, projectionIndex) => {
            if (!entry.record && entry.state === "ready") return;
            cells.set(cellId(row.logicalIndex, firstColumn + projectionIndex), {
              record: entry.record || null,
              state: entry.state,
            });
          });
        }
        setSettled({ viewportKey, cells });
      })
      .catch((error) => {
        if (error?.name !== "AbortError") console.error("Unable to read the sheet viewport", error);
      });

    return () => controller.abort();
  }, [object.id, revision, runtime, viewportKey]);

  return useMemo(() => {
    if (!runtime) return null;
    // Until the first window settles nothing is resident, so an empty map
    // reports every cell as pending rather than as blank.
    if (!settled || settled.viewportKey !== viewportKey) return new Map();
    return settled.cells;
  }, [runtime, settled, viewportKey]);
}
