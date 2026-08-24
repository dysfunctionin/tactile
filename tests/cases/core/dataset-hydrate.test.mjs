import assert from "node:assert/strict";

import { createMemoryChunkStore, seedChunks } from "../../../src/core/dataset/chunkStore.js";
import { hydrateWorkspaceCells, readAllCells } from "../../../src/core/dataset/hydrate.js";
import { createStorageModePolicy, virtualSheetIds } from "../../../src/core/dataset/storageMode.js";
import { cellId } from "../../../src/core/sheet/coordinates.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "dataset-hydrate" });

// Far enough apart to land in different 64x64 blocks.
const NEAR = cellId(0, 0);
const FAR = cellId(400, 70);

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
  const store = await storeWith({ [NEAR]: cell(NEAR, "first"), [FAR]: cell(FAR, "far") });

  const cells = await readAllCells(store, "sheet-1");

  assert.deepEqual(Object.keys(cells).sort(), [NEAR, FAR].sort());
});

scenario("reads nothing for a sheet with no blocks", async () => {
  assert.deepEqual(await readAllCells(createMemoryChunkStore(), "sheet-1"), {});
});

scenario("fills a partial sheet from the store", async () => {
  const store = await storeWith({ [NEAR]: cell(NEAR, "first"), [FAR]: cell(FAR, "second") });
  const workspace = sheetWorkspace({ [NEAR]: cell(NEAR, "first") });

  const hydrated = await hydrateWorkspaceCells(store, workspace, ["sheet-1"]);

  assert.deepEqual(Object.keys(hydrated.objects["sheet-1"].cells).sort(), [NEAR, FAR].sort());
});

scenario("keeps the in-memory cell when both copies exist", async () => {
  const store = await storeWith({ [NEAR]: cell(NEAR, "stored") });
  const workspace = sheetWorkspace({ [NEAR]: cell(NEAR, "edited") });

  const hydrated = await hydrateWorkspaceCells(store, workspace, ["sheet-1"]);

  // An edit that has not been written through yet must not be reverted by the
  // older copy sitting in the block.
  assert.equal(hydrated.objects["sheet-1"].cells[NEAR].value, "edited");
});

scenario("leaves the original workspace untouched", async () => {
  const store = await storeWith({ [NEAR]: cell(NEAR, "first"), [FAR]: cell(FAR, "second") });
  const workspace = sheetWorkspace({ [NEAR]: cell(NEAR, "first") });

  await hydrateWorkspaceCells(store, workspace, ["sheet-1"]);

  assert.deepEqual(Object.keys(workspace.objects["sheet-1"].cells), [NEAR]);
});

scenario("returns the same workspace when nothing needs filling", async () => {
  const workspace = sheetWorkspace({ [NEAR]: cell(NEAR, "first") });

  assert.equal(await hydrateWorkspaceCells(createMemoryChunkStore(), workspace, ["sheet-1"]), workspace);
  assert.equal(await hydrateWorkspaceCells(null, workspace, ["sheet-1"]), workspace);
  assert.equal(await hydrateWorkspaceCells(createMemoryChunkStore(), workspace, []), workspace);
});

scenario("ignores an id that is not a sheet", async () => {
  const store = await storeWith({ [NEAR]: cell(NEAR, "first") });
  const workspace = sheetWorkspace({});

  const hydrated = await hydrateWorkspaceCells(store, workspace, ["note-1", "missing"]);

  assert.equal(hydrated, workspace);
});

scenario("selects only the sheets the policy made virtual", () => {
  const policy = createStorageModePolicy({ threshold: 2 });
  const workspace = sheetWorkspace({ [NEAR]: cell(NEAR, "first") });
  policy.modeForSheet(workspace.objects["sheet-1"]);

  assert.deepEqual(virtualSheetIds(workspace, policy), []);

  policy.modeFor("sheet-1", 10);

  assert.deepEqual(virtualSheetIds(workspace, policy), ["sheet-1"]);
});
