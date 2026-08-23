import { spawn } from "node:child_process";
import process from "node:process";
import { randomUUID } from "node:crypto";

import { clearShards, printSummary, writeReport } from "./report.mjs";

/**
 * Runs a test command, then merges every process shard into one report.
 * The runner's exit code wins so a failing suite still fails the gate.
 *
 * Pass --append to add to the current report instead of starting a new run,
 * so several suites can aggregate into a single result set.
 */
const argv = process.argv.slice(2);
const append = argv[0] === "--append";
const rest = append ? argv.slice(1) : argv;
const typesFlag = rest[0] === "--types" ? rest[1] : null;
const [command, ...args] = typesFlag ? rest.slice(2) : rest;
if (!command) {
  console.error("usage: node tests/harness/run.mjs [--append] [--types a,b] <command> [args...]");
  process.exit(2);
}

const runId = process.env.TACTILE_TEST_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
if (!append) await clearShards();

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
