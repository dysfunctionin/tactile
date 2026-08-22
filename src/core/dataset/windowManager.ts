import type { DatasetId, RevisionId } from "../ids.ts";
import type { DatasetStore, DatasetWindowRequest, DatasetWindowResult } from "./contracts.ts";
import { DatasetWindowCache, datasetWindowCacheKey, estimateDatasetWindowBytes } from "./windowCache.ts";

export interface DatasetWindowManagerOptions {
  maxCacheBytes: number;
}

export class StaleDatasetWindowError extends Error {
  readonly datasetId: DatasetId;

  readonly receivedRevision: RevisionId;

  readonly expectedRevision: RevisionId;

  constructor(datasetId: DatasetId, receivedRevision: RevisionId, expectedRevision: RevisionId) {
    super(
      `Dataset ${String(datasetId)} returned revision ${String(receivedRevision)}; expected ${String(expectedRevision)}.`,
    );
    this.name = "StaleDatasetWindowError";
    this.datasetId = datasetId;
    this.receivedRevision = receivedRevision;
    this.expectedRevision = expectedRevision;
  }
}

function assertWindowMatchesRequest(request: DatasetWindowRequest, result: DatasetWindowResult): void {
  if (result.datasetId !== request.datasetId) {
    throw new Error(`Dataset window returned ${String(result.datasetId)} for ${String(request.datasetId)}.`);
  }
  if ((result.viewId || "") !== (request.viewId || "")) {
    throw new Error(`Dataset window returned an unexpected view for ${String(request.datasetId)}.`);
  }
  if (result.rowStart !== request.rowStart) {
    throw new Error(`Dataset window returned row ${result.rowStart} for requested row ${request.rowStart}.`);
  }
  if (
    result.columnIds.length !== request.columnIds.length ||
    result.columnIds.some((columnId, index) => columnId !== request.columnIds[index])
  ) {
    throw new Error(`Dataset window returned an unexpected column projection for ${String(request.datasetId)}.`);
  }
}

export class DatasetWindowManager {
  readonly cache: DatasetWindowCache;

  private readonly store: DatasetStore;

  private readonly latestRevisions = new Map<DatasetId, RevisionId>();

  private readonly subscriptions = new Map<DatasetId, () => void>();

  constructor(store: DatasetStore, options: DatasetWindowManagerOptions) {
    this.store = store;
    this.cache = new DatasetWindowCache(options.maxCacheBytes);
  }

  read(request: DatasetWindowRequest): Promise<DatasetWindowResult> {
    const key = datasetWindowCacheKey(request);
    return this.cache.load(key, async () => {
      const value = await this.store.readWindow(request);
      assertWindowMatchesRequest(request, value);
      const expectedRevision = request.revision || this.latestRevisions.get(request.datasetId);
      if (expectedRevision && value.revision !== expectedRevision) {
        throw new StaleDatasetWindowError(request.datasetId, value.revision, expectedRevision);
      }
      return { value, sizeBytes: estimateDatasetWindowBytes(value) };
    });
  }

  prefetch(request: DatasetWindowRequest): Promise<DatasetWindowResult> {
    return this.read({ ...request, priority: "prefetch" });
  }

  pin(request: DatasetWindowRequest): boolean {
    return this.cache.pin(datasetWindowCacheKey(request));
  }

  unpin(request: DatasetWindowRequest): boolean {
    return this.cache.unpin(datasetWindowCacheKey(request));
  }

  watch(datasetId: DatasetId): () => void {
    const existing = this.subscriptions.get(datasetId);
    if (existing) return existing;
    const unsubscribeStore = this.store.subscribe(datasetId, (revision) => {
      this.latestRevisions.set(datasetId, revision);
      this.cache.invalidate((value) => value.datasetId === datasetId && value.revision !== revision);
    });
    const unsubscribe = () => {
      unsubscribeStore();
      this.subscriptions.delete(datasetId);
      this.latestRevisions.delete(datasetId);
    };
    this.subscriptions.set(datasetId, unsubscribe);
    return unsubscribe;
  }

  close(): Promise<void> {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.latestRevisions.clear();
    this.cache.clear();
    return this.store.close();
  }
}
