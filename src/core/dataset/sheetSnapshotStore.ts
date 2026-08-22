import type { SheetObject } from "../domain.ts";
import {
  asColumnId,
  asDatasetId,
  asObjectId,
  asRevisionId,
  asRowId,
  asRowIndex,
  type ColumnId,
  type RevisionId,
} from "../ids.ts";
import type {
  DatasetDescriptor,
  DatasetStore,
  DatasetWindowRequest,
  DatasetWindowResult,
  WorkspaceCatalog,
} from "./contracts.ts";

const COLUMN_PREFIX = "sheet-column:";

export function sheetSnapshotColumnId(index: number): ColumnId {
  return asColumnId(`${COLUMN_PREFIX}${index}`);
}

function columnIndex(columnId: ColumnId): number | null {
  const value = String(columnId);
  if (!value.startsWith(COLUMN_PREFIX)) return null;
  const index = Number(value.slice(COLUMN_PREFIX.length));
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

export class SheetSnapshotDatasetStore implements DatasetStore {
  private object: SheetObject;

  private revision: RevisionId;

  private readonly listeners = new Set<(revision: RevisionId) => void>();

  constructor(object: SheetObject, revision: string) {
    this.object = object;
    this.revision = asRevisionId(revision);
  }

  update(object: SheetObject, revision: string): void {
    const nextRevision = asRevisionId(revision);
    this.object = object;
    if (nextRevision === this.revision) return;
    this.revision = nextRevision;
    this.listeners.forEach((listener) => listener(nextRevision));
  }

  descriptor(): DatasetDescriptor {
    return {
      id: asDatasetId(String(this.object.id)),
      objectId: asObjectId(String(this.object.id)),
      title: this.object.title,
      storageMode: "eager",
      rowCount: this.object.rows,
      columns: Array.from({ length: this.object.columns }, (_, logicalIndex) => ({
        id: sheetSnapshotColumnId(logicalIndex),
        name: String(logicalIndex + 1),
        logicalIndex,
      })),
      revision: this.revision,
    };
  }

  async openCatalog(signal?: AbortSignal): Promise<WorkspaceCatalog> {
    signal?.throwIfAborted();
    return { datasets: [this.descriptor()], revision: this.revision };
  }

  async readWindow(request: DatasetWindowRequest): Promise<DatasetWindowResult> {
    request.signal?.throwIfAborted();
    const indexes = request.columnIds.map(columnIndex);
    if (indexes.some((index) => index === null || index >= this.object.columns)) {
      throw new RangeError(`Dataset ${String(request.datasetId)} received an invalid column projection.`);
    }
    const rows = [];
    const rowEnd = Math.min(Number(request.rowEnd), this.object.rows - 1);
    for (let row = Number(request.rowStart); row <= rowEnd; row += 1) {
      rows.push({
        id: asRowId(`sheet-row:${row}`),
        logicalIndex: asRowIndex(row),
        cells: indexes.map((column, projectionIndex) => {
          const record = this.object.cells?.[`r${row + 1}c${Number(column) + 1}`];
          return {
            columnId: request.columnIds[projectionIndex],
            value: record?.value ?? "",
            ...(record ? { record } : {}),
          };
        }),
      });
    }
    request.signal?.throwIfAborted();
    return {
      datasetId: request.datasetId,
      rowStart: request.rowStart,
      rows,
      columnIds: request.columnIds,
      totalRowCount: this.object.rows,
      revision: this.revision,
    };
  }

  subscribe(_datasetId: ReturnType<typeof asDatasetId>, listener: (revision: RevisionId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}