import assert from "node:assert/strict";

import { prepareBrowserSource } from "../../../marketplace/plugins/code/execution.js";
import { defineSuite } from "../../harness/index.mjs";

const scenario = defineSuite({ type: "unit", suite: "objects" });

scenario("browser execution leaves JavaScript unchanged", () => {
  const source = "const answer = 42; console.log(answer);";
  assert.equal(prepareBrowserSource(source, "javascript"), source);
});

scenario("browser execution removes TypeScript syntax before running", () => {
  const output = prepareBrowserSource("const answer: number = 42; console.log(answer);", "typescript");
  assert.doesNotMatch(output, /: number/);
  assert.match(output, /const answer = 42/);
});

scenario("browser execution reports invalid TypeScript during transformation", () => {
  assert.throws(() => prepareBrowserSource("const value: = 1;", "typescript"));
});
