import React from "react";
import { Badge, Button } from "./ui/primitives.jsx";

export function ThemeToggle() {
  const [dark, setDark] = React.useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("perf-ui-theme", next ? "dark" : "light");
  };
  return (
    <Button variant="outline" onClick={toggle} aria-label="Toggle theme">
      {dark ? "☾ Dark" : "☀ Light"}
    </Button>
  );
}

export function RunHeader({ run, manifest, onRunChange }) {
  if (!run) return null;
  return (
    <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold tracking-tight">Tactile — Performance Suite</h1>
          <Badge variant="secondary" className="font-mono">
            v{run.appVersion}
          </Badge>
          <Badge variant="outline" className="font-mono">
            {run.git?.commit?.slice(0, 9) || run.gitCommit || "?"} @ {run.git?.branch || "?"}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs"
            value={run.runId}
            onChange={(event) => onRunChange?.(event.target.value)}
          >
            {(manifest?.runs || []).map((entry) => (
              <option key={entry.runId} value={entry.runId}>
                {entry.generatedAt.slice(0, 16).replace("T", " ")}
                {entry.label ? ` · ${entry.label}` : ""}
              </option>
            ))}
          </select>
          <ThemeToggle />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <Badge variant="outline">{run.machine?.cpuModel}</Badge>
        <Badge variant="outline">{run.machine?.cpuCount} cores</Badge>
        <Badge variant="outline">{run.machine?.totalMemGB} GB RAM</Badge>
        <Badge variant={envTone(run)}>{envSummary(run)}</Badge>
        <Badge variant={run.target === "native" ? "default" : "outline"}>
          {run.target || run.server?.mode}:{run.server?.port ?? run.server?.cdpPort}
        </Badge>
        <Badge variant="outline">{run.repeats} repeats/profile</Badge>
        {run.elapsedSec != null ? <Badge variant="outline">suite {run.elapsedSec}s</Badge> : null}
      </div>
    </header>
  );
}

function envSummary(run) {
  const before = run.envGuard?.systemBefore?.freeMemMB;
  const after = run.envGuard?.systemAfter?.freeMemMB;
  if (!Number.isFinite(before) || !Number.isFinite(after)) return "env n/a";
  return `free RAM ${Math.min(before, after)}→${Math.max(before, after)} MB`;
}

function envTone(run) {
  const before = run.envGuard?.systemBefore?.freeMemMB;
  const total = (run.machine?.totalMemGB || 8) * 1024;
  if (!Number.isFinite(before)) return "warning";
  const ratio = before / total;
  if (ratio < 0.15) return "destructive";
  if (ratio < 0.25) return "warning";
  return "success";
}
