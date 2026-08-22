import type { TransactionEngine } from "../engine/transactionEngine.ts";
import {
  asColumnId,
  asColumnIndex,
  asDatasetId,
  asObjectId,
  asRowId,
  asRowIndex,
  type ColumnId,
  type DatasetId,
  type RevisionId,
} from "../ids.ts";
import type { DatasetStore, DatasetWindowRequest, DatasetWindowResult, WorkspaceCatalog } from "./contracts.ts";

const EAGER_COLUMN_PREFIX = "eager-column:";

export function eagerColumnId(index: number): ColumnId {
  return asColumnId(`${EAGER_COLUMN_PREFIX}${asColumnIndex(index)}`);
}

export function eagerColumnIndex(columnId: ColumnId): number | null {
  const value = String(columnId);
  if (!value.startsWith(EAGER_COLUMN_PREFIX)) return null;
  const index = Number(value.slice(EAGER_COLUMN_PREFIX.length));
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

/**
 * Incremental migration bridge. This adapter provides the dataset API while
 * intentionally retaining the current engine's fully materialized storage.
 */
export class EagerDatasetStore implements DatasetStore {
  private readonly engine: TransactionEngine;

  constructor(engine: TransactionEngine) {
    this.engine = engine;
  }

  async openCatalog(signal?: AbortSignal): Promise<WorkspaceCatalog> {
    signal?.throwIfAborted();
    const snapshot = this.engine.getSnapshot();
    const revision = this.engine.getRevision();
    const datasets = Object.values(snapshot.objects)
      .filter((object) => object.type === "sheet")
      .map((object) => ({
        id: asDatasetId(String(object.id)),
        objectId: object.id,
        title: object.title,
        storageMode: "eager" as const,
        rowCount: object.rows,
        columns: Array.from({ length: object.columns }, (_, logicalIndex) => ({
          id: eagerColumnId(logicalIndex),
          name: String(logicalIndex + 1),
          logicalIndex,
        })),
        revision,
      }));
    signal?.throwIfAborted();
    return { datasets, revision };
  }

  async readWindow(request: DatasetWindowRequest): Promise<DatasetWindowResult> {
    request.signal?.throwIfAborted();
    const objectId = asObjectId(String(request.datasetId));
    const object = this.engine.getObject(objectId);
    if (object?.type !== "sheet") throw new Error(`Dataset ${String(request.datasetId)} is unavailable.`);

    const columnIndexes = request.columnIds.map(eagerColumnIndex);
    if (columnIndexes.some((index) => index === null || index >= object.columns)) {
      throw new RangeError(`Dataset ${String(request.datasetId)} received an invalid column projection.`);
    }
    const projectedIndexes = columnIndexes as number[];
    const requestedRows = {
      start: Math.max(0, Number(request.rowStart)),
      end: Math.min(object.rows - 1, Number(request.rowEnd)),
    };
    const minimumColumn = projectedIndexes.length ? Math.min(...projectedIndexes) : 0;
    const maximumColumn = projectedIndexes.length ? Math.max(...projectedIndexes) : -1;
    const cells =
      requestedRows.end < requestedRows.start || maximumColumn < minimumColumn
        ? []
        : this.engine.getSheetWindow(objectId, {
            rowStart: asRowIndex(requestedRows.start),
            rowEnd: asRowIndex(requestedRows.end),
            columnStart: asColumnIndex(minimumColumn),
            columnEnd: asColumnIndex(maximumColumn),
          });
    const selectedColumns = new Set(projectedIndexes);
    const cellsByRow = new Map<number, Map<number, (typeof cells)[number]>>();
    for (const cell of cells) {
      const column = Number(cell.column);
      if (!selectedColumns.has(column)) continue;
      const rowIndex = Number(cell.row);
      let row = cellsByRow.get(rowIndex);
      if (!row) {
        row = new Map();
        cellsByRow.set(rowIndex, row);
      }
      row.set(column, cell);
    }

    const rows = [];
    for (let rowIndex = requestedRows.start; rowIndex <= requestedRows.end; rowIndex += 1) {
      const source = cellsByRow.get(rowIndex);
      rows.push({
        id: asRowId(`eager-row:${rowIndex}`),
        logicalIndex: asRowIndex(rowIndex),
        cells: projectedIndexes.map((columnIndex, projectionIndex) => {
          const cell = source?.get(columnIndex);
          return {
            columnId: request.columnIds[projectionIndex],
            value: cell?.value || "",
            ...(cell ? { record: cell } : {}),
            ...(cell?.calculatedValue === undefined ? {} : { calculatedValue: cell.calculatedValue }),
          };
        }),
      });
    }

    request.signal?.throwIfAborted();
    return {
      datasetId: request.datasetId,
      ...(request.viewId ? { viewId: request.viewId } : {}),
      rowStart: request.rowStart,
      rows,
      columnIds: request.columnIds,
      totalRowCount: object.rows,
      revision: this.engine.getRevision(),
    };
  }

  subscribe(datasetId: DatasetId, listener: (revision: RevisionId) => void): () => void {
    const objectId = asObjectId(String(datasetId));
    return this.engine.subscribe(
      (snapshot) => snapshot.objects[String(objectId)],
      () => listener(this.engine.getRevision()),
    );
  }

  async close(): Promise<void> {}
}
