import { asRowIndex, type ColumnIndex } from "../ids.ts";
import type {
  DatasetAggregateOperation,
  DatasetAggregateRequest,
  DatasetDescriptor,
  DatasetStore,
  DatasetStructureRequest,
  DatasetStructureResult,
  DatasetWindowCell,
  DatasetWindowRequest,
  DatasetWindowResult,
  OperationalDatasetStore,
} from "./contracts.ts";
import { DatasetWindowManager } from "./windowManager.ts";

export const FIXED_DATASET_CHUNK_ROWS = 64;
export const FIXED_DATASET_CHUNK_COLUMNS = 64;

export interface DatasetViewportRequest extends Omit<DatasetWindowRequest, "columnIds"> {
  columnStart: ColumnIndex;
  columnEnd: ColumnIndex;
}

export interface PlannedDatasetChunk {
  rowChunk: number;
  columnChunk: number;
  request: DatasetWindowRequest;
}

function boundedRange(start: number, end: number, count: number, name: string): [number, number] {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(`${name} must be a non-negative inclusive range.`);
  }
  if (count <= 0 || start >= count) return [0, -1];
  return [start, Math.min(end, count - 1)];
}

export function planFixedDatasetChunks(
  descriptor: DatasetDescriptor,
  viewport: DatasetViewportRequest,
): PlannedDatasetChunk[] {
  if (viewport.datasetId !== descriptor.id) {
    throw new Error(`Viewport requested ${String(viewport.datasetId)} using descriptor ${String(descriptor.id)}.`);
  }
  const [rowStart, rowEnd] = boundedRange(
    Number(viewport.rowStart),
    Number(viewport.rowEnd),
    descriptor.rowCount,
    "Rows",
  );
  const [columnStart, columnEnd] = boundedRange(
    Number(viewport.columnStart),
    Number(viewport.columnEnd),
    descriptor.columns.length,
    "Columns",
  );
  if (rowEnd < rowStart || columnEnd < columnStart) return [];

  const firstRowChunk = Math.floor(rowStart / FIXED_DATASET_CHUNK_ROWS);
  const lastRowChunk = Math.floor(rowEnd / FIXED_DATASET_CHUNK_ROWS);
  const firstColumnChunk = Math.floor(columnStart / FIXED_DATASET_CHUNK_COLUMNS);
  const lastColumnChunk = Math.floor(columnEnd / FIXED_DATASET_CHUNK_COLUMNS);
  const chunks: PlannedDatasetChunk[] = [];
  for (let rowChunk = firstRowChunk; rowChunk <= lastRowChunk; rowChunk += 1) {
    const chunkRowStart = rowChunk * FIXED_DATASET_CHUNK_ROWS;
    const chunkRowEnd = Math.min(descriptor.rowCount - 1, chunkRowStart + FIXED_DATASET_CHUNK_ROWS - 1);
    for (let columnChunk = firstColumnChunk; columnChunk <= lastColumnChunk; columnChunk += 1) {
      const chunkColumnStart = columnChunk * FIXED_DATASET_CHUNK_COLUMNS;
      const chunkColumnEnd = Math.min(
        descriptor.columns.length - 1,
        chunkColumnStart + FIXED_DATASET_CHUNK_COLUMNS - 1,
      );
      chunks.push({
        rowChunk,
        columnChunk,
        request: {
          datasetId: viewport.datasetId,
          ...(viewport.viewId ? { viewId: viewport.viewId } : {}),
          rowStart: asRowIndex(chunkRowStart),
          rowEnd: asRowIndex(chunkRowEnd),
          columnIds: descriptor.columns.slice(chunkColumnStart, chunkColumnEnd + 1).map((column) => column.id),
          revision: viewport.revision || descriptor.revision,
          priority: viewport.priority || "visible",
          ...(viewport.signal ? { signal: viewport.signal } : {}),
        },
      });
    }
  }
  return chunks;
}

function mergeChunks(
  descriptor: DatasetDescriptor,
  viewport: DatasetViewportRequest,
  chunks: readonly DatasetWindowResult[],
): DatasetWindowResult {
  const rowStart = Math.max(0, Number(viewport.rowStart));
  const rowEnd = Math.min(descriptor.rowCount - 1, Number(viewport.rowEnd));
  const columnIds = descriptor.columns
    .slice(Number(viewport.columnStart), Number(viewport.columnEnd) + 1)
    .map((column) => column.id);
  const rows = new Map<
    number,
    {
      id: DatasetWindowResult["rows"][number]["id"];
      cells: Map<string, DatasetWindowCell>;
    }
  >();
  for (const chunk of chunks) {
    for (const row of chunk.rows) {
      const logicalIndex = Number(row.logicalIndex);
      if (logicalIndex < rowStart || logicalIndex > rowEnd) continue;
      let merged = rows.get(logicalIndex);
      if (!merged) {
        merged = { id: row.id, cells: new Map() };
        rows.set(logicalIndex, merged);
      }
      row.cells.forEach((cell) => merged?.cells.set(String(cell.columnId), cell));
    }
  }
  const mergedRows = [];
  for (let logicalIndex = rowStart; logicalIndex <= rowEnd; logicalIndex += 1) {
    const row = rows.get(logicalIndex);
    if (!row) throw new Error(`Dataset ${String(descriptor.id)} omitted row ${logicalIndex} from a fixed chunk.`);
    mergedRows.push({
      id: row.id,
      logicalIndex: asRowIndex(logicalIndex),
      cells: columnIds.map((columnId) => row.cells.get(String(columnId)) || { columnId, value: "" }),
    });
  }
  const revision = chunks[0]?.revision || viewport.revision || descriptor.revision;
  if (chunks.some((chunk) => chunk.revision !== revision)) {
    throw new Error(`Dataset ${String(descriptor.id)} returned mixed revisions for one viewport.`);
  }
  return {
    datasetId: descriptor.id,
    ...(viewport.viewId ? { viewId: viewport.viewId } : {}),
    rowStart: asRowIndex(rowStart),
    rows: mergedRows,
    columnIds,
    totalRowCount: descriptor.rowCount,
    revision,
  };
}

export class FixedDatasetChunkReader {
  readonly windows: DatasetWindowManager;

  constructor(store: DatasetStore, options: { maxCacheBytes: number }) {
    this.windows = new DatasetWindowManager(store, options);
  }

  async read(descriptor: DatasetDescriptor, viewport: DatasetViewportRequest): Promise<DatasetWindowResult> {
    const plan = planFixedDatasetChunks(descriptor, viewport);
    const chunks = await Promise.all(plan.map(({ request }) => this.windows.read(request)));
    return mergeChunks(descriptor, viewport, chunks);
  }

  watch(descriptor: DatasetDescriptor): () => void {
    return this.windows.watch(descriptor.id);
  }

  close(): Promise<void> {
    return this.windows.close();
  }
}

export class FixedDatasetChunkManager extends FixedDatasetChunkReader {
  private readonly store: OperationalDatasetStore;

  constructor(store: OperationalDatasetStore, options: { maxCacheBytes: number }) {
    super(store, options);
    this.store = store;
  }

  aggregate(request: DatasetAggregateRequest): DatasetAggregateOperation {
    return this.store.aggregate(request);
  }

  async mutateStructure(request: DatasetStructureRequest): Promise<DatasetStructureResult> {
    const result = await this.store.mutateStructure(request);
    this.windows.cache.invalidate((window) => window.datasetId === request.datasetId);
    return result;
  }
}
