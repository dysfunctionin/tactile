import React from "react";
import { loadManifest, loadRun } from "./data.js";
import { Badge, Card, CardContent, CardHeader, CardTitle, Separator } from "./components/ui/primitives.jsx";
import { FirstLastSpark, scenarioLabel } from "./components/charts.jsx";
import { RunHeader } from "./components/chrome.jsx";
import { TARGETS } from "./lib/targets.js";

const PROFILES = ["low", "high"];

const METRICS = {
  loadWarm: { title: "Load warm", unit: "ms", pick: (p) => p.loadWarmMs?.median },
  import: { title: "Import + first render", unit: "ms", pick: (p) => p.scenarios?.["import-profile"]?.durationMs?.median },
  typingDur: { title: "Typing burst (24 keys)", unit: "ms", pick: (p) => p.scenarios?.["typing-burst"]?.durationMs?.median },
  typingP95: { title: "Typing input p95", unit: "ms", pick: (p) => p.scenarios?.["typing-burst"]?.inputLatencyP95Ms?.median },
  typingFrame: { title: "Typing frame p95", unit: "ms", pick: (p) => p.scenarios?.["typing-burst"]?.frameTimeP95Ms?.median },
  formula: { title: "Formula add", unit: "ms", pick: (p) => p.scenarios?.["formula-add"]?.durationMs?.median },
  scrollVertDur: { title: "Scroll vertical", unit: "ms", pick: (p) => p.scenarios?.["scroll-vertical"]?.durationMs?.median },
  scrollVertFrame: { title: "Scroll vert frame p95", unit: "ms", pick: (p) => p.scenarios?.["scroll-vertical"]?.frameTimeP95Ms?.median },
  scrollDiagDur: { title: "Scroll diagonal", unit: "ms", pick: (p) => p.scenarios?.["scroll-diagonal"]?.durationMs?.median },
  scrollDiagFrame: { title: "Scroll diag frame p95", unit: "ms", pick: (p) => p.scenarios?.["scroll-diagonal"]?.frameTimeP95Ms?.median },
  inOut: { title: "In / out transition", unit: "ms", pick: (p) => p.scenarios?.["in-out"]?.durationMs?.median },
  nested: { title: "Nested open/close", unit: "ms", pick: (p) => p.scenarios?.["nested"]?.durationMs?.median },
  addRow: { title: "Add row (op median)", unit: "ms", pick: (p) => p.scenarios?.["add-row"]?.opMedianMs ?? p.scenarios?.["add-row"]?.durationMs?.median },
  addCol: { title: "Add column (op median)", unit: "ms", pick: (p) => p.scenarios?.["add-column"]?.opMedianMs ?? p.scenarios?.["add-column"]?.durationMs?.median },
  memDelta: { title: "Mem Δ (nested)", unit: "MB", pick: (p) => p.scenarios?.["nested"]?.memoryDeltaMB?.max },
  rssMax: { title: "RSS max", unit: "MB", pick: (p) => p.scenarios?.["scroll-diagonal"]?.appRssMaxMB },
};

const SECTIONS = [
  { id: "startup", title: "Startup & import", metricIds: ["loadWarm", "import"] },
  { id: "input", title: "Typing & input", metricIds: ["typingDur", "typingP95", "typingFrame", "formula"] },
  { id: "scroll", title: "Scrolling", metricIds: ["scrollVertDur", "scrollVertFrame", "scrollDiagDur", "scrollDiagFrame"] },
  { id: "structural", title: "Structural edits", metricIds: ["inOut", "nested", "addRow", "addCol"] },
  { id: "memory", title: "Memory", metricIds: ["memDelta", "rssMax"] },
];

function fmt(v, unit) {
  if (!Number.isFinite(v)) return "—";
  return unit === "MB" ? `${v.toFixed(1)} MB` : `${Math.round(v)} ms`;
}

// Lower is better for every metric. 0 = ok/on target, 1 = over target.
function statusOf(value, target) {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return null;
  return value <= target ? 0 : 1;
}

function hasErrors(runDoc) {
  for (const profile of PROFILES) {
    const scenarios = runDoc?.profiles?.[profile]?.scenarios || {};
    for (const agg of Object.values(scenarios)) {
      if (agg?.actionErrors?.length) return true;
    }
  }
  return false;
}

function SparkCell({ points, unit, target }) {
  const vals = points.filter((p) => Number.isFinite(p.value));
  if (!vals.length) return <p className="py-6 text-center font-mono text-xs text-muted-foreground">—</p>;
  const last = vals[vals.length - 1].value;
  const first = vals[0].value;
  const isSingle = vals.length === 1;
  const delta = !isSingle && Number.isFinite(first) && first !== 0 ? ((last - first) / first) * 100 : null;
  const status = statusOf(last, target);
  const statusTone = status === 0 ? "ok" : status === 1 ? "over" : "na";
  const statusColor = statusTone === "ok" ? "text-emerald-600 dark:text-emerald-400" : statusTone === "over" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
  const isTimeout = vals.every((v) => v.value >= 29800 && v.value <= 30500);
  return (
    <div className="space-y-1">
      <FirstLastSpark points={vals} unit={unit} target={target} />
      <div className="flex items-baseline justify-between gap-2 px-0.5 font-mono text-xs">
        <span className={isTimeout ? "text-[#dc2626]" : "text-foreground"}>
          {fmt(last, unit)}{isTimeout ? " · timeout" : ""}
        </span>
        <span className="flex items-baseline gap-1.5">
          {Number.isFinite(target) ? (
            <span className={`font-mono text-[11px] ${statusColor}`}>
              {statusTone === "ok" ? "✓" : statusTone === "over" ? `▲ ${(last - target).toFixed(0)}` : ""}
            </span>
          ) : null}
          {!isSingle && delta != null ? (
            <span className={`text-[11px] ${delta < -0.05 ? "text-[#2563eb]" : delta > 0.05 ? "text-[#dc2626]" : "text-muted-foreground"}`}>
              {delta > 0 ? "+" : ""}{delta.toFixed(1)}%
            </span>
          ) : null}
        </span>
      </div>
      {vals.length > 1 ? (
        <div className="flex justify-between px-0.5 font-mono text-[10px] text-muted-foreground">
          <span>min {Math.round(Math.min(...vals.map((v) => v.value)))}</span>
          <span>max {Math.round(Math.max(...vals.map((v) => v.value)))}</span>
        </div>
      ) : null}
    </div>
  );
}

function MetricCardBody({ metric, runDocs }) {
  const target = TARGETS[metric.id];
  return (
    <CardContent className="grid grid-cols-2 gap-4 pt-0">
      {PROFILES.map((profile, index) => {
        const points = runDocs.map((doc, i) => ({
          label: `R${i + 1}`,
          time: doc.generatedAt.slice(5, 16).replace("T", " "),
          value: metric.pick(doc.profiles?.[profile] ?? {}),
        }));
        return (
          <div key={profile} className={index === 1 ? "border-l border-border/60 pl-4" : ""}>
            <p className="mb-1 font-mono text-[10px] tracking-wide text-muted-foreground">
              {profile.toUpperCase()} {Number.isFinite(target?.[profile]) ? `· target ${Math.round(target[profile])}` : ""}
            </p>
            <SparkCell points={points} unit={metric.unit} target={target?.[profile]} />
          </div>
        );
      })}
    </CardContent>
  );
}

function GoalSummary({ runDoc }) {
  if (!runDoc) return null;
  const rows = [];
  for (const metric of Object.values(METRICS)) {
    const target = TARGETS[metric.id];
    if (!target) continue;
    rows.push({ metric, target });
  }
  const perProfile = Object.fromEntries(PROFILES.map((profile) => {
    let ok = 0;
    let over = 0;
    let known = 0;
    for (const { metric, target } of rows) {
      const value = metric.pick(runDoc.profiles?.[profile] ?? {});
      const status = statusOf(value, target?.[profile]);
      if (status == null) continue;
      known += 1;
      if (status === 0) ok += 1;
      else over += 1;
    }
    return [profile, { ok, over, known }];
  }));
  const errored = hasErrors(runDoc);
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
      {PROFILES.map((profile) => {
        const s = perProfile[profile];
        const pct = s.known ? Math.round((s.ok / s.known) * 100) : 0;
        const tone = pct === 100 ? "success" : pct >= 60 ? "warning" : "destructive";
        return (
          <Badge key={profile} variant={tone}>
            {profile} targets {s.ok}/{s.known} ({pct}%)
          </Badge>
        );
      })}
      {errored ? <Badge variant="destructive">run has action errors</Badge> : <Badge variant="success">no action errors</Badge>}
    </div>
  );
}

function RunMatrix({ runDocs }) {
  const runs = runDocs;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left font-mono text-[11px]">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-2 pr-4 font-medium">metric</th>
            {runs.map((doc, i) => (
              <th key={doc.runId} className="py-2 pr-6 font-medium" title={doc.generatedAt}>
                R{i + 1} · {doc.generatedAt.slice(5, 16).replace("T", " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.values(METRICS).map((metric) => {
            const target = TARGETS[metric.id];
            return (
              <tr key={metric.id} className="border-b border-border/60 last:border-0">
                <td className="py-2 pr-4">
                  <span className="text-foreground">{metric.title}</span>
                  {target ? <span className="ml-2 text-muted-foreground">target {target.low}/{target.high}</span> : null}
                </td>
                {runs.map((doc) => {
                  const profileValues = PROFILES.map((profile) => ({
                    profile,
                    value: metric.pick(doc.profiles?.[profile] ?? {}),
                    status: statusOf(metric.pick(doc.profiles?.[profile] ?? {}), target?.[profile]),
                  }));
                  const cellTone = profileValues.some((p) => p.status === 1) ? "text-amber-600 dark:text-amber-400" : "text-foreground";
                  return (
                    <td key={doc.runId} className={`py-2 pr-6 whitespace-nowrap ${cellTone}`}>
                      {profileValues
                        .map((p) => (Number.isFinite(p.value) ? `${p.profile}:${fmt(p.value, metric.unit)}${p.status === 1 ? "▲" : ""}` : `${p.profile}:—`))
                        .join(" · ")}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [manifest, setManifest] = React.useState(null);
  const [runDocs, setRunDocs] = React.useState([]);
  const [latestRun, setLatestRun] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState(null);
  const docsRef = React.useRef(new Map());
  const selectedRef = React.useRef(null);
  const latestRunRef = React.useRef(null);

  const loadAll = React.useCallback(async () => {
    const m = await loadManifest();
    setManifest(m);
    const entries = [...(m.runs || [])].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
    const docsMap = docsRef.current;
    const loaded = [];
    for (const entry of entries) {
      let doc = docsMap.get(entry.runId);
      if (!doc) {
        try {
          doc = await loadRun(entry);
          docsMap.set(entry.runId, doc);
        } catch {
          continue;
        }
      }
      loaded.push(doc);
    }
    loaded.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
    setRunDocs(loaded);
    setLastRefreshedAt(Date.now());

    const hashRun = window.location.hash.replace(/^#run=/, "");
    let selected = loaded.find((d) => d.runId === hashRun) || (selectedRef.current && loaded.find((d) => d.runId === selectedRef.current));
    if (!selected) {
      const latestId = m.latestRunId || entries.at(-1)?.runId;
      selected = loaded.find((d) => d.runId === latestId) || loaded.at(-1) || null;
    }
    if (selected && selected.runId !== latestRunRef.current?.runId) {
      latestRunRef.current = selected;
      setLatestRun(selected);
    } else if (!latestRunRef.current && loaded.length) {
      latestRunRef.current = loaded.at(-1);
      setLatestRun(loaded.at(-1));
    }
    return loaded.length;
  }, []);

  React.useEffect(() => {
    loadAll().catch((e) => setError(e.message));
    const id = setInterval(() => loadAll().catch(() => {}), 5000);
    return () => clearInterval(id);
  }, [loadAll]);

  const selectRun = React.useCallback((runId) => {
    const doc = runDocs.find((d) => d.runId === runId);
    if (!doc) return;
    selectedRef.current = runId;
    latestRunRef.current = doc;
    try {
      window.history.replaceState(null, "", `#run=${runId}`);
    } catch {
      // hash persistence is best-effort
    }
    setLatestRun(doc);
  }, [runDocs]);

  const secondsAgo = lastRefreshedAt != null ? Math.round((Date.now() - lastRefreshedAt) / 1000) : null;

  if (error) return <div className="p-10 text-sm text-muted-foreground">Failed to load benchmark data: {error}</div>;
  if (!manifest) return <div className="p-10 font-mono text-xs text-muted-foreground">Loading runs…</div>;
  if (!runDocs.length) {
    return (
      <div className="min-h-full">
        <header className="border-b border-border px-6 py-4"><h1 className="text-base font-semibold tracking-tight">Tactile — Performance Suite</h1><p className="mt-1 font-mono text-xs text-muted-foreground">No runs yet — baseline is running. Auto-reloads every 5s.</p></header>
        <div className="p-10 font-mono text-xs text-muted-foreground">Waiting for first run in <span className="text-foreground">perf-dashboard/app/public/data/runs/</span></div>
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <RunHeader run={latestRun} manifest={manifest} onRunChange={selectRun} />
      <main className="mx-auto flex max-w-[1280px] flex-col gap-4 px-6 py-5">
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          <span>{runDocs.length} run{runDocs.length > 1 ? "s" : ""} · {runDocs[0].generatedAt.slice(0, 16).replace("T", " ")} → {runDocs.at(-1).generatedAt.slice(0, 16).replace("T", " ")}</span>
          <span className="h-3 w-px bg-border" />
          <GoalSummary runDoc={latestRun} />
          <span className="h-3 w-px bg-border" />
          <span>{secondsAgo != null ? `updated ${secondsAgo}s ago` : "updating…"}</span>
          <button
            type="button"
            className="ml-1 inline-flex h-6 items-center rounded border border-border px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => loadAll().catch(() => {})}
          >
            ↻ refresh
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span>▲ = over target (dashed violet line / violet dot = target)</span>
          <span className="h-3 w-px bg-border" />
          <span>first = baseline reference</span>
        </div>

        {SECTIONS.map((section) => (
          <section key={section.id}>
            <h2 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {section.metricIds.map((metricId) => {
                const metric = METRICS[metricId];
                return (
                  <Card key={metricId}>
                    <CardHeader className="pb-2 pt-4">
                      <CardTitle className="text-[13px] font-medium tracking-tight">{metric.title}</CardTitle>
                    </CardHeader>
                    <MetricCardBody metric={metric} runDocs={runDocs} />
                  </Card>
                );
              })}
            </div>
          </section>
        ))}

        <details className="group" open>
          <summary className="cursor-pointer list-none font-mono text-xs text-muted-foreground hover:text-foreground">▸ All runs × metrics (matrix)</summary>
          <div className="mt-3"><RunMatrix runDocs={runDocs} /></div>
        </details>

        <details className="group">
          <summary className="cursor-pointer list-none font-mono text-xs text-muted-foreground hover:text-foreground">▸ Details (latest run scenario table)</summary>
          <div className="mt-3"><ScenarioTable run={latestRun} /></div>
        </details>

        <Separator />
        <p className="font-mono text-[11px] text-muted-foreground">
          Re-run <span className="text-foreground">npm run bench:suite -- --profiles low,high --repeats 1 --label &lt;step&gt;</span> after each fix — first run stays the reference. Served from <span className="text-foreground">perf-dashboard/app/public/data</span>; dev mode reloads it live.
        </p>
      </main>
    </div>
  );
}

function ScenarioTable({ run }) {
  if (!run?.profiles || !Object.keys(run.profiles).length) return null;
  const profiles = Object.keys(run.profiles);
  const scenarioNames = Object.keys(run.profiles[profiles[0]].scenarios || {});
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">All scenarios — latest</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-left font-mono text-[11px]">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="py-2 pr-4 font-medium">scenario</th>
              {profiles.map((p) => <th key={p} className="py-2 pr-6 font-medium">{p} dur</th>)}
              {profiles.map((p) => <th key={`f-${p}`} className="py-2 pr-6 font-medium">{p} fr p95/max</th>)}
              {profiles.map((p) => <th key={`i-${p}`} className="py-2 pr-6 font-medium">{p} inp</th>)}
              {profiles.map((p) => <th key={`l-${p}`} className="py-2 pr-4 font-medium">{p} lt/drp</th>)}
            </tr>
          </thead>
          <tbody>
            {scenarioNames.map((name) => {
              const row = profiles.map((profile) => run.profiles[profile].scenarios[name]);
              const fmt = (v, s = "") => Number.isFinite(v) ? `${v.toFixed(1)}${s}` : "—";
              return (
                <tr key={name} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-4">{scenarioLabel(name)}</td>
                  {row.map((agg, i) => <td key={`d${i}`} className="py-2 pr-6">{fmt(agg.durationMs?.median, " ms")}{agg.actionErrors?.length ? <span className="ml-1 text-[#dc2626]">· {agg.actionErrors.length} err</span> : null}</td>)}
                  {row.map((agg, i) => <td key={`f${i}`} className="py-2 pr-6 text-muted-foreground">{fmt(agg.frameTimeP95Ms?.median)} / {fmt(agg.frameTimeMaxMs?.median)}</td>)}
                  {row.map((agg, i) => <td key={`i${i}`} className="py-2 pr-6 text-muted-foreground">{fmt(agg.inputLatencyP95Ms?.median)}</td>)}
                  {row.map((agg, i) => <td key={`l${i}`} className="py-2 pr-4 text-muted-foreground">{fmt(agg.longTasksOver50?.median)} / {fmt(agg.droppedFrames?.median)}</td>)}
                </tr>
              );
            })}
            <tr>
              <td className="py-2 pr-4 font-semibold">load-warm</td>
              {profiles.map((p, i) => <td key={i} className="py-2 pr-6 font-semibold">{fmt(run.profiles[p].loadWarmMs?.median, " ms")}</td>)}
              {profiles.map(() => <td key="x" className="py-2 pr-6" />)}
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}