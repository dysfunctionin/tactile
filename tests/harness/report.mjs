import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DEFAULT_TIMEOUT_RATIO_LIMIT, HISTORY_LIMIT, SCHEMA_VERSION, STATUS, roundMs } from "./schema.mjs";
import { RESULTS_DIR, SHARD_DIR, currentRunId } from "./writer.mjs";

const run = promisify(execFile);

async function gitInfo() {
  try {
    const [branch, commit] = await Promise.all([
      run("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
      run("git", ["rev-parse", "--short", "HEAD"]),
    ]);
    return { branch: branch.stdout.trim(), commit: commit.stdout.trim() };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

export async function collectRecords() {
  let entries = [];
  try {
    entries = await readdir(SHARD_DIR);
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith(".ndjson")) continue;
    const raw = await readFile(path.join(SHARD_DIR, entry), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        /* a torn shard line must not lose the rest of the run */
      }
    }
  }
  records.sort((a, b) => String(a.file).localeCompare(String(b.file)) || a.scenario.localeCompare(b.scenario));
  return records;
}

function tally(records) {
  const totals = { total: records.length, pass: 0, fail: 0, timeout: 0, skipped: 0 };
  for (const record of records) {
    if (record.status === STATUS.PASS) totals.pass += 1;
    else if (record.status === STATUS.TIMEOUT) totals.timeout += 1;
    else if (record.status === STATUS.SKIPPED) totals.skipped += 1;
    else totals.fail += 1;
  }
  return totals;
}

function groupByType(records) {
  const byType = {};
  for (const record of records) {
    const bucket = (byType[record.type] ??= { total: 0, pass: 0, fail: 0, timeout: 0, skipped: 0, durationMs: 0 });
    bucket.total += 1;
    if (record.status === STATUS.PASS) bucket.pass += 1;
    else if (record.status === STATUS.TIMEOUT) bucket.timeout += 1;
    else if (record.status === STATUS.SKIPPED) bucket.skipped += 1;
    else bucket.fail += 1;
    bucket.durationMs = roundMs(bucket.durationMs + (record.durationMs || 0));
  }
  return byType;
}

export async function writeReport({ ratioLimit = DEFAULT_TIMEOUT_RATIO_LIMIT } = {}) {
  const records = await collectRecords();
  const totals = tally(records);
  const byType = groupByType(records);
  const durations = records.map((record) => record.durationMs || 0);

  const summary = {
    schemaVersion: SCHEMA_VERSION,
    runId: currentRunId(),
    finishedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      ...(await gitInfo()),
    },
    totals,
    byType,
    ratioLimit,
    durationMs: roundMs(durations.reduce((sum, value) => sum + value, 0)),
    slowest: [...records]
      .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
      .slice(0, 10)
      .map(({ type, suite, scenario, durationMs }) => ({ type, suite, scenario, durationMs })),
    slowestSteps: records
      .flatMap((record) => (record.steps || []).map((entry) => ({ ...entry, scenario: record.scenario })))
      .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
      .slice(0, 10),
    nearTimeout: records
      .filter((record) => Number.isFinite(record.timeoutRatio) && record.timeoutRatio > ratioLimit)
      .map(({ type, suite, scenario, durationMs, timeoutMs, timeoutRatio }) => ({
        type,
        suite,
        scenario,
        durationMs,
        timeoutMs,
        timeoutRatio,
      })),
    results: records,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    path.join(RESULTS_DIR, "results.ndjson"),
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""),
    "utf8",
  );
  await writeFile(path.join(RESULTS_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  summary.history = await writeHistory(summary, records);
  return summary;
}

function scenarioKey(record) {
  return `${record.type}|${record.suite}|${record.scenario}`;
}

async function readHistory() {
  try {
    return JSON.parse(await readFile(path.join(RESULTS_DIR, "history.json"), "utf8"));
  } catch {
    return { runs: [], scenarios: {} };
  }
}

/**
 * Keeps the last few runs per scenario so duration and status can be graphed.
 * Re-reporting the same run replaces its entry rather than duplicating it.
 */
async function writeHistory(summary, records) {
  const previous = await readHistory();
  const runs = [
    {
      runId: summary.runId,
      finishedAt: summary.finishedAt,
      branch: summary.environment.branch,
      commit: summary.environment.commit,
      totals: summary.totals,
    },
    ...(previous.runs || []).filter((run) => run.runId !== summary.runId),
  ].slice(0, HISTORY_LIMIT);
  const retained = new Set(runs.map((run) => run.runId));

  const scenarios = {};
  for (const [key, entry] of Object.entries(previous.scenarios || {})) {
    const kept = (entry.runs || []).filter((run) => retained.has(run.runId) && run.runId !== summary.runId);
    if (kept.length) scenarios[key] = { ...entry, runs: kept };
  }

  for (const record of records) {
    const key = scenarioKey(record);
    const entry = (scenarios[key] ??= {
      type: record.type,
      suite: record.suite,
      scenario: record.scenario,
      file: record.file,
      runs: [],
    });
    entry.file = record.file;
    entry.runs = [
      {
        runId: summary.runId,
        finishedAt: summary.finishedAt,
        status: record.status,
        durationMs: record.durationMs,
        timeoutMs: record.timeoutMs,
        timeoutRatio: record.timeoutRatio,
        steps: record.steps || null,
      },
      ...entry.runs,
    ].slice(0, HISTORY_LIMIT);
  }

  const history = {
    schemaVersion: SCHEMA_VERSION,
    limit: HISTORY_LIMIT,
    updatedAt: summary.finishedAt,
    runs,
    scenarios,
  };
  await writeFile(path.join(RESULTS_DIR, "history.json"), `${JSON.stringify(history, null, 2)}\n`, "utf8");
  return { runs: history.runs.length, scenarios: Object.keys(scenarios).length };
}

export function printSummary(summary) {
  const { totals, byType } = summary;
  const rows = Object.entries(byType).map(([type, bucket]) => [
    type,
    String(bucket.total),
    String(bucket.pass),
    String(bucket.fail),
    String(bucket.timeout),
    `${bucket.durationMs} ms`,
  ]);
  const header = ["type", "total", "pass", "fail", "timeout", "duration"];
  const widths = header.map((label, index) => Math.max(label.length, ...rows.map((row) => row[index].length), 0));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");

  console.log("");
  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log("");
  console.log(
    `total ${totals.total}  pass ${totals.pass}  fail ${totals.fail}  timeout ${totals.timeout}  skipped ${totals.skipped}`,
  );
  if (summary.nearTimeout.length) {
    console.log("");
    console.log(
      `warning: ${summary.nearTimeout.length} scenario(s) ran close to their timeout (ratio > ${summary.ratioLimit})`,
    );
    for (const entry of summary.nearTimeout) {
      console.log(`  ${entry.type}/${entry.suite}  ${entry.scenario}  ratio ${entry.timeoutRatio}`);
    }
  }
  console.log(`report: ${path.relative(process.cwd(), path.join(RESULTS_DIR, "summary.json"))}`);
  if (summary.history) {
    const historyPath = path.relative(process.cwd(), path.join(RESULTS_DIR, "history.json"));
    console.log(`history: ${historyPath} (${summary.history.runs} runs, ${summary.history.scenarios} scenarios)`);
  }
}

export async function clearShards() {
  await rm(SHARD_DIR, { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = await writeReport();
  printSummary(summary);
}
