import type { CellRecord, CellScalar } from "../domain.ts";
import type { ColumnId, DatasetId, DatasetViewId, ObjectId, RevisionId, RowId, RowIndex } from "../ids.ts";

export type DatasetStorageMode = "eager" | "virtual";

export interface DatasetColumn {
  id: ColumnId;
  name: string;
  logicalIndex: number;
  dataType?: "string" | "number" | "boolean" | "mixed";
}

export interface DatasetDescriptor {
  id: DatasetId;
  objectId: ObjectId;
  title: string;
  storageMode: DatasetStorageMode;
  rowCount: number;
  columns: readonly DatasetColumn[];
  revision: RevisionId;
}

export interface WorkspaceCatalog {
  datasets: readonly DatasetDescriptor[];
  revision: RevisionId;
}

export interface DatasetWindowRequest {
  datasetId: DatasetId;
  viewId?: DatasetViewId;
  rowStart: RowIndex;
  rowEnd: RowIndex;
  columnIds: readonly ColumnId[];
  revision?: RevisionId;
  overscan?: number;
  priority?: "visible" | "prefetch";
  signal?: AbortSignal;
}

export interface DatasetWindowCell {
  columnId: ColumnId;
  value: CellScalar;
  calculatedValue?: CellScalar;
  record?: CellRecord;
  state?: "ready" | "pending" | "stale" | "error";
  error?: string;
}

export interface DatasetWindowRow {
  id: RowId;
  logicalIndex: RowIndex;
  cells: readonly DatasetWindowCell[];
}

export interface DatasetWindowResult {
  datasetId: DatasetId;
  viewId?: DatasetViewId;
  rowStart: RowIndex;
  rows: readonly DatasetWindowRow[];
  columnIds: readonly ColumnId[];
  totalRowCount: number;
  revision: RevisionId;
}

export interface DatasetLogicalRange {
  rowStart: RowIndex;
  rowEnd: RowIndex;
  columnIds: readonly ColumnId[];
}

export type DatasetAggregateFunction = "count" | "sum" | "average" | "minimum" | "maximum";

export interface DatasetAggregateRequest {
  datasetId: DatasetId;
  viewId?: DatasetViewId;
  range: DatasetLogicalRange;
  functions: readonly DatasetAggregateFunction[];
  revision?: RevisionId;
  priority?: "visible" | "background";
  signal?: AbortSignal;
}

export interface DatasetAggregateResult {
  datasetId: DatasetId;
  values: Readonly<Partial<Record<DatasetAggregateFunction, CellScalar>>>;
  revision: RevisionId;
}

export type DatasetAggregateStatus = "deferred" | "queued" | "running" | "ready" | "error" | "cancelled";

export interface DatasetAggregateSnapshot {
  status: DatasetAggregateStatus;
  result?: DatasetAggregateResult;
  error?: Error;
}

export interface DatasetAggregateOperation {
  getSnapshot(): DatasetAggregateSnapshot;
  subscribe(listener: () => void): () => void;
  resolve(): Promise<DatasetAggregateResult>;
  cancel(): void;
}

export interface DatasetStructureRequest {
  datasetId: DatasetId;
  axis: "row" | "column";
  operation: "insert" | "delete";
  index: number;
  count: number;
  revision?: RevisionId;
  signal?: AbortSignal;
}

export interface DatasetStructureResult {
  datasetId: DatasetId;
  rowCount: number;
  columnCount: number;
  revision: RevisionId;
}

export interface DatasetStore {
  openCatalog(signal?: AbortSignal): Promise<WorkspaceCatalog>;
  readWindow(request: DatasetWindowRequest): Promise<DatasetWindowResult>;
  subscribe(datasetId: DatasetId, listener: (revision: RevisionId) => void): () => void;
  close(): Promise<void>;
}

/** Operations whose semantics span logical ranges, independently of cache chunk boundaries. */
export interface OperationalDatasetStore extends DatasetStore {
  aggregate(request: DatasetAggregateRequest): DatasetAggregateOperation;
  mutateStructure(request: DatasetStructureRequest): Promise<DatasetStructureResult>;
}
