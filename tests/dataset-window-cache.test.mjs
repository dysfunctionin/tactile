import assert from "node:assert/strict";
import test from "node:test";

import {
  DatasetWindowCache,
  datasetWindowCacheKey,
} from "../src/core/dataset/windowCache.ts";

function windowResult(id, revision = "r1") {
  return {
    datasetId: "dataset",
    rowStart: 0,
    rows: [{ id: `row-${id}`, logicalIndex: 0, cells: [] }],
    columnIds: ["column"],
    totalRowCount: 1,
    revision,
  };
}

test("window keys distinguish revisions, views, ranges, and column projections", () => {
  const base = {
    datasetId: "dataset",
    rowStart: 0,
    rowEnd: 99,
    columnIds: ["a", "b"],
    revision: "r1",
  };

  const keys = new Set([
    datasetWindowCacheKey(base),
    datasetWindowCacheKey({ ...base, revision: "r2" }),
    datasetWindowCacheKey({ ...base, viewId: "filtered" }),
    datasetWindowCacheKey({ ...base, rowStart: 100, rowEnd: 199 }),
    datasetWindowCacheKey({ ...base, columnIds: ["b", "a"] }),
  ]);

  assert.equal(keys.size, 5);
});

test("the cache evicts least-recently-used unpinned windows within its byte budget", () => {
  const cache = new DatasetWindowCache(20);
  cache.put("a", windowResult("a"), 10);
  cache.put("b", windowResult("b"), 10);
  assert.equal(cache.get("a")?.rows[0].id, "row-a");

  cache.put("c", windowResult("c"), 10);

  assert.equal(cache.peek("a")?.rows[0].id, "row-a");
  assert.equal(cache.peek("b"), undefined);
  assert.equal(cache.peek("c")?.rows[0].id, "row-c");
  assert.deepEqual(cache.metrics(), {
    entries: 2,
    bytes: 20,
    maxBytes: 20,
    pinnedEntries: 0,
    inFlight: 0,
    hits: 1,
    misses: 0,
    evictions: 1,
  });
});

test("pinned visible windows are not evicted and impossible inserts are rejected", () => {
  const cache = new DatasetWindowCache(10);
  assert.equal(cache.put("visible", windowResult("visible"), 10), true);
  assert.equal(cache.pin("visible"), true);

  assert.equal(cache.put("prefetch", windowResult("prefetch"), 10), false);
  assert.equal(cache.peek("visible")?.rows[0].id, "row-visible");
  assert.equal(cache.peek("prefetch"), undefined);
  assert.equal(cache.metrics().bytes, 10);
});

test("a rejected insert does not partially evict existing windows", () => {
  const cache = new DatasetWindowCache(30);
  cache.put("pinned", windowResult("pinned"), 20);
  cache.put("cached", windowResult("cached"), 10);
  cache.pin("pinned");

  assert.equal(cache.put("too-large", windowResult("too-large"), 20), false);
  assert.equal(cache.peek("pinned")?.rows[0].id, "row-pinned");
  assert.equal(cache.peek("cached")?.rows[0].id, "row-cached");
  assert.equal(cache.metrics().bytes, 30);
});

test("concurrent loads for one window share a single request", async () => {
  const cache = new DatasetWindowCache(100);
  let calls = 0;
  let resolveLoad;
  const loader = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveLoad = () => resolve({ value: windowResult("shared"), sizeBytes: 20 });
    });
  };

  const first = cache.load("shared", loader);
  const second = cache.load("shared", loader);
  assert.equal(calls, 1);
  assert.equal(cache.metrics().inFlight, 1);
  resolveLoad();

  assert.equal(await first, await second);
  assert.equal(cache.metrics().inFlight, 0);
  assert.equal(cache.peek("shared")?.rows[0].id, "row-shared");
});

test("revision invalidation removes matching windows even when pinned", () => {
  const cache = new DatasetWindowCache(100);
  cache.put("r1", windowResult("old", "r1"), 20);
  cache.put("r2", windowResult("new", "r2"), 20);
  cache.pin("r1");

  assert.equal(cache.invalidate((value) => value.datasetId === "dataset" && value.revision !== "r2"), 1);
  assert.equal(cache.peek("r1"), undefined);
  assert.equal(cache.peek("r2")?.revision, "r2");
  assert.equal(cache.metrics().bytes, 20);
});