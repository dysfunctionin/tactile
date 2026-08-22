import { spawn } from "node:child_process";
import { existsSync as _existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { powershell } from "./powershell.mjs";

export const NATIVE_EXE_PATH = path.resolve("src-tauri", "target", "release", "tactile.exe");
export const TACTILE_PROCESS_NAMES = ["tactile.exe"];

export async function ensureNativeBinary({ rebuild = false, log = console.log } = {}) {
  if (!rebuild) {
    try {
      await import("node:fs/promises").then((fs) => fs.access(NATIVE_EXE_PATH));
      return { rebuilt: false, path: NATIVE_EXE_PATH };
    } catch {
      log("native: release binary missing — building…");
    }
  }
  log("native: npm run build (frontend embedded into binary)…");
  await new Promise((resolve, reject) => {
    const child = spawn("npm.cmd", ["run", "build"], { cwd: process.cwd(), stdio: "inherit", shell: true });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm run build exited ${code}`))));
  });
  log("native: cargo build --release (first run can take several minutes)…");
  await new Promise((resolve, reject) => {
    const child = spawn(
      "cargo",
      ["build", "--release", "--manifest-path", path.resolve("src-tauri", "Cargo.toml")],
      { cwd: process.cwd(), stdio: "inherit", shell: true },
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cargo build exited ${code}`))));
  });
  return { rebuilt: true, path: NATIVE_EXE_PATH };
}

export async function killNativeApp() {
  await powershell(
    "Get-Process | Where-Object { $_.ProcessName -eq 'tactile' } | Stop-Process -Force -ErrorAction SilentlyContinue",
  );
  // Ensure the marker that makes folder snapshot win is gone too
  const markerPaths = [
    `${process.env.LOCALAPPDATA || ""}\\com.tactile.workspace.alpha\\last-workspace-path.txt`,
    `${process.env.APPDATA || ""}\\com.tactile.workspace.alpha\\last-workspace-path.txt`,
  ];
  for (const marker of markerPaths) {
    if (!marker || marker.length < 10) continue;
    if (!_existsSync(marker)) continue;
    await powershell(`Remove-Item -LiteralPath '${marker}' -Force -ErrorAction SilentlyContinue`);
  }
}

export function cdpPortArgs(port) {
  return `--remote-debugging-port=${port}`;
}

export async function launchNativeApp({ cdpPort, log = console.log }) {
  await killNativeApp();
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  };
  const startedAt = Date.now();
  const child = spawn(NATIVE_EXE_PATH, [], { env, detached: false, stdio: "ignore" });
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) {
        log(`native: app up with CDP on :${cdpPort} (${Date.now() - startedAt}ms)`);
        return { child, cdpUrl, startedAt };
      }
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Native app did not expose the CDP endpoint within 30s.");
}

export async function sampleNativeProcesses() {
  const script =
    "Get-Process | Where-Object { $_.ProcessName -eq 'tactile' } | Select-Object Id,@{n='rssMB';e={[math]::Round($_.WorkingSet64/1MB,1)}},@{n='cpuSec';e={[math]::Round($_.CPU,2)}} | ConvertTo-Json -Compress";
  try {
    const out = await powershell(script);
    if (!out) return { rssMB: 0, cpuSec: 0, processes: [] };
    const parsed = JSON.parse(out);
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    return {
      processes,
      rssMB: processes.reduce((total, p) => total + (p.rssMB || 0), 0),
      cpuSec: processes.reduce((total, p) => total + (p.cpuSec || 0), 0),
    };
  } catch {
    return null;
  }
}

export function defaultWebViewCacheDir() {
  const dir = path.join(os.tmpdir(), `tactile-perf-webview-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
