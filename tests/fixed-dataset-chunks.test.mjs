import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXED_DATASET_CHUNK_COLUMNS,
  FIXED_DATASET_CHUNK_ROWS,
  FixedDatasetChunkReader,
  FixedDatasetChunkManager,
  SheetSnapshotDatasetStore,
  planFixedDatasetChunks,
} from "../src/core/dataset/index.ts";

const descriptor = {
  id: "dataset",
  objectId: "sheet",
  title: "Dataset",
  storageMode: "virtual",
  rowCount: 150,
  columns: Array.from({ length: 150 }, (_, logicalIndex) => ({
    id: `column-${logicalIndex}`,
    name: `Column ${logicalIndex + 1}`,
    logicalIndex,
  })),
  revision: "7",
};

test("viewport ranges snap to fixed 64 by 64 chunks", () => {
  assert.equal(FIXED_DATASET_CHUNK_ROWS, 64);
  assert.equal(FIXED_DATASET_CHUNK_COLUMNS, 64);
  const plan = planFixedDatasetChunks(descriptor, {
    datasetId: "dataset",
    rowStart: 62,
    rowEnd: 130,
    columnStart: 63,
    columnEnd: 129,
  });

  assert.deepEqual(
    plan.map(({ rowChunk, columnChunk }) => [rowChunk, columnChunk]),
    [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]],
  );
  assert.deepEqual(
    plan.map(({ request }) => [request.rowStart, request.rowEnd, request.columnIds.length]),
    [
      [0, 63, 64], [0, 63, 64], [0, 63, 22],
      [64, 127, 64], [64, 127, 64], [64, 127, 22],
      [128, 149, 64], [128, 149, 64], [128, 149, 22],
    ],
  );
});

test("movement within one chunk produces the same canonical request", () => {
  const first = planFixedDatasetChunks(descriptor, {
    datasetId: "dataset",
    rowStart: 4,
    rowEnd: 20,
    columnStart: 8,
    columnEnd: 24,
  });
  const second = planFixedDatasetChunks(descriptor, {
    datasetId: "dataset",
    rowStart: 12,
    rowEnd: 28,
    columnStart: 16,
    columnEnd: 32,
  });

  assert.deepEqual(first, second);
});

function operationStore() {
  const calls = { reads: 0, aggregates: 0, structures: 0 };
  const store = {
    async openCatalog() { return { datasets: [descriptor], revision: "7" }; },
    async readWindow(request) {
      calls.reads += 1;
      return {
        datasetId: request.datasetId,
        rowStart: request.rowStart,
        rows: Array.from({ length: request.rowEnd - request.rowStart + 1 }, (_, offset) => {
          const logicalIndex = request.rowStart + offset;
          return {
            id: `row-${logicalIndex}`,
            logicalIndex,
            cells: request.columnIds.map((columnId) => ({ columnId, value: `${logicalIndex}:${columnId}` })),
          };
        }),
        columnIds: request.columnIds,
        totalRowCount: descriptor.rowCount,
        revision: "7",
      };
    },
    aggregate() {
      calls.aggregates += 1;
      return { getSnapshot: () => ({ status: "deferred" }), subscribe: () => () => {}, resolve: async () => ({}), cancel() {} };
    },
    async mutateStructure(request) {
      calls.structures += 1;
      return { datasetId: request.datasetId, rowCount: 151, columnCount: 150, revision: "8" };
    },
    subscribe() { return () => {}; },
    async close() {},
  };
  return { calls, store };
}

test("viewport reads reuse canonical chunks and merge only requested cells", async () => {
  const { calls, store } = operationStore();
  const manager = new FixedDatasetChunkManager(store, { maxCacheBytes: 16 * 1024 * 1024 });
  const first = await manager.read(descriptor, {
    datasetId: "dataset", rowStart: 10, rowEnd: 20, columnStart: 10, columnEnd: 20,
  });
  const second = await manager.read(descriptor, {
    datasetId: "dataset", rowStart: 12, rowEnd: 22, columnStart: 12, columnEnd: 22,
  });

  assert.equal(calls.reads, 1);
  assert.equal(first.rows.length, 11);
  assert.equal(first.rows[0].cells.length, 11);
  assert.equal(second.rows[0].cells[0].value, "12:column-12");
  await manager.close();
});

test("sheet snapshot windows preserve cell records and refresh on revision changes", async () => {
  const sheet = {
    id: "sheet",
    type: "sheet",
    title: "Sheet",
    rows: 100,
    columns: 100,
    cells: {
      r2c3: { id: "r2c3", address: "C2", row: 1, column: 2, value: "before", formula: "", style: { bold: true } },
    },
  };
  const store = new SheetSnapshotDatasetStore(sheet, "1");
  const reader = new FixedDatasetChunkReader(store, { maxCacheBytes: 16 * 1024 * 1024 });
  const firstDescriptor = store.descriptor();
  const first = await reader.read(firstDescriptor, {
    datasetId: firstDescriptor.id, rowStart: 0, rowEnd: 4, columnStart: 0, columnEnd: 4,
  });

  assert.equal(first.rows[1].cells[2].record.style.bold, true);
  const nextSheet = {
    ...sheet,
    cells: { ...sheet.cells, r2c3: { ...sheet.cells.r2c3, value: "after" } },
  };
  store.update(nextSheet, "2");
  const secondDescriptor = store.descriptor();
  const second = await reader.read(secondDescriptor, {
    datasetId: secondDescriptor.id, rowStart: 0, rowEnd: 4, columnStart: 0, columnEnd: 4,
  });

  assert.equal(second.rows[1].cells[2].record.value, "after");
  assert.equal(second.revision, "2");
  await reader.close();
});

test("aggregates remain one lazy global operation and structure invalidates chunks once", async () => {
  const { calls, store } = operationStore();
  const manager = new FixedDatasetChunkManager(store, { maxCacheBytes: 16 * 1024 * 1024 });
  const viewport = { datasetId: "dataset", rowStart: 0, rowEnd: 10, columnStart: 0, columnEnd: 10 };
  await manager.read(descriptor, viewport);
  const aggregate = manager.aggregate({
    datasetId: "dataset",
    range: { rowStart: 0, rowEnd: 149, columnIds: ["column-0"] },
    functions: ["sum"],
  });

  assert.equal(calls.aggregates, 1);
  assert.equal(aggregate.getSnapshot().status, "deferred");
  await manager.mutateStructure({ datasetId: "dataset", axis: "row", operation: "insert", index: 5, count: 1 });
  await manager.read(descriptor, viewport);
  assert.equal(calls.structures, 1);
  assert.equal(calls.reads, 2);
  await manager.close();
});