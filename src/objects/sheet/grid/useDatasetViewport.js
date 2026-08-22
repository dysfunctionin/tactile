import { useEffect, useMemo, useState } from "react";
import {
  FixedDatasetChunkReader,
  SheetSnapshotDatasetStore,
} from "../../../core/dataset/index.ts";
import { cellId, coordinatesFromCellId } from "../../../sheet/coordinates.js";
import { cellChangesSince, cellChangeVersion } from "./cellChangeJournal.js";

const EMPTY_CELLS = new Map();
const sourceIds = new WeakMap();
let sourceSequence = 0;

function sourceRevision(cells) {
  if (!sourceIds.has(cells)) sourceIds.set(cells, ++sourceSequence);
  return `${sourceIds.get(cells)}:${cellChangeVersion(cells)}`;
}

function axisRanges(entries, key) {
  const values = [...new Set(entries.map((entry) => entry[key]))].sort((left, right) => left - right);
  return values.reduce((ranges, value) => {
    const current = ranges.at(-1);
    if (current && value === current[1] + 1) current[1] = value;
    else ranges.push([value, value]);
    return ranges;
  }, []);
}

export function useDatasetViewport(object, visibleRows, visibleColumns) {
  const runtime = useMemo(() => {
    const revision = sourceRevision(object.cells);
    const store = new SheetSnapshotDatasetStore(object, revision);
    return {
      store,
      reader: new FixedDatasetChunkReader(store, { maxCacheBytes: 32 * 1024 * 1024 }),
    };
  }, [object.id]);
  const revision = sourceRevision(object.cells);
  runtime.store.update(object, revision);
  const descriptor = runtime.store.descriptor();
  const rowRanges = axisRanges(visibleRows, "row");
  const columnRanges = axisRanges(visibleColumns, "column");
  const viewportKey = `${rowRanges.map((range) => range.join("-")).join(",")}:${columnRanges.map((range) => range.join("-")).join(",")}`;
  const [windowState, setWindowState] = useState(null);

  useEffect(() => () => {
    runtime.reader.close();
  }, [runtime]);

  useEffect(() => {
    if (!rowRanges.length || !columnRanges.length) return undefined;
    const controller = new AbortController();
    const requests = rowRanges.flatMap(([rowStart, rowEnd]) => (
      columnRanges.map(([columnStart, columnEnd]) => ({ rowStart, rowEnd, columnStart, columnEnd }))
    ));
    Promise.all(requests.map((request) => runtime.reader.read(descriptor, {
      datasetId: descriptor.id,
      ...request,
      revision: descriptor.revision,
      signal: controller.signal,
    }).then((window) => ({ window, columnStart: request.columnStart })))).then((windows) => {
      const cells = new Map();
      windows.forEach(({ window, columnStart }) => {
        window.rows.forEach((row) => {
          row.cells.forEach((entry, projectionIndex) => {
            if (entry.record) cells.set(cellId(Number(row.logicalIndex), columnStart + projectionIndex), entry.record);
          });
        });
      });
      setWindowState({
        revision: descriptor.revision,
        viewportKey,
        source: object.cells,
        journalVersion: cellChangeVersion(object.cells),
        cells,
      });
    }).catch((error) => {
      if (error?.name !== "AbortError") console.error("Unable to read dataset viewport", error);
    });
    return () => controller.abort();
  }, [descriptor.revision, object.cells, runtime, viewportKey]);

  return useMemo(() => {
    if (!windowState || windowState.viewportKey !== viewportKey) return EMPTY_CELLS;
    if (windowState.revision === descriptor.revision) return windowState.cells;
    if (windowState.source !== object.cells) return EMPTY_CELLS;
    const journal = cellChangesSince(object.cells, windowState.journalVersion);
    if (!journal) return EMPTY_CELLS;
    const visibleRowSet = new Set(visibleRows.map((entry) => entry.row));
    const visibleColumnSet = new Set(visibleColumns.map((entry) => entry.column));
    const cells = new Map(windowState.cells);
    journal.ids.forEach((id) => {
      const coordinates = coordinatesFromCellId(id);
      if (!coordinates
        || !visibleRowSet.has(coordinates.row)
        || !visibleColumnSet.has(coordinates.column)) return;
      const record = object.cells?.[id];
      if (record) cells.set(id, record);
      else cells.delete(id);
    });
    return cells;
  }, [descriptor.revision, object, viewportKey, visibleColumns, visibleRows, windowState]);
}