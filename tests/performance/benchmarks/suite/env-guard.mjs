import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { powershell } from "./powershell.mjs";

const TAURI_PROCESS_PATTERNS = ["Tactile Alpha", "tactile-alpha", "tactile.exe", "tactile-dev"];

const TEMP_GLOBS = [
  path.join(os.tmpdir(), "tactile-perf-*"),
  path.join(os.tmpdir(), "tactile-code-run-*"),
  path.join(os.tmpdir(), "tactile*"),
];

// WebView2 / Tauri app-data caches for the alpha identifier. These are runtime
// caches only (rebuildable); user workspace folders are never touched here.
const TAURI_APP_CACHE_DIRS = [
  path.join(process.env.LOCALAPPDATA || "", "com.tactile.workspace.alpha"),
  path.join(process.env.APPDATA || "", "com.tactile.workspace.alpha"),
];

const TAURI_PROCESS_NAMES = new Set(["tactile", "tactile-alpha", "tactile alpha", "tactile-dev"]);

async function killTactileProcesses(log) {
  const killed = [];
  try {
    const listing = await powershell(
      "Get-Process | Where-Object { $_.ProcessName -match '^tactile' } | Select-Object Id,ProcessName | ConvertTo-Json -Compress",
    );
    let entries = [];
    if (listing) {
      const parsed = JSON.parse(listing);
      entries = Array.isArray(parsed) ? parsed : [parsed];
    }
    for (const entry of entries) {
      // Surgical guard: only known Tauri app binary names. Never match window
      // titles (editors/terminals often contain the project name) and never
      // touch node/vite/editor processes.
      if (!TAURI_PROCESS_NAMES.has(String(entry.ProcessName).toLowerCase())) continue;
      try {
        await powershell(`Stop-Process -Id ${entry.Id} -Force -ErrorAction SilentlyContinue`);
        killed.push(`${entry.ProcessName}(${entry.Id})`);
      } catch {
        // already gone
      }
    }
  } catch (error) {
    log(`env-guard: process scan skipped (${String(error?.message || error).split("\n")[0]})`);
  }
  return killed;
}

async function cleanTempArtifacts(log) {
  const removed = [];
  for (const pattern of TEMP_GLOBS) {
    try {
      await powershell(
        `Get-ChildItem -Path '${pattern.replaceAll("'", "''")}' -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
      );
      removed.push(pattern);
    } catch {
      // best effort
    }
  }
  return removed;
}

async function cleanTauriRuntimeCaches(log) {
  const removed = [];
  for (const dir of TAURI_APP_CACHE_DIRS) {
    if (!dir || dir.length < 10) continue;
    const webviewCache = path.join(dir, "EBWebView");
    if (existsSync(webviewCache)) {
      try {
        await powershell(`Remove-Item -LiteralPath '${webviewCache}' -Recurse -Force -ErrorAction SilentlyContinue`);
        removed.push(webviewCache);
      } catch {
        log(`env-guard: could not clear ${webviewCache}`);
      }
    }
    // Marker that makes native folder snapshot win over localStorage on boot
    const marker = path.join(dir, "last-workspace-path.txt");
    if (existsSync(marker)) {
      try {
        await powershell(`Remove-Item -LiteralPath '${marker}' -Force -ErrorAction SilentlyContinue`);
        removed.push(marker);
      } catch {
        log(`env-guard: could not clear ${marker}`);
      }
    }
  }
  return removed;
}

export function machineSnapshot() {
  const cpus = os.cpus();
  return {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpuModel: cpus[0]?.model?.trim() || "unknown",
    cpuCount: cpus.length,
    cpuSpeedMhz: cpus[0]?.speed ?? null,
    totalMemGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeMemMB: Math.round(os.freemem() / 1024 ** 2),
    nodeVersion: process.version,
    uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
  };
}

export async function prepareEnvironment({ log = console.log } = {}) {
  const before = machineSnapshot();
  const killed = await killTactileProcesses(log);
  const cleanedTemp = await cleanTempArtifacts(log);
  const cleanedCaches = await cleanTauriRuntimeCaches(log);
  const after = machineSnapshot();
  return {
    at: new Date().toISOString(),
    actions: {
      killedProcesses: killed,
      cleanedTempGlobs: cleanedTemp,
      clearedWebviewCaches: cleanedCaches,
    },
    systemBefore: before,
    systemAfter: after,
  };
}

export async function sampleProcessTree(rootPid) {
  if (!rootPid) return null;
  const script = `
$pids = @(${rootPid})
$all = Get-CimInstance Win32_Process -Filter "Name LIKE '%'" -ErrorAction SilentlyContinue
foreach ($depth in 1..2) {
  $children = $all | Where-Object { $pids -contains $_.ParentProcessId -and ($pids -notcontains $_.ProcessId) }
  foreach ($c in $children) { $pids += $c.ProcessId }
}
$rows = $all | Where-Object { $pids -contains $_.ProcessId } | Select-Object ProcessId,
  @{n='rssMB';e={[math]::Round($_.WorkingSetSize/1MB,1)}},
  @{n='cpuSec';e={[math]::Round(($_.KernelModeTime + $_.UserModeTime)/1e7,2)}},
  @{n='name';e={$_.Name}}
$rows | ConvertTo-Json -Compress`;
  try {
    const out = await powershell(script);
    if (!out) return { processes: [], rssMB: 0, cpuSec: 0 };
    const parsed = JSON.parse(out);
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    return {
      processes,
      rssMB: processes.reduce((t, p) => t + (p.rssMB || 0), 0),
      cpuSec: processes.reduce((t, p) => t + (p.cpuSec || 0), 0),
    };
  } catch {
    return null;
  }
}

export function freeMemMB() {
  return Math.round(os.freemem() / 1024 ** 2);
}
