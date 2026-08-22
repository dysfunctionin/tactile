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
  DatasetAggregateOperation,
  DatasetAggregateRequest,
  DatasetAggregateResult,
  DatasetDescriptor,
  DatasetStore,
  DatasetWindowRequest,
  DatasetWindowResult,
  WorkspaceCatalog,
} from "./contracts.ts";
import { DatasetAggregateQueue } from "./aggregateQueue.ts";

const COLUMN_PREFIX = "sheet-column:";
const SUMMARY_ROWS = 64;

interface NumericSummary {
  count: number;
  sum: number;
  minimum: number | null;
  maximum: number | null;
}

function addValue(summary: NumericSummary, value: unknown): void {
  if (value === "" || value === null || value === undefined) return;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return;
  summary.count += 1;
  summary.sum += numeric;
  summary.minimum = summary.minimum === null ? numeric : Math.min(summary.minimum, numeric);
  summary.maximum = summary.maximum === null ? numeric : Math.max(summary.maximum, numeric);
}

function mergeSummary(target: NumericSummary, source: NumericSummary): void {
  target.count += source.count;
  target.sum += source.sum;
  if (source.minimum !== null) target.minimum = target.minimum === null ? source.minimum : Math.min(target.minimum, source.minimum);
  if (source.maximum !== null) target.maximum = target.maximum === null ? source.maximum : Math.max(target.maximum, source.maximum);
}

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

  private readonly aggregates = new DatasetAggregateQueue();

  private readonly summaries = new Map<string, NumericSummary>();

  constructor(object: SheetObject, revision: string) {
    this.object = object;
    this.revision = asRevisionId(revision);
  }

  update(object: SheetObject, revision: string): void {
    const nextRevision = asRevisionId(revision);
    this.object = object;
    if (nextRevision === this.revision) return;
    this.revision = nextRevision;
    this.summaries.clear();
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

  aggregate(request: DatasetAggregateRequest): DatasetAggregateOperation {
    const object = this.object;
    const revision = this.revision;
    return this.aggregates.create(request, async () => {
      request.signal?.throwIfAborted();
      if (request.datasetId !== asDatasetId(String(object.id))) throw new Error("Aggregate requested an unavailable dataset.");
      if (request.revision && request.revision !== revision) throw new Error("Aggregate requested a stale dataset revision.");
      const total: NumericSummary = { count: 0, sum: 0, minimum: null, maximum: null };
      const rowStart = Math.max(0, Number(request.range.rowStart));
      const rowEnd = Math.min(object.rows - 1, Number(request.range.rowEnd));
      for (const columnId of request.range.columnIds) {
        const column = columnIndex(columnId);
        if (column === null || column >= object.columns) continue;
        const firstFullChunk = Math.ceil(rowStart / SUMMARY_ROWS);
        const lastFullChunk = Math.floor((rowEnd + 1) / SUMMARY_ROWS) - 1;
        const scan = (start: number, end: number, summary: NumericSummary) => {
          for (let row = start; row <= end; row += 1) addValue(summary, object.cells?.[`r${row + 1}c${column + 1}`]?.value);
        };
        const prefixEnd = Math.min(rowEnd, firstFullChunk * SUMMARY_ROWS - 1);
        scan(rowStart, prefixEnd, total);
        for (let chunk = firstFullChunk; chunk <= lastFullChunk; chunk += 1) {
          const key = `${String(revision)}:${column}:${chunk}`;
          let summary = this.summaries.get(key);
          if (!summary) {
            summary = { count: 0, sum: 0, minimum: null, maximum: null };
            scan(chunk * SUMMARY_ROWS, chunk * SUMMARY_ROWS + SUMMARY_ROWS - 1, summary);
            this.summaries.set(key, summary);
          }
          mergeSummary(total, summary);
        }
        const tailStart = Math.max(rowStart, (lastFullChunk + 1) * SUMMARY_ROWS);
        if (tailStart > prefixEnd && tailStart <= rowEnd) scan(tailStart, rowEnd, total);
      }
      request.signal?.throwIfAborted();
      const values: Record<string, number> = {};
      request.functions.forEach((aggregate) => {
        if (aggregate === "count") values.count = total.count;
        if (aggregate === "sum") values.sum = total.sum;
        if (aggregate === "average") values.average = total.count ? total.sum / total.count : 0;
        if (aggregate === "minimum") values.minimum = total.minimum ?? 0;
        if (aggregate === "maximum") values.maximum = total.maximum ?? 0;
      });
      return { datasetId: request.datasetId, values, revision } as DatasetAggregateResult;
    });
  }

  subscribe(_datasetId: ReturnType<typeof asDatasetId>, listener: (revision: RevisionId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}