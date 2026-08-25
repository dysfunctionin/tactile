import assert from "node:assert/strict";

import { createBlankWorkspace, createCellRecord, normalizeWorkspace } from "../../../src/core/workspace/model.js";
import { commandsForWorkspaceTransition, createWave2Shadow } from "../../../src/core/engine/shadow.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "core" });

function workspaceWithCell(workspace, cellId, patch) {
  const next = normalizeWorkspace(workspace);
  const sheet = next.objects.home;
  sheet.cells[cellId] = createCellRecord(0, 0, patch);
  return next;
}

function fakePersistence() {
  const calls = [];
  return {
    calls,
    async open(request) {
      calls.push({ type: "open", request });
    },
    async writeSnapshot(snapshot, options) {
      calls.push({ type: "snapshot", snapshot, options });
    },
    async commit(transaction) {
      calls.push({ type: "commit", transaction });
      return { revision: transaction.revision };
    },
    async close() {
      calls.push({ type: "close" });
    },
  };
}

scenario("shadow transition maps a cell edit to one normalized transaction and patch commit", async () => {
  const initial = createBlankWorkspace({ id: "workspace-wave2-shadow" });
  const next = workspaceWithCell(initial, "A1", { value: "42" });
  const transition = commandsForWorkspaceTransition(initial, next);

  assert.equal(transition.unsupported, false);
  assert.equal(transition.commands.length, 1);
  assert.equal(transition.commands[0].type, "set-cell");
  assert.equal(transition.commands[0].cellId, "A1");

  const persistence = fakePersistence();
  const shadow = createWave2Shadow(initial, { persistence });
  await shadow.reconcile(next);

  assert.equal(shadow.state.transactions, 1);
  assert.equal(shadow.state.differential.equal, true);
  assert.equal(persistence.calls.filter((call) => call.type === "commit").length, 1);
  assert.equal(
    persistence.calls
      .find((call) => call.type === "commit")
      .transaction.transaction.forwardPatch.operations.some(
        (operation) => operation.kind === "replace-cell" && operation.cellId === "r1c1",
      ),
    true,
  );
  shadow.dispose();
});

scenario("the normalized transaction engine is the only runtime mode", () => {
  const initial = createBlankWorkspace({ id: "workspace-wave3-default" });
  const defaultEngine = createWave2Shadow(initial, { persistence: fakePersistence() });

  assert.equal(defaultEngine.state.engine, "transaction");
  assert.equal(defaultEngine.state.mode, "default");

  defaultEngine.dispose();
});

scenario("browser-style shadow startup restores persistence without writing the render seed", async () => {
  const seed = createBlankWorkspace({ id: "workspace-render-seed" });
  const persisted = createBlankWorkspace({ id: "workspace-persisted-session" });
  const persistence = fakePersistence();
  persistence.open = async (request) => {
    persistence.calls.push({ type: "open", request });
    return request === undefined ? persisted : null;
  };

  const shadow = createWave2Shadow(seed, { persistence });
  const resolved = await shadow.ready;

  assert.equal(resolved.id, persisted.id);
  assert.deepEqual(persistence.calls, [{ type: "open", request: undefined }]);
  shadow.dispose();
});

scenario("initial-snapshot shadow startup keeps native-style snapshots authoritative", async () => {
  const initial = createBlankWorkspace({ id: "workspace-native-seed" });
  const persistence = fakePersistence();

  const shadow = createWave2Shadow(initial, { persistence, useInitialSnapshot: true });
  const resolved = await shadow.ready;

  assert.equal(resolved.id, initial.id);
  assert.equal(persistence.calls[0].type, "open");
  assert.deepEqual(persistence.calls[0].request, { workspaceId: initial.id });
  assert.equal(persistence.calls[1].type, "snapshot");
  assert.equal(persistence.calls[1].snapshot.id, initial.id);
  assert.equal(persistence.calls[1].options.activate, true);
  shadow.dispose();
});

scenario("whole-workspace replacement is durable before it resolves", async () => {
  const initial = createBlankWorkspace({ id: "workspace-before-import" });
  const imported = createBlankWorkspace({ id: "workspace-after-import" });
  const persistence = fakePersistence();
  const shadow = createWave2Shadow(initial, { persistence, useInitialSnapshot: true });
  await shadow.ready;

  const resolved = await shadow.replaceSnapshot(imported);

  assert.equal(resolved.id, imported.id);
  const snapshots = persistence.calls.filter((call) => call.type === "snapshot");
  assert.equal(snapshots.at(-1).snapshot.id, imported.id);
  assert.equal(snapshots.at(-1).options.activate, true);
  shadow.dispose();
});

scenario("shadow transition batches a rectangular edit and leaves unrelated objects out of the command", () => {
  const initial = createBlankWorkspace({ id: "workspace-wave2-batch" });
  const next = workspaceWithCell(initial, "A1", { value: "A" });
  next.objects.home.cells.B1 = createCellRecord(0, 1, { value: "B" });
  const transition = commandsForWorkspaceTransition(initial, next);

  assert.equal(transition.commands.length, 1);
  assert.equal(transition.commands[0].type, "set-range");
  assert.deepEqual(transition.commands[0].changes.map((change) => change.cellId).sort(), ["A1", "B1"]);
  assert.deepEqual([...transition.changedSheets.keys()], ["home"]);
});

scenario("large legacy transitions reset the shadow snapshot instead of committing per-cell patches", async () => {
  const initial = createBlankWorkspace({ id: "workspace-wave2-large-reset" });
  const next = normalizeWorkspace(initial);
  for (let index = 0; index <= 20_000; index += 1) {
    const row = Math.floor(index / 200);
    const column = index % 200;
    const cell = createCellRecord(row, column, { value: String(index) });
    next.objects.home.cells[cell.id] = cell;
  }
  const persistence = fakePersistence();
  const shadow = createWave2Shadow(initial, { persistence, useInitialSnapshot: true });
  await shadow.ready;

  await shadow.reconcile(next, { normalized: true });

  assert.equal(persistence.calls.filter((call) => call.type === "commit").length, 0);
  const persisted = persistence.calls.filter((call) => call.type === "snapshot").at(-1).snapshot;
  assert.equal(persisted.id, next.id);
  assert.equal(Object.keys(persisted.objects.home.cells).length, 20_001);
  shadow.dispose();
});
