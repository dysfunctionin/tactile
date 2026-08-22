import { spawn, execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { freeMemMB, machineSnapshot, prepareEnvironment, sampleProcessTree } from "./env-guard.mjs";
import { powershell } from "./powershell.mjs";
import {
  ensureNativeBinary,
  killNativeApp,
  launchNativeApp,
  sampleNativeProcesses,
} from "./native.mjs";
import { writeProfileFixture } from "./profiles.mjs";
import {
  addColumnsAction,
  addRowsAction,
  ensureBase,
  formulaAddAction,
  importFixture,
  inOutAction,
  measureLoadWarm,
  nestedAction,
  scrollDiagonalAction,
  scrollVerticalAction,
  typingBurstAction,
} from "./scenarios.mjs";
import {
  createMeasurementInitScript,
  percentile,
  summarizeInstrumentation,
} from "../../tests/performance/measurement.mjs";

const SUITE_SCHEMA_VERSION = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);

function parseArgs(argv) {
  const args = {
    profiles: ["low", "high"],
    repeats: 3,
    server: "auto",
    port: 4180,
    label: "",
    out: "perf-dashboard/app/public/data",
    build: false,
    headless: true,
    target: "browser",
    scenarios: null,
    cdpPort: 9223,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profiles") args.profiles = argv[++index].split(",").map((p) => p.trim()).filter(Boolean);
    else if (argument === "--repeats") args.repeats = Math.max(1, Number(argv[++index]));
    else if (argument === "--server") args.server = argv[++index];
    else if (argument === "--port") args.port = Number(argv[++index]);
    else if (argument === "--label") args.label = argv[++index];
    else if (argument === "--out") args.out = argv[++index];
    else if (argument === "--build") args.build = true;
    else if (argument === "--headed") args.headless = false;
    else if (argument === "--target") args.target = argv[++index];
    else if (argument === "--scenarios") args.scenarios = argv[++index].split(",").map((name) => name.trim()).filter(Boolean);
    else if (argument === "--cdp-port") args.cdpPort = Number(argv[++index]);
    else if (argument === "--help") args.help = true;
  }
  return args;
}

async function gitInfo() {
  try {
    const [branch] = await Promise.all([run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT })]);
    const commit = await run("git", ["rev-parse", "HEAD"], { cwd: ROOT });
    return { branch: branch.stdout.trim(), commit: commit.stdout.trim() };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function startServer(args, log) {
  const distIndex = path.join(ROOT, "dist", "client", "index.html");
  let mode = args.server;
  // `--build` implies preview: a dev server serves unbundled modules, which is
  // far too slow to import the high fixture and makes the numbers meaningless.
  if (mode === "auto") mode = (args.build || (await exists(distIndex))) ? "preview" : "dev";

  if (mode === "preview" && (!(await exists(distIndex)) || args.build)) {
    log("suite: building production bundle (npm run build)…");
    const build = spawn("npm.cmd", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: true });
    await new Promise((resolve, reject) => build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm run build exited ${code}`)))));
  }

  // Ensure target port is free (previous preview may still be holding it)
  try {
    await powershell(
      `Get-NetTCPConnection -LocalPort ${args.port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    );
    await new Promise((r) => setTimeout(r, 800));
  } catch {}

  const command = mode === "preview" ? "npx.cmd" : "npm.cmd";
  const serverArgs =
    mode === "preview"
      ? ["vite", "preview", "--host", "127.0.0.1", "--port", String(args.port), "--strictPort"]
      : ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(args.port), "--strictPort"];

  log(`suite: starting ${mode} server on port ${args.port}…`);
  const child = spawn(command, serverArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: true });
  child.stderr.on("data", (chunk) => log(`[server] ${String(chunk).trim()}`));
  const baseUrl = `http://127.0.0.1:${args.port}`;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return { child, baseUrl, mode };
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (child.exitCode != null) throw new Error(`Server exited early with code ${child.exitCode}`);
  }
  throw new Error("Server did not become ready within 90s.");
}

async function loadPlaywright() {
  for (const packageName of ["playwright", "@playwright/test"]) {
    try {
      const module = await import(packageName);
      if (module.chromium) return module;
    } catch {
      // try next
    }
  }
  throw new Error("Playwright is not installed; the suite cannot run.");
}

const SCENARIO_ORDER = [
  ["scroll-vertical", (page, profile) => scrollVerticalAction(page, profile)],
  ["scroll-diagonal", (page, _profile) => scrollDiagonalAction(page)],
  ["typing-burst", (page, profile) => typingBurstAction(page, profile)],
  ["formula-add", (page, profile) => formulaAddAction(page, profile)],
  ["in-out", (page, profile) => inOutAction(page, profile)],
  ["nested", (page, profile) => nestedAction(page, profile)],
  ["add-row", (page, profile) => addRowsAction(page, profile, 1)],
  ["add-column", (page, profile) => addColumnsAction(page, profile, 1)],
];

function selectedScenarios(args) {
  if (!args.scenarios?.length) return SCENARIO_ORDER;
  const wanted = new Set(args.scenarios);
  const unknown = args.scenarios.filter((name) => !SCENARIO_ORDER.some(([label]) => label === name));
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(", ")}`);
  return SCENARIO_ORDER.filter(([label]) => wanted.has(label));
}

async function measureScenario(page, sampleSystem, label, action, settleMs = 250) {
  const sysBefore = {
    freeMemMB: freeMemMB(),
    proc: await sampleSystem(),
  };
  const wallStart = Date.now();
  let perfStarted = false;
  try {
    await page.evaluate(async (scenarioLabel) => window.__tactilePerf?.start?.(scenarioLabel), label);
    perfStarted = true;
  } catch {
    perfStarted = false;
  }
  let actionError = null;
  let extras = null;
  try {
    extras = await action();
  } catch (error) {
    actionError = error?.message || String(error);
  }
  if (settleMs) {
    try {
      await page.waitForTimeout(settleMs);
    } catch {
      // page may have navigated; ignore
    }
  }
  let raw = null;
  if (perfStarted) {
    try {
      raw = await page.evaluate(() => window.__tactilePerf?.stop?.() ?? null);
    } catch {
      raw = null;
    }
  }
  const wallEnd = Date.now();
  const sysAfter = {
    freeMemMB: freeMemMB(),
    proc: await sampleSystem(),
  };
  const summary = summarizeInstrumentation(
    raw || { label, longTasksObservable: false, inputLatencyObservable: false, durationMs: wallEnd - wallStart },
  );
  if (!raw) {
    summary.durationMs = wallEnd - wallStart;
    summary.status = "unmeasurable";
    summary.reason = "Instrumentation was unavailable when the scenario stopped; wall-clock fallback used.";
  }
  if (actionError) summary.actionError = actionError;
  summary.system = {
    freeMemBeforeMB: sysBefore.freeMemMB,
    freeMemAfterMB: sysAfter.freeMemMB,
    appRssBeforeMB: sysBefore.proc?.rssMB ?? null,
    appRssAfterMB: sysAfter.proc?.rssMB ?? null,
    appCpuDeltaSec:
      sysBefore.proc && sysAfter.proc
        ? Math.round((sysAfter.proc.cpuSec - sysBefore.proc.cpuSec) * 100) / 100
        : null,
  };
  if (extras && Array.isArray(extras.ops)) {
    summary.opDurationsMs = extras.ops.map((op) => op.ms);
    summary.opMedianMs = percentile(extras.ops.map((op) => op.ms), 0.5);
  }
  return summary;
}

export function aggregateRepeats(repeats) {
  if (!repeats.length) return null;
  const pick = (fn) => fn(repeats.filter((r) => r && r.status !== "unmeasurable"));
  const metric = (path) =>
    pick((list) => {
      const values = list.map((r) => path.reduce((acc, key) => acc?.[key], r)).filter((v) => Number.isFinite(v));
      return values.length ? { median: percentile(values, 0.5), p95: percentile(values, 0.95), min: Math.min(...values), max: Math.max(...values) } : null;
    });
  return {
    repeats: repeats.length,
    usable: repeats.filter((r) => r.status !== "unmeasurable").length,
    durationMs: metric(["durationMs"]),
    frameTimeP95Ms: metric(["frameTimeMs", "p95"]),
    frameTimeMaxMs: metric(["frameTimeMs", "max"]),
    droppedFrames: metric(["frameTimeMs", "droppedFrameSamples"]),
    longTasksOver50: metric(["longTasks", "over50Ms"]),
    inputLatencyP95Ms: metric(["inputLatencyMs", "p95"]),
    stages: (() => {
      const names = [...new Set(repeats.flatMap((repeat) => Object.keys(repeat?.stages || {})))];
      if (!names.length) return null;
      return Object.fromEntries(names.map((name) => {
        const totals = repeats.map((repeat) => repeat?.stages?.[name]?.totalMs).filter(Number.isFinite);
        const maxes = repeats.map((repeat) => repeat?.stages?.[name]?.maxMs).filter(Number.isFinite);
        const counts = repeats.map((repeat) => repeat?.stages?.[name]?.count).filter(Number.isFinite);
        return [name, {
          calls: counts.length ? percentile(counts, 0.5) : null,
          totalMs: totals.length ? percentile(totals, 0.5) : null,
          maxMs: maxes.length ? Math.max(...maxes) : null,
        }];
      }));
    })(),
    reactCommits: metric(["react", "commitCount"]),
    domMutationBatches: metric(["domMutationBatches"]),
    mountedCellsMax: metric(["mounted", "cellsMax"]),
    memoryDeltaMB: (() => {
      const values = repeats
        .map((r) => r.memoryDeltaBytes)
        .filter((v) => Number.isFinite(v))
        .map((bytes) => Math.round((bytes / 1024 ** 2) * 10) / 10);
      return values.length ? { median: percentile(values, 0.5), max: Math.max(...values) } : null;
    })(),
    opMedianMs: (() => {
      const values = repeats.map((r) => r.opMedianMs).filter((v) => Number.isFinite(v));
      return values.length ? percentile(values, 0.5) : null;
    })(),
    systemFreeMemMinMB: Math.min(...repeats.map((r) => r.system?.freeMemAfterMB ?? Infinity)),
    appRssMaxMB: Math.max(...repeats.map((r) => r.system?.appRssAfterMB ?? 0)),
    actionErrors: repeats.flatMap((r) => (r.actionError ? [r.actionError] : [])),
  };
}

async function runBrowserPass(playwright, { baseUrl, profile, fixture, args, log }) {
  const browser = await playwright.chromium.launch({ headless: args.headless });
  const browserPid = typeof browser.process === "function" ? (browser.process()?.pid ?? null) : null;
  const sampleSystem = () => sampleProcessTree(browserPid);
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    await context.addInitScript({ content: createMeasurementInitScript() });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?perf=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 120_000 });

    const scenarios = {};
    scenarios["import-profile"] = await measureScenario(
      page,
      sampleSystem,
      "import-profile",
      () => importFixture(page, fixture.path, profile),
      500,
    );
    await page.evaluate(() => window.__tactilePerf?.markBaseline?.("post-import"));

    for (const [label, action] of selectedScenarios(args)) {
      await ensureBase(page, profile).catch(() => {});
      scenarios[label] = await measureScenario(page, sampleSystem, label, () => action(page, profile));
      log(`  ${profile}/${label}: ${scenarios[label].durationMs ?? "?"}ms`);
      for (const actionError of scenarios[label].actionError ? [scenarios[label].actionError] : []) {
        log(`  ${profile}/${label} ERROR: ${actionError}`);
      }
    }

    let loadWarm = null;
    if (args.scenarios?.length) {
      // An explicit scenario list is an iteration loop; load-warm costs a fixed
      // 120s timeout and would dominate it.
      log("  load-warm skipped (explicit --scenarios)");
    } else {
      try {
        loadWarm = await measureLoadWarm(page, baseUrl, profile);
      } catch (error) {
        log(`  ${profile}/load-warm failed: ${error.message}`);
        loadWarm = { wallClockMs: null, error: error.message, navigation: null };
      }
    }
    const teardown = await page.evaluate(() => window.__tactilePerf?.snapshot?.() ?? null);
    await context.close();
    return { scenarios, loadWarm, teardown };
  } finally {
    await browser.close();
  }
}

async function connectNative(playwright, cdpUrl) {
  const browser = await playwright.chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  return { browser, context, page };
}

async function seedNativeFixture(page, fixture, profile) {
  const workspace = { ...fixture.workspace, updatedAt: new Date().toISOString() };
  const json = JSON.stringify(workspace);
  await page.evaluate((workspaceJson) => {
    try {
      localStorage.setItem("tactile.workspace.v3", workspaceJson);
      localStorage.removeItem("tactile.native.workspace.path");
    } catch {}
  }, json);
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
  } catch {
    await page.waitForTimeout(1500);
  }
  const rootId = profile === "high" ? "perf-root-sheet" : "low-root-sheet";
  await page
    .locator(`[data-object-id="${rootId}"][data-cell-address="A1"]`)
    .waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForTimeout(400);
}

async function runNativePass(playwright, { profile, fixture, args, log }) {
  const sampleSystem = () => sampleNativeProcesses();
  const launch1 = await launchNativeApp({ cdpPort: args.cdpPort, log });
  let scenarios = {};
  let teardown = null;
  try {
    const { browser, page } = await connectNative(playwright, launch1.cdpUrl);
    await page.waitForTimeout(1000);

    scenarios["import-profile"] = await measureScenario(
      page,
      sampleSystem,
      "import-profile",
      () => seedNativeFixture(page, fixture, profile),
      500,
    );
    await page.evaluate(() => window.__tactilePerf?.markBaseline?.("post-import"));

    for (const [label, action] of selectedScenarios(args)) {
      await ensureBase(page, profile).catch(() => {});
      scenarios[label] = await measureScenario(page, sampleSystem, label, () => action(page, profile));
      log(`  ${profile}/${label}: ${scenarios[label].durationMs ?? "?"}ms`);
    }

    teardown = await page.evaluate(() => window.__tactilePerf?.snapshot?.() ?? null);
    await browser.close().catch(() => {});
  } finally {
    await killNativeApp();
  }

  // Warm-cache launch: the import above persisted state into WebView2 storage.
  const warmLaunch = await launchNativeApp({ cdpPort: args.cdpPort, log });
  try {
    const { browser, page } = await connectNative(playwright, warmLaunch.cdpUrl);
    const rootId = profile === "high" ? "perf-root-sheet" : "low-root-sheet";
    await page
      .locator(`[data-object-id="${rootId}"][data-cell-address="A1"]`)
      .waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(350);
    const loadWarm = {
      wallClockMs: Date.now() - warmLaunch.startedAt,
      navigation: null,
      note: "native process start → first sheet cell visible",
    };
    await browser.close().catch(() => {});
    return { scenarios, loadWarm, teardown };
  } finally {
    await killNativeApp();
  }
}

async function runProfilePass(playwright, options) {
  if (options.args.target === "native") return runNativePass(playwright, options);
  return runBrowserPass(playwright, options);
}

function summarizeProfile(passes, fingerprint, validation) {
  const scenarioNames = [...Object.keys(passes[0].scenarios)];
  const scenarios = Object.fromEntries(
    scenarioNames.map((name) => [
      name,
      aggregateRepeats(passes.map((pass) => pass.scenarios[name])),
    ]),
  );
  const loadWarmRuns = passes.map((pass) => pass.loadWarm?.wallClockMs).filter(Number.isFinite);
  return {
    fixtureFingerprint: fingerprint,
    counts: validation.counts ?? validation.checks,
    loadWarmMs: loadWarmRuns.length
      ? { median: percentile(loadWarmRuns, 0.5), min: Math.min(...loadWarmRuns), max: Math.max(...loadWarmRuns) }
      : null,
    scenarios,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node benchmarks/suite/run-suite.mjs [--profiles low,high] [--repeats 3] [--target browser|native] [--server auto|preview|dev] [--port 4174] [--cdp-port 9223] [--label <text>] [--out perf-dashboard/app/public/data] [--build] [--headed]",
    );
    return;
  }
  const log = (...line) => console.log(...line);
  const startedAt = Date.now();
  const git = await gitInfo();
  let appVersion = "unknown";
  try {
    appVersion = JSON.parse(await readFile(path.join(ROOT, "version.json"), "utf8")).version ?? appVersion;
  } catch {
    // keep unknown
  }

  log("suite: preparing environment…");
  const envGuard = await prepareEnvironment({ log });

  const fixtures = {};
  for (const profile of args.profiles) {
    const outputDir = path.join(ROOT, "benchmarks", ".generated", profile === "high" ? "tactile-250k-suite" : "tactile-low-suite");
    log(`suite: generating ${profile}-stress fixture…`);
    fixtures[profile] = await writeProfileFixture(profile, outputDir);
    log(`  ${profile}: fingerprint ${fixtures[profile].fingerprint.slice(0, 12)}… counts ${JSON.stringify(fixtures[profile].validation.counts ?? {})}`);
  }

  let server = null;
  if (args.target === "native") {
    log("suite: target=native — ensuring release binary…");
    await ensureNativeBinary({ rebuild: args.build, log });
  } else {
    server = await startServer(args, log);
    log(`suite: server ${server.mode} at ${server.baseUrl};`);
  }
  const playwright = await loadPlaywright();
  log(`running ${args.repeats} repeat(s) per profile on target=${args.target}.`);

  const profiles = {};
  try {
    for (const profile of args.profiles) {
      const passes = [];
      for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
        log(`suite: ${profile} pass ${repeat}/${args.repeats}`);
        passes.push(
          await runProfilePass(playwright, {
            baseUrl: server?.baseUrl,
            profile,
            fixture: fixtures[profile],
            args,
            log,
          }),
        );
      }
      profiles[profile] = summarizeProfile(passes, fixtures[profile].fingerprint, fixtures[profile].validation);
    }
  } finally {
    if (server) server.child.kill("SIGTERM");
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}${args.label ? `-${args.label.replace(/\s+/g, "_")}` : ""}`;
  const document_ = {
    schemaVersion: SUITE_SCHEMA_VERSION,
    kind: "tactile-perf-suite",
    runId,
    label: args.label || "",
    generatedAt: new Date().toISOString(),
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    appVersion,
    git,
    machine: machineSnapshot(),
    envGuard,
    server: args.target === "native" ? { mode: "native", cdpPort: args.cdpPort } : { mode: server.mode, port: args.port },
    target: args.target,
    repeats: args.repeats,
    profiles,
  };

  const runsDir = path.join(ROOT, args.out, "runs");
  await mkdir(runsDir, { recursive: true });
  const runFile = path.join(runsDir, `${runId}.json`);
  await writeFile(runFile, `${JSON.stringify(document_, null, 2)}\n`, "utf8");

  const manifestPath = path.join(ROOT, args.out, "runs.json");
  let manifest = { schemaVersion: SUITE_SCHEMA_VERSION, latestRunId: runId, runs: [] };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    // fresh manifest
  }
  manifest.latestRunId = runId;
  manifest.runs = [
    ...(manifest.runs || []),
    {
      runId,
      label: document_.label,
      generatedAt: document_.generatedAt,
      appVersion,
      gitCommit: git.commit.slice(0, 9),
      profiles: args.profiles,
      file: path.relative(path.dirname(manifestPath), runFile).replaceAll("\\", "/"),
    },
  ].slice(-50);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const archiveDir = path.join(ROOT, "benchmarks", ".generated", "suite-runs");
  await mkdir(archiveDir, { recursive: true });
  await writeFile(path.join(archiveDir, `${runId}.json`), `${JSON.stringify(document_, null, 2)}\n`, "utf8");

  log(`suite: complete in ${document_.elapsedSec}s → ${path.relative(ROOT, runFile)}`);
  for (const [profile, summary] of Object.entries(profiles)) {
    log(`\n== ${profile} ==  load-warm median ${summary.loadWarmMs?.median ?? "?"}ms`);
    for (const [name, agg] of Object.entries(summary.scenarios)) {
      log(
        `  ${name.padEnd(15)} dur ${agg.durationMs?.median ?? "?"}ms | frame p95 ${agg.frameTimeP95Ms?.median ?? "?"}ms | input p95 ${agg.inputLatencyP95Ms?.median ?? "?"}ms`,
      );
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { main };
