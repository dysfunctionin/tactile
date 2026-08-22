import assert from "node:assert/strict";
import test from "node:test";

import { createBlankWorkspace } from "../src/core/model.ts";
import { EagerDatasetStore, eagerColumnId } from "../src/core/dataset/index.ts";
import { createWorkspaceEngine } from "../src/core/engine/index.ts";

function command(cellId, value, sequence) {
  return {
    commandId: `eager-dataset-${sequence}`,
    issuedAt: `2026-08-22T00:00:0${sequence}.000Z`,
    source: "keyboard",
    type: "set-cell",
    objectId: "home",
    cellId,
    patch: { value },
  };
}

test("the eager adapter exposes existing sheets through projected async windows", async () => {
  const engine = createWorkspaceEngine(createBlankWorkspace({ id: "eager-dataset" }));
  await engine.dispatch(command("r1c1", "Ada", 1));
  await engine.dispatch(command("r1c3", "Lovelace", 2));
  const store = new EagerDatasetStore(engine);

  const catalog = await store.openCatalog();
  assert.equal(catalog.datasets.length, 1);
  assert.equal(catalog.datasets[0].storageMode, "eager");
  assert.equal(catalog.datasets[0].rowCount, 256);

  const window = await store.readWindow({
    datasetId: "home",
    rowStart: 0,
    rowEnd: 1,
    columnIds: [eagerColumnId(0), eagerColumnId(2)],
  });

  assert.equal(window.rows.length, 2);
  assert.deepEqual(window.rows[0].cells.map((cell) => cell.value), ["Ada", "Lovelace"]);
  assert.deepEqual(window.rows[1].cells.map((cell) => cell.value), ["", ""]);
});

test("the eager adapter forwards dataset revision subscriptions", async () => {
  const engine = createWorkspaceEngine(createBlankWorkspace({ id: "eager-subscription" }));
  const store = new EagerDatasetStore(engine);
  const revisions = [];
  const unsubscribe = store.subscribe("home", (revision) => revisions.push(revision));

  await engine.dispatch(command("r1c1", "changed", 1));

  assert.deepEqual(revisions, ["1"]);
  unsubscribe();
});