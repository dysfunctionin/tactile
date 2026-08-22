import type {
  DatasetAggregateOperation,
  DatasetAggregateRequest,
  DatasetAggregateResult,
  DatasetAggregateSnapshot,
} from "./contracts.ts";

interface QueueEntry {
  request: DatasetAggregateRequest;
  operation: QueuedAggregateOperation;
  run: () => Promise<DatasetAggregateResult>;
}

class QueuedAggregateOperation implements DatasetAggregateOperation {
  private readonly enqueue: () => void;

  private snapshot: DatasetAggregateSnapshot = { status: "deferred" };

  private readonly listeners = new Set<() => void>();

  private promise: Promise<DatasetAggregateResult> | null = null;

  private resolvePromise: ((result: DatasetAggregateResult) => void) | null = null;

  private rejectPromise: ((error: Error) => void) | null = null;

  constructor(enqueue: () => void) {
    this.enqueue = enqueue;
  }

  getSnapshot(): DatasetAggregateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolve(): Promise<DatasetAggregateResult> {
    if (!this.promise) {
      this.promise = new Promise((resolve, reject) => {
        this.resolvePromise = resolve;
        this.rejectPromise = reject;
      });
      this.enqueue();
    }
    return this.promise;
  }

  cancel(): void {
    if (["ready", "error", "cancelled"].includes(this.snapshot.status)) return;
    const error = new Error("Aggregate operation cancelled.");
    error.name = "AbortError";
    this.publish({ status: "cancelled", error });
    this.rejectPromise?.(error);
  }

  setStatus(status: DatasetAggregateSnapshot["status"]): void {
    this.publish({ status });
  }

  complete(result: DatasetAggregateResult): void {
    if (this.snapshot.status === "cancelled") return;
    this.publish({ status: "ready", result });
    this.resolvePromise?.(result);
  }

  fail(error: Error): void {
    if (this.snapshot.status === "cancelled") return;
    this.publish({ status: "error", error });
    this.rejectPromise?.(error);
  }

  private publish(snapshot: DatasetAggregateSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

export class DatasetAggregateQueue {
  private readonly pending: QueueEntry[] = [];

  private running = false;

  create(request: DatasetAggregateRequest, run: () => Promise<DatasetAggregateResult>): DatasetAggregateOperation {
    let queued = false;
    const operation = new QueuedAggregateOperation(() => {
      if (queued || operation.getSnapshot().status === "cancelled") return;
      queued = true;
      operation.setStatus("queued");
      this.pending.push({ request, operation, run });
      this.pending.sort(
        (left, right) => (left.request.priority === "visible" ? 0 : 1) - (right.request.priority === "visible" ? 0 : 1),
      );
      queueMicrotask(() => this.drain());
    });
    return operation;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const entry = this.pending.shift();
        if (!entry || entry.operation.getSnapshot().status === "cancelled") continue;
        entry.operation.setStatus("running");
        try {
          entry.operation.complete(await entry.run());
        } catch (error) {
          entry.operation.fail(error instanceof Error ? error : new Error(String(error)));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.running = false;
    }
  }
}
