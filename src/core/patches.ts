import type { AssetRecord, CellRecord, ThemeRecord, WorkspaceMeta, WorkspaceObject } from "./domain.ts";
import type { AssetId, CellId, ObjectId, PatchId, RevisionId, ThemeId } from "./ids.ts";

export type DirtyRecordType = "workspace" | "object" | "cell" | "asset" | "theme";
export type DirtyReason = "command" | "undo" | "redo" | "import" | "migration" | "recovery";

export interface DirtyRecord {
  recordType: DirtyRecordType;
  recordId: string;
  objectId?: ObjectId;
  reason: DirtyReason;
}

export interface ReplaceWorkspaceMetaOperation {
  kind: "replace-workspace-meta";
  before: WorkspaceMeta;
  after: WorkspaceMeta;
}

export interface ReplaceObjectOperation {
  kind: "replace-object";
  objectId: ObjectId;
  before: WorkspaceObject | null;
  after: WorkspaceObject | null;
  // `after` is a clone, and cloning drops the symbol a partial sheet is marked
  // with, so the mark has to travel as data or persistence would rewrite the
  // sheet's blocks from a floor.
  partialCells?: boolean;
}

export interface ReplaceCellOperation {
  kind: "replace-cell";
  objectId: ObjectId;
  cellId: CellId;
  before: CellRecord | null;
  after: CellRecord | null;
}

export interface ReplaceAssetOperation {
  kind: "replace-asset";
  assetId: AssetId;
  before: AssetRecord | null;
  after: AssetRecord | null;
}

export interface ReplaceThemeOperation {
  kind: "replace-theme";
  themeId: ThemeId;
  before: ThemeRecord | null;
  after: ThemeRecord | null;
}

/**
 * Moves a partial sheet's stored cells for a row or column insert/delete.
 *
 * A complete sheet needs nothing here: its blocks are rewritten from
 * `object.cells`, which the command already shifted. A partial sheet holds
 * only a floor, so the cells it never loaded have to be shifted where they
 * live, and that is a store walk rather than a record replacement.
 */
export interface ShiftCellsOperation {
  kind: "shift-cells";
  objectId: ObjectId;
  axis: "row" | "column";
  index: number;
  operation: "insert" | "delete";
  // Two inserts at the same index are two separate moves, so each shift needs
  // an identity of its own or patch coalescing would merge them into one.
  token: string;
  /** Written into the blocks once the shift lands. */
  cells?: Record<string, CellRecord>;
  /** What the shift takes out, so inverting it can put the cells back. */
  removed?: Record<string, CellRecord>;
}

export type WorkspacePatchOperation =
  | ReplaceWorkspaceMetaOperation
  | ReplaceObjectOperation
  | ReplaceCellOperation
  | ReplaceAssetOperation
  | ReplaceThemeOperation
  | ShiftCellsOperation;

export interface WorkspacePatch {
  id: PatchId;
  baseRevision: RevisionId;
  targetRevision: RevisionId;
  operations: readonly WorkspacePatchOperation[];
}

export interface TransactionResult {
  revision: RevisionId;
  changedObjectIds: ObjectId[];
  changedCellIds: CellId[];
  invalidatedFormulaIds: CellId[];
  forwardPatch: WorkspacePatch;
  inversePatch: WorkspacePatch;
  dirtyRecords: DirtyRecord[];
}
