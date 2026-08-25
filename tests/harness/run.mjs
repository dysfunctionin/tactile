import { spawn } from "node:child_process";
import process from "node:process";
import { randomUUID } from "node:crypto";

import { clearShards, printSummary, writeReport } from "./report.mjs";

/**
 * Runs a test command, then merges every process shard into one report.
 * The runner's exit code wins so a failing suite still fails the gate.
 *
 * A run id inherited from the environment means several suites are aggregating
 * into one report; otherwise this is a fresh run and old shards are discarded.
 */
const argv = process.argv.slice(2);
const typesFlag = argv[0] === "--types" ? argv[1] : null;
const [command, ...args] = typesFlag ? argv.slice(2) : argv;
if (!command) {
  console.error("usage: node tests/harness/run.mjs [--types a,b] <command> [args...]");
  process.exit(2);
}

const inheritedRunId = process.env.TACTILE_TEST_RUN_ID;
const runId = inheritedRunId || new Date().toISOString().replace(/[:.]/g, "-");
// The reporter runs in this process, so it needs the id too.
process.env.TACTILE_TEST_RUN_ID = runId;
if (!inheritedRunId) await clearShards();

// Only shell out for launcher scripts (npx, playwright); spawning node
// directly avoids shell argument concatenation.
const isNode = command === "node";
const child = spawn(isNode ? process.execPath : command, args, {
  stdio: "inherit",
  shell: !isNode && process.platform === "win32",
  env: {
    ...process.env,
    TACTILE_TEST_RUN_ID: runId,
    TACTILE_RUN_UUID: randomUUID(),
    ...(typesFlag ? { TACTILE_TEST_TYPES: typesFlag } : {}),
  },
});

const runnerExit = await new Promise((resolve) => {
  child.on("close", (code) => resolve(code ?? 1));
  child.on("error", (error) => {
    console.error(error);
    resolve(1);
  });
});

const summary = await writeReport();
printSummary(summary);

const gateFailed = summary.totals.fail > 0 || summary.totals.timeout > 0;
process.exit(runnerExit !== 0 ? runnerExit : gateFailed ? 1 : 0);
