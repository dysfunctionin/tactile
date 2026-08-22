import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

import { CASES, createContext } from "./cases.mjs";
import { formatRow, runCase } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);

function parseArgs(argv) {
  const args = { gate: false, only: null, out: "perf-dashboard/app/public/data/core.json", label: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--gate") args.gate = true;
    else if (argument === "--only")
      args.only = argv[++index]
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    else if (argument === "--out") args.out = argv[++index];
    else if (argument === "--label") args.label = argv[++index];
  }
  return args;
}

async function gitInfo() {
  try {
    const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT });
    const commit = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT });
    return { branch: branch.stdout.trim(), commit: commit.stdout.trim() };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

const args = parseArgs(process.argv.slice(2));
const startedAt = performance.now();

const fixtureStart = performance.now();
const context = createContext();
const fixtureMs = performance.now() - fixtureStart;
const rootCells = Object.keys(context.rootSheet.cells).length;
console.log(`core: fixture ready in ${fixtureMs.toFixed(0)}ms (${rootCells} root cells)`);
console.log("stat  case                              median         p95    budget");

const selected = args.only ? CASES.filter((entry) => args.only.includes(entry.name)) : CASES;
const results = [];
for (const descriptor of selected) {
  const result = await runCase(descriptor, context);
  results.push(result);
  console.log(formatRow(result));
}

const totalMs = performance.now() - startedAt;
const failures = results.filter((result) => result.status === "fail");
console.log(`core: ${results.length - failures.length}/${results.length} within budget in ${totalMs.toFixed(0)}ms`);

const document = {
  schemaVersion: 1,
  kind: "tactile-perf-core",
  label: args.label || "local",
  generatedAt: new Date().toISOString(),
  git: await gitInfo(),
  machine: {
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    cpuModel: os.cpus()[0]?.model || "unknown",
    cpuCount: os.cpus().length,
    nodeVersion: process.version,
  },
  fixture: { rootCells, buildMs: Math.round(fixtureMs) },
  totalMs: Math.round(totalMs),
  cases: results,
};

const outPath = path.resolve(ROOT, args.out);
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`core: wrote ${path.relative(ROOT, outPath)}`);

if (args.gate && failures.length) {
  console.error(`core: ${failures.length} case(s) over budget: ${failures.map((f) => f.name).join(", ")}`);
  process.exitCode = 1;
}
