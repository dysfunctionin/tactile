import assert from "node:assert/strict";
import test from "node:test";

import {
  DatasetWindowManager,
  StaleDatasetWindowError,
} from "../src/core/dataset/windowManager.ts";

const request = {
  datasetId: "dataset",
  rowStart: 0,
  rowEnd: 9,
  columnIds: ["name"],
  revision: "r1",
};

function result(revision = "r1") {
  return {
    datasetId: "dataset",
    rowStart: 0,
    rows: [{ id: "row-1", logicalIndex: 0, cells: [{ columnId: "name", value: "Ada" }] }],
    columnIds: ["name"],
    totalRowCount: 1,
    revision,
  };
}

function fakeStore(readWindow) {
  const listeners = new Set();
  return {
    openCatalog: async () => ({ datasets: [], revision: "r1" }),
    readWindow,
    subscribe: (_datasetId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {},
    publish: (revision) => listeners.forEach((listener) => listener(revision)),
  };
}

test("the manager deduplicates store reads and caches matching windows", async () => {
  let reads = 0;
  const store = fakeStore(async () => {
    reads += 1;
    return result();
  });
  const manager = new DatasetWindowManager(store, { maxCacheBytes: 10_000 });

  const [first, second] = await Promise.all([manager.read(request), manager.read(request)]);
  const third = await manager.read(request);

  assert.equal(reads, 1);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(manager.cache.metrics().hits, 1);
});

test("the manager rejects a store response at the wrong revision", async () => {
  const store = fakeStore(async () => result("r0"));
  const manager = new DatasetWindowManager(store, { maxCacheBytes: 10_000 });

  await assert.rejects(manager.read(request), StaleDatasetWindowError);
  assert.equal(manager.cache.metrics().entries, 0);
});

test("revision notifications invalidate cached and in-flight stale windows", async () => {
  let resolveRead;
  const store = fakeStore(() => new Promise((resolve) => {
    resolveRead = resolve;
  }));
  const manager = new DatasetWindowManager(store, { maxCacheBytes: 10_000 });
  manager.watch("dataset");

  const pending = manager.read({ ...request, revision: undefined });
  store.publish("r2");
  resolveRead(result("r1"));

  await assert.rejects(pending, StaleDatasetWindowError);
  assert.equal(manager.cache.metrics().entries, 0);
});

test("the manager rejects mismatched projections before caching", async () => {
  const store = fakeStore(async () => ({ ...result(), columnIds: ["other"] }));
  const manager = new DatasetWindowManager(store, { maxCacheBytes: 10_000 });

  await assert.rejects(manager.read(request), /unexpected column projection/);
  assert.equal(manager.cache.metrics().entries, 0);
});