import type { DatasetWindowRequest, DatasetWindowResult } from "./contracts.ts";

interface CacheEntry {
  value: DatasetWindowResult;
  sizeBytes: number;
  pins: number;
}

export interface DatasetWindowCacheMetrics {
  entries: number;
  bytes: number;
  maxBytes: number;
  pinnedEntries: number;
  inFlight: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface LoadedDatasetWindow {
  value: DatasetWindowResult;
  sizeBytes: number;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

export function datasetWindowCacheKey(request: DatasetWindowRequest): string {
  return JSON.stringify([
    request.datasetId,
    request.viewId || "",
    request.revision || "",
    request.rowStart,
    request.rowEnd,
    request.columnIds,
  ]);
}

export function estimateDatasetWindowBytes(window: DatasetWindowResult): number {
  let bytes = 128 + window.columnIds.length * 16;
  for (const row of window.rows) {
    bytes += 48 + String(row.id).length * 2;
    for (const cell of row.cells) {
      bytes += 40 + String(cell.columnId).length * 2;
      if (typeof cell.value === "string") bytes += cell.value.length * 2;
      else bytes += 8;
      if (typeof cell.calculatedValue === "string") bytes += cell.calculatedValue.length * 2;
      else if (cell.calculatedValue !== undefined) bytes += 8;
      if (cell.error) bytes += cell.error.length * 2;
    }
  }
  return bytes;
}

export class DatasetWindowCache {
  private readonly entries = new Map<string, CacheEntry>();

  private readonly inFlight = new Map<string, Promise<DatasetWindowResult>>();

  private bytes = 0;

  private hits = 0;

  private misses = 0;

  private evictions = 0;

  readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = nonNegativeInteger(maxBytes, "maxBytes");
  }

  get(key: string): DatasetWindowResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.touch(key, entry);
    return entry.value;
  }

  peek(key: string): DatasetWindowResult | undefined {
    return this.entries.get(key)?.value;
  }

  put(key: string, value: DatasetWindowResult, sizeBytes = estimateDatasetWindowBytes(value)): boolean {
    const size = nonNegativeInteger(sizeBytes, "sizeBytes");
    if (size > this.maxBytes) return false;

    const existing = this.entries.get(key);
    const targetBytes = this.bytes - (existing?.sizeBytes || 0) + size;
    if (!this.evictToFit(targetBytes, key)) return false;

    if (existing) this.bytes -= existing.sizeBytes;
    const entry = { value, sizeBytes: size, pins: existing?.pins || 0 };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.bytes += size;
    return true;
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.sizeBytes;
    return true;
  }

  pin(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.pins += 1;
    this.touch(key, entry);
    return true;
  }

  unpin(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.pins === 0) return false;
    entry.pins -= 1;
    return true;
  }

  invalidate(predicate: (value: DatasetWindowResult, key: string) => boolean): number {
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (!predicate(entry.value, key)) continue;
      this.entries.delete(key);
      this.bytes -= entry.sizeBytes;
      count += 1;
    }
    return count;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  async load(key: string, loader: () => Promise<LoadedDatasetWindow>): Promise<DatasetWindowResult> {
    const cached = this.get(key);
    if (cached) return cached;
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const load = loader()
      .then(({ value, sizeBytes }) => {
        this.put(key, value, sizeBytes);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, load);
    return load;
  }

  metrics(): DatasetWindowCacheMetrics {
    let pinnedEntries = 0;
    for (const entry of this.entries.values()) {
      if (entry.pins > 0) pinnedEntries += 1;
    }
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      pinnedEntries,
      inFlight: this.inFlight.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictToFit(targetBytes: number, protectedKey: string): boolean {
    if (targetBytes <= this.maxBytes) return true;
    let evictableBytes = 0;
    for (const [key, entry] of this.entries) {
      if (key !== protectedKey && entry.pins === 0) evictableBytes += entry.sizeBytes;
    }
    if (targetBytes - evictableBytes > this.maxBytes) return false;

    let remaining = targetBytes;
    for (const [key, entry] of this.entries) {
      if (key === protectedKey || entry.pins > 0) continue;
      this.entries.delete(key);
      this.bytes -= entry.sizeBytes;
      remaining -= entry.sizeBytes;
      this.evictions += 1;
      if (remaining <= this.maxBytes) return true;
    }
    return false;
  }
}