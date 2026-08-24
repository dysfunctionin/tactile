import assert from "node:assert/strict";

import { createMemoryChunkStore, seedChunks } from "../../../src/core/dataset/chunkStore.js";
import { hydrateWorkspaceCells, readAllCells } from "../../../src/core/dataset/hydrate.js";
import { createStorageModePolicy, virtualSheetIds } from "../../../src/core/dataset/storageMode.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "dataset-hydrate" });

function cell(id, value) {
  return { id, address: id, value };
}

function sheetWorkspace(cells) {
  return {
    objects: {
      "sheet-1": { id: "sheet-1", type: "sheet", title: "Sheet", rows: 500, columns: 40, cells },
      "note-1": { id: "note-1", type: "markdown", content: "hello" },
    },
  };
}

async function storeWith(cells) {
  const store = createMemoryChunkStore();
  await seedChunks(store, "sheet-1", cells);
  return store;
}

scenario("reads every block a sheet has, not just one window", async () => {
  // Two cells far enough apart to land in different blocks.
  const store = await storeWith({ A1: cell("A1", "first"), BZ400: cell("BZ400", "far") });

  const cells = await readAllCells(store, "sheet-1");

  assert.deepEqual(Object.keys(cells).sort(), ["A1", "BZ400"]);
});

scenario("reads nothing for a sheet with no blocks", async () => {
  assert.deepEqual(await readAllCells(createMemoryChunkStore(), "sheet-1"), {});
});

scenario("fills a partial sheet from the store", async () => {
  const store = await storeWith({ A1: cell("A1", "first"), B2: cell("B2", "second") });
  const workspace = sheetWorkspace({ A1: cell("A1", "first") });

  const hydrated = await hydrateWorkspaceCells(store, workspace, ["sheet-1"]);

  assert.deepEqual(Object.keys(hydrated.objects["sheet-1"].cells).sort(), ["A1", "B2"]);
});

scenario("keeps the in-memory cell when both copies exist", async () => {
  const store = await storeWith({ A1: cell("A1", "stored") });
  const workspace = sheetWorkspace({ A1: cell("A1", "edited") });

  const hydrated = await hydrateWorkspaceCells(store, workspace, ["sheet-1"]);

  // An edit that has not been written through yet must not be reverted by the
  // older copy sitting in the block.
  assert.equal(hydrated.objects["sheet-1"].cells.A1.value, "edited");
});

scenario("leaves the original workspace untouched", async () => {
  const store = await storeWith({ A1: cell("A1", "first"), B2: cell("B2", "second") });
  const workspace = sheetWorkspace({ A1: cell("A1", "first") });

  await hydrateWorkspaceCells(store, workspace, ["sheet-1"]);

  assert.deepEqual(Object.keys(workspace.objects["sheet-1"].cells), ["A1"]);
});

scenario("returns the same workspace when nothing needs filling", async () => {
  const workspace = sheetWorkspace({ A1: cell("A1", "first") });

  assert.equal(await hydrateWorkspaceCells(createMemoryChunkStore(), workspace, ["sheet-1"]), workspace);
  assert.equal(await hydrateWorkspaceCells(null, workspace, ["sheet-1"]), workspace);
  assert.equal(await hydrateWorkspaceCells(createMemoryChunkStore(), workspace, []), workspace);
});

scenario("ignores an id that is not a sheet", async () => {
  const store = await storeWith({ A1: cell("A1", "first") });
  const workspace = sheetWorkspace({});

  const hydrated = await hydrateWorkspaceCells(store, workspace, ["note-1", "missing"]);

  assert.equal(hydrated, workspace);
});

scenario("selects only the sheets the policy made virtual", () => {
  const policy = createStorageModePolicy({ threshold: 2 });
  const workspace = sheetWorkspace({ A1: cell("A1", "first") });
  policy.modeForSheet(workspace.objects["sheet-1"]);

  assert.deepEqual(virtualSheetIds(workspace, policy), []);

  policy.modeFor("sheet-1", 10);

  assert.deepEqual(virtualSheetIds(workspace, policy), ["sheet-1"]);
});
