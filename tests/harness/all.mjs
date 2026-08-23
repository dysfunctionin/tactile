import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { clearShards } from "./report.mjs";

const TEST_SCRIPTS = ["test:unit", "test:platform", "test:performance", "test:e2e", "test:sites"];
const EXPECTED_TYPES = ["unit", "compatibility", "platform", "performance", "e2e", "sites"];
const dryRun = process.argv.includes("--dry-run");
const npmCli = process.env.npm_execpath;

if (!npmCli && !dryRun) {
  console.error("test:all must be started through npm");
  process.exit(2);
}

const runId = process.env.TACTILE_TEST_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const env = { ...process.env, TACTILE_TEST_RUN_ID: runId };

async function runScript(script) {
  if (dryRun) {
    console.log(`test:all ${runId} -> ${script}`);
    return 0;
  }

  const child = spawn(process.execPath, [npmCli, "run", script], {
    stdio: "inherit",
    env,
  });

  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
  });
}

if (!dryRun) await clearShards();

for (const script of TEST_SCRIPTS) {
  console.log(`\n=== ${script} ===`);
  await runScript(script);
}

if (dryRun) {
  console.log(`\ntest:all dry run completed: ${runId}`);
  process.exit(0);
}

const summary = JSON.parse(await readFile("test-results/summary.json", "utf8"));
const missingTypes = EXPECTED_TYPES.filter((type) => !summary.byType[type]);
if (missingTypes.length) {
  console.error(`\ntest:all did not record: ${missingTypes.join(", ")}`);
  process.exit(1);
}

console.log(
  `\ntest:all completed: ${summary.totals.pass}/${summary.totals.total} passed, ` +
    `${summary.totals.fail} failed, ${summary.totals.timeout} timed out`,
);
process.exit(summary.totals.fail > 0 || summary.totals.timeout > 0 ? 1 : 0);
