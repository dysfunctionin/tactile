import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function powershell(script, timeoutMs = 30_000) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: timeoutMs,
    windowsHide: true,
  }).then((r) => r.stdout.trim());
}
