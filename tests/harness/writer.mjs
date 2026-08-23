import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

export const RESULTS_DIR = process.env.TACTILE_TEST_RESULTS_DIR
  ? path.resolve(process.env.TACTILE_TEST_RESULTS_DIR)
  : path.resolve(process.cwd(), "test-results");

export const SHARD_DIR = path.join(RESULTS_DIR, ".shards");

export function currentRunId() {
  return process.env.TACTILE_TEST_RUN_ID || "local";
}

// Test files run in separate processes, so each writes its own shard and the
// reporter merges them; concurrent appends to one file are not atomic.
let shardFile = null;
function resolveShardFile() {
  if (!shardFile) {
    mkdirSync(SHARD_DIR, { recursive: true });
    shardFile = path.join(SHARD_DIR, `${process.pid}-${randomUUID()}.ndjson`);
  }
  return shardFile;
}

export function appendRecord(record) {
  appendFileSync(resolveShardFile(), `${JSON.stringify(record)}\n`, "utf8");
}

export function repoRelative(filePath) {
  if (!filePath) return null;
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}
