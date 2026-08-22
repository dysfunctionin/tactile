// Samples the JS CPU profile for a single scenario action so the remaining
// unattributed commit cost can be read off real call stacks instead of guessed.
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { writeProfileFixture } from "./profiles.mjs";
import {
  addColumnsAction,
  addRowsAction,
  ensureBase,
  formulaAddAction,
  importFixture,
  inOutAction,
  nestedAction,
  scrollDiagonalAction,
  scrollVerticalAction,
  typingBurstAction,
} from "./scenarios.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ACTIONS = {
  "add-row": (page, profile) => addRowsAction(page, profile, 1),
  "add-column": (page, profile) => addColumnsAction(page, profile, 1),
  "typing-burst": (page, profile) => typingBurstAction(page, profile),
  "formula-add": (page, profile) => formulaAddAction(page, profile),
  "in-out": (page, profile) => inOutAction(page, profile),
  nested: (page, profile) => nestedAction(page, profile),
  "scroll-vertical": (page, profile) => scrollVerticalAction(page, profile),
  "scroll-diagonal": (page) => scrollDiagonalAction(page),
};

function parseArgs(argv) {
  const args = { scenario: "add-row", profile: "high", port: 4186, top: 25 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--scenario") args.scenario = argv[++index];
    else if (argv[index] === "--profile") args.profile = argv[++index];
    else if (argv[index] === "--port") args.port = Number(argv[++index]);
    else if (argv[index] === "--top") args.top = Number(argv[++index]);
  }
  return args;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function startPreview(port) {
  if (!(await exists(path.join(ROOT, "dist", "client", "index.html")))) {
    throw new Error("dist/client/index.html is missing; run `npm run build` first.");
  }
  const child = spawn("npx.cmd", ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(baseUrl)).ok) return { child, baseUrl };
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Preview server did not start.");
}

function aggregate(profile) {
  const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentById = new Map();
  for (const node of profile.nodes) {
    for (const childId of node.children || []) parentById.set(childId, node.id);
  }
  const selfTimeById = new Map();
  const { samples = [], timeDeltas = [] } = profile;
  for (let index = 0; index < samples.length; index += 1) {
    const id = samples[index];
    selfTimeById.set(id, (selfTimeById.get(id) || 0) + (timeDeltas[index] || 0));
  }
  const describe = (id) => {
    const frame = nodesById.get(id)?.callFrame;
    if (!frame) return "(unknown)";
    const file =
      String(frame.url || "")
        .split("/")
        .slice(-1)[0] || "(native)";
    return `${frame.functionName || "(anonymous)"} @ ${file}:${frame.lineNumber + 1}`;
  };
  const ancestry = (id, depth = 6) => {
    const chain = [];
    let current = parentById.get(id);
    while (current != null && chain.length < depth) {
      chain.push(describe(current));
      current = parentById.get(current);
    }
    return chain;
  };
  const byFunction = new Map();
  for (const [id, micros] of selfTimeById) {
    const key = describe(id);
    const entry = byFunction.get(key) || { ms: 0, nodeIds: [] };
    entry.ms += micros / 1000;
    entry.nodeIds.push(id);
    byFunction.set(key, entry);
  }
  return [...byFunction.entries()]
    .map(([name, entry]) => ({ name, ms: entry.ms, callers: ancestry(entry.nodeIds[0]) }))
    .sort((left, right) => right.ms - left.ms);
}

const args = parseArgs(process.argv.slice(2));
const action = ACTIONS[args.scenario];
if (!action) throw new Error(`Unknown scenario ${args.scenario}. Known: ${Object.keys(ACTIONS).join(", ")}`);

const fixture = await writeProfileFixture(args.profile, path.join(ROOT, "benchmarks/.generated/profile-fixture"));
const server = await startPreview(args.port);
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/?profile=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  console.log(`profiling ${args.scenario} on ${args.profile}: importing fixture…`);
  await importFixture(page, fixture.path, args.profile);
  await ensureBase(page, args.profile);

  const session = await context.newCDPSession(page);
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 200 });
  await session.send("Profiler.start");
  const started = Date.now();
  await action(page, args.profile);
  const elapsed = Date.now() - started;
  const { profile } = await session.send("Profiler.stop");

  const rows = aggregate(profile);
  const total = rows.reduce((sum, row) => sum + row.ms, 0);
  const storage = await page
    .evaluate(() => {
      const report = {};
      for (const key of Object.keys(window.localStorage)) {
        report[key] = window.localStorage.getItem(key)?.length ?? 0;
      }
      return report;
    })
    .catch(() => ({}));
  console.log(`\n${args.scenario}: ${elapsed}ms wall, ${Math.round(total)}ms sampled`);
  console.log(`localStorage: ${JSON.stringify(storage)}\n`);
  console.log("  self ms   share  function");
  for (const row of rows.slice(0, args.top)) {
    console.log(`  ${row.ms.toFixed(1).padStart(8)}  ${((row.ms / total) * 100).toFixed(1).padStart(5)}%  ${row.name}`);
    if (row.ms >= 40 && row.callers.length) console.log(`             via ${row.callers.join(" < ")}`);
  }
} finally {
  await browser.close();
  server.child.kill();
}
