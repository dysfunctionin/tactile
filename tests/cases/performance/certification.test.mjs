import assert from "node:assert/strict";

import { evaluatePerformanceCertification, RELEASE_BUDGETS } from "../../harness/measurement.mjs";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "performance", suite: "certification" });

function cleanLeakChecks() {
  return {
    runtime: { observable: true, clean: true, leakedResources: [] },
    memory: { observable: true, startBytes: 100, endBytes: 100, deltaBytes: 0 },
  };
}

function measuredResult(overrides = {}) {
  const measuredScenario = (input = true) => ({
    frameTimeMs: { p95: RELEASE_BUDGETS.frameTimeP95Ms },
    longTasks: { over50Ms: 0 },
    inputLatencyMs: { p95: input ? RELEASE_BUDGETS.inputToPaintP95Ms : null },
    leakChecks: cleanLeakChecks(),
  });
  return {
    status: "measured",
    fixture: { valid: true },
    bundle: {
      javascript: { gzipBytes: RELEASE_BUDGETS.initialJavascriptGzipBytes },
      css: { gzipBytes: RELEASE_BUDGETS.cssGzipBytes },
    },
    scenarios: {
      scroll: measuredScenario(false),
      typing: measuredScenario(),
      "in-out": measuredScenario(),
      nested: measuredScenario(),
    },
    teardown: { leakChecks: cleanLeakChecks() },
    ...overrides,
  };
}

scenario("release certification passes at the exact published budgets", () => {
  const certification = evaluatePerformanceCertification(measuredResult());
  assert.equal(certification.status, "pass");
  assert.equal(certification.passed, true);
  assert.deepEqual(certification.failedChecks, []);
  assert.deepEqual(certification.blockers, []);
});

scenario("release certification fails rather than relaxing an exceeded bundle budget", () => {
  const result = measuredResult({
    bundle: {
      javascript: { gzipBytes: RELEASE_BUDGETS.initialJavascriptGzipBytes + 1 },
      css: { gzipBytes: RELEASE_BUDGETS.cssGzipBytes },
    },
  });
  const certification = evaluatePerformanceCertification(result);
  assert.equal(certification.status, "fail");
  assert.equal(
    certification.failedChecks.some((check) => check.name === "bundle.javascript.gzipBytes"),
    true,
  );
});

scenario("release certification fails on a positive runtime resource delta", () => {
  const result = measuredResult({
    scenarios: {
      ...measuredResult().scenarios,
      "in-out": {
        ...measuredResult().scenarios["in-out"],
        leakChecks: {
          runtime: {
            observable: true,
            clean: false,
            leakedResources: [{ resource: "listeners", delta: 1 }],
          },
          memory: { observable: true, startBytes: 100, endBytes: 100, deltaBytes: 0 },
        },
      },
    },
  });
  const certification = evaluatePerformanceCertification(result);
  assert.equal(certification.status, "fail");
  assert.equal(
    certification.failedChecks.some((check) => check.name === "in-out.runtimeLeaks"),
    true,
  );
});

scenario("release certification blocks when final memory is unobservable", () => {
  const result = measuredResult({
    teardown: {
      leakChecks: {
        runtime: { observable: true, clean: true, leakedResources: [] },
        memory: { observable: false, startBytes: null, endBytes: null, deltaBytes: null },
      },
    },
  });
  const certification = evaluatePerformanceCertification(result);
  assert.equal(certification.status, "blocked");
  assert.equal(
    certification.blockers.includes("Final memory measurement was unavailable; leak certification is blocked."),
    true,
  );
});
