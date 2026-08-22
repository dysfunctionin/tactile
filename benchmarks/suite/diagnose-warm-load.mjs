// Answers one question: after importing a large workspace, does a reload
// restore it? Reports where the bytes actually live on each side of the reload.
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { writeProfileFixture } from "./profiles.mjs";
import { importFixture, rootObjectId } from "./scenarios.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = { profile: "high", port: 4187, waitMs: 30_000 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--profile") args.profile = argv[++index];
    else if (argv[index] === "--port") args.port = Number(argv[++index]);
    else if (argv[index] === "--wait") args.waitMs = Number(argv[++index]);
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

async function storageReport(page) {
  return page.evaluate(async () => {
    const localStorageSizes = {};
    for (const key of Object.keys(window.localStorage)) {
      localStorageSizes[key] = window.localStorage.getItem(key)?.length ?? 0;
    }
    let bootMetadata = null;
    try {
      bootMetadata = JSON.parse(window.localStorage.getItem("tactile.browser.boot.v1") || "null");
    } catch {
      bootMetadata = "unparseable";
    }
    const readMeta = () =>
      new Promise((resolve) => {
        const request = indexedDB.open("tactile-local-workspace-records");
        request.onerror = () => resolve("open failed");
        request.onsuccess = () => {
          const database = request.result;
          const wanted = ["workspaceMeta", "cells", "objects"].filter((name) =>
            database.objectStoreNames.contains(name),
          );
          if (!wanted.length) {
            database.close();
            resolve({});
            return;
          }
          const transaction = database.transaction(wanted, "readonly");
          const results = {};
          let remaining = wanted.length;
          wanted.forEach((storeName) => {
            const all = transaction.objectStore(storeName).getAll();
            all.onsuccess = () => {
              results[storeName] = all.result;
              remaining -= 1;
              if (!remaining) {
                database.close();
                const byWorkspace = {};
                for (const kind of ["cells", "objects"]) {
                  for (const record of results[kind] || []) {
                    const id = String(record.workspaceId);
                    byWorkspace[id] ||= { cells: 0, objects: 0 };
                    byWorkspace[id][kind] += 1;
                  }
                }
                resolve({
                  meta: (results.workspaceMeta || []).map((record) => ({
                    workspaceId: record.workspaceId,
                    storageState: record.storageState,
                    updatedAt: record.updatedAt,
                  })),
                  recordsByWorkspace: byWorkspace,
                });
              }
            };
            all.onerror = () => {
              results[storeName] = [];
              remaining -= 1;
              if (!remaining) {
                database.close();
                resolve("read failed");
              }
            };
          });
        };
      });
    const databases = (await indexedDB.databases?.()) || [];
    const stores = {};
    for (const { name } of databases) {
      if (!name) continue;
      stores[name] = await new Promise((resolve) => {
        const request = indexedDB.open(name);
        request.onerror = () => resolve("open failed");
        request.onsuccess = () => {
          const database = request.result;
          const names = [...database.objectStoreNames];
          if (!names.length) {
            database.close();
            resolve({});
            return;
          }
          const counts = {};
          const transaction = database.transaction(names, "readonly");
          let remaining = names.length;
          names.forEach((storeName) => {
            const countRequest = transaction.objectStore(storeName).count();
            countRequest.onsuccess = () => {
              counts[storeName] = countRequest.result;
              remaining -= 1;
              if (!remaining) {
                database.close();
                resolve(counts);
              }
            };
            countRequest.onerror = () => {
              counts[storeName] = "count failed";
              remaining -= 1;
              if (!remaining) {
                database.close();
                resolve(counts);
              }
            };
          });
        };
      });
    }
    return { bootMetadata, workspaceMeta: await readMeta(), localStorageSizes, indexedDB: stores };
  });
}

const args = parseArgs(process.argv.slice(2));
const fixture = await writeProfileFixture(args.profile, path.join(ROOT, "benchmarks/.generated/warm-fixture"));
const server = await startPreview(args.port);
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/?warm=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  console.log("importing fixture…");
  await importFixture(page, fixture.path, args.profile);
  await page.waitForTimeout(2500);
  console.log("after import:", JSON.stringify(await storageReport(page), null, 1));

  console.log("\nreloading…");
  const started = Date.now();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
  const selector = `[data-object-id="${rootObjectId(args.profile)}"][data-cell-address="A1"]`;
  let restored = true;
  try {
    await page.locator(selector).waitFor({ state: "attached", timeout: args.waitMs });
  } catch {
    restored = false;
  }
  console.log(`restored: ${restored} after ${Date.now() - started}ms`);
  console.log("after reload:", JSON.stringify(await storageReport(page), null, 1));
  console.log(
    "visible objects:",
    JSON.stringify(
      await page.evaluate(() =>
        [
          ...new Set(
            [...document.querySelectorAll("[data-object-id]")].map((node) => node.getAttribute("data-object-id")),
          ),
        ].slice(0, 6),
      ),
    ),
  );
} finally {
  await browser.close();
  server.child.kill();
}
