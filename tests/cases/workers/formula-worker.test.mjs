import assert from "node:assert/strict";

import {
  FormulaEngine,
  clearFormulaCaches,
  formatFormulaResult,
  getCachedNumberFormatter,
  getFormulaCacheStats,
} from "../../../src/core/sheet/formulas.js";
import { FormulaWorkerClient } from "../../../src/core/workers/formula/client.js";
import { FormulaWorkerRuntime } from "../../../src/core/workers/formula/runtime.js";
import { FORMULA_WORKER_PROTOCOL } from "../../../src/core/workers/formula/protocol.js";
import { defineSuite } from "../../harness/index.mjs";
import { largeSheet } from "../../scenarios/large-sheet.mjs";

const scenario = defineSuite({ type: "unit", suite: "workers" });

function smallSheet() {
  return {
    id: "formula-worker-test",
    type: "sheet",
    rows: 16,
    columns: 16,
    cells: {
      r1c1: { id: "r1c1", address: "A1", row: 0, column: 0, value: "10", formula: "", embed: null },
      r1c2: { id: "r1c2", address: "B1", row: 0, column: 1, value: "", formula: "=A1+1", embed: null },
      r1c3: { id: "r1c3", address: "C1", row: 0, column: 2, value: "", formula: "=B1+1", embed: null },
      r1c5: { id: "r1c5", address: "E1", row: 0, column: 4, value: "", formula: "=D1+1", embed: null },
    },
  };
}

scenario("formula engine caches ASTs and number formatters", () => {
  clearFormulaCaches();
  const sheet = smallSheet();
  const first = new FormulaEngine(sheet);
  const second = new FormulaEngine(sheet);

  assert.equal(first.getFormulaValues().get("C1"), 12);
  assert.equal(second.getFormulaValues().get("C1"), 12);
  assert.equal(formatFormulaResult(1234.5), "1,234.5");
  assert.strictEqual(
    getCachedNumberFormatter(undefined, { maximumFractionDigits: 10 }),
    getCachedNumberFormatter(undefined, { maximumFractionDigits: 10 }),
  );
  const cacheStats = getFormulaCacheStats();
  assert.equal(cacheStats.astCount, 3);
  assert.equal(cacheStats.formatterCount, 1);
});

scenario("independent edits recalculate only transitive formula dependents", () => {
  const engine = new FormulaEngine(smallSheet());

  assert.deepEqual([...engine.getDependencies("C1")].sort(), ["B1"]);
  assert.deepEqual([...engine.getDependents("A1")].sort(), ["B1"]);

  const independent = engine.updateCell("F1", { value: "unrelated", formula: "" });
  assert.deepEqual(independent.evaluatedAddresses, []);

  const dependent = engine.updateCell("A1", { value: "20", formula: "" });
  assert.deepEqual(new Set(dependent.evaluatedAddresses), new Set(["B1", "C1"]));
  assert.equal(engine.getFormulaValues().get("C1"), 22);
  assert.equal(engine.getFormulaValues().has("E1"), true);
  assert.equal(engine.getFormulaValues().get("E1"), 1);
});

scenario("formula worker protocol returns revisioned deltas and rejects stale requests", () => {
  const responses = [];
  const runtime = new FormulaWorkerRuntime({ postMessage: (response) => responses.push(response) });
  const sheet = smallSheet();

  const initialized = runtime.handleMessage({
    protocol: FORMULA_WORKER_PROTOCOL,
    type: "init",
    requestId: "init",
    revision: 0,
    sheet,
  });
  assert.equal(initialized.type, "result");
  assert.equal(initialized.values.C1, 12);

  const updated = runtime.handleMessage({
    protocol: FORMULA_WORKER_PROTOCOL,
    type: "update",
    requestId: "update",
    revision: 1,
    changes: [{ address: "A1", patch: { value: "20", formula: "" } }],
  });
  assert.equal(updated.type, "result");
  assert.equal(updated.values.C1, 22);
  assert.deepEqual(new Set(updated.evaluatedAddresses), new Set(["B1", "C1"]));

  const stale = runtime.handleMessage({
    protocol: FORMULA_WORKER_PROTOCOL,
    type: "update",
    requestId: "stale",
    revision: 0,
    changes: [{ address: "A1", patch: { value: "30", formula: "" } }],
  });
  assert.equal(stale.type, "stale");
  assert.equal(responses.at(-1).requestId, "stale");
});

scenario("worker client rejects an out-of-order result without applying it", async () => {
  const listeners = new Set();
  const worker = {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    postMessage() {},
  };
  const client = new FormulaWorkerClient(worker);
  const oldRequest = client.update([{ address: "A1", patch: { value: "20" } }]);
  const newRequest = client.update([{ address: "A1", patch: { value: "21" } }]);

  for (const listener of listeners) {
    listener({
      data: {
        protocol: FORMULA_WORKER_PROTOCOL,
        type: "result",
        requestId: "client-1",
        revision: 0,
        values: {},
      },
    });
    listener({
      data: {
        protocol: FORMULA_WORKER_PROTOCOL,
        type: "result",
        requestId: "client-2",
        revision: 1,
        values: {},
      },
    });
  }

  await assert.rejects(oldRequest, (error) => error.code === "STALE_RESULT");
  await assert.doesNotReject(newRequest);
  client.dispose();
});

scenario(
  "large sheet keeps a dependent edit bounded and an unreferenced edit inert",
  { setup: largeSheet, timeoutMs: 120_000 },
  ({ rootSheet, spec, boundedEditAddress, isolatedEditAddress }) => {
    const engine = new FormulaEngine(rootSheet);

    const dependent = engine.updateCell(boundedEditAddress, { value: "2000", formula: "" });
    assert.equal(engine.getStats().formulaCount, spec.formulaCount);
    assert.ok(dependent.evaluatedAddresses.length > 0);
    assert.ok(dependent.evaluatedAddresses.length < spec.formulaCount / 10);

    const unreferenced = engine.updateCell(isolatedEditAddress, { value: "unrelated", formula: "" });
    assert.deepEqual(unreferenced.evaluatedAddresses, []);
  },
);
