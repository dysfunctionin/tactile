import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/primitives.jsx";
import { fmtMs } from "../lib/utils";

export function MetricCard({ title, value, sub, tone }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className={`font-mono text-xl ${tone === "warn" ? "text-amber-500" : ""}`}>{value}</CardTitle>
      </CardHeader>
      {sub ? (
        <CardContent className="pt-0">
          <p className="font-mono text-[11px] text-muted-foreground">{sub}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

const SCENARIO_LABELS = {
  "import-profile": "Import + first render",
  "load-warm": "Load (warm cache)",
  "scroll-vertical": "Scroll vertical",
  "scroll-diagonal": "Scroll diagonal",
  "typing-burst": "Typing burst (24 keys)",
  "formula-add": "Formula add",
  "in-out": "In/out transition",
  nested: "Nested open/close",
  "add-row": "Add row ×8",
  "add-column": "Add column ×8",
};

export function scenarioLabel(name) {
  return SCENARIO_LABELS[name] || name;
}

export function CompareBars({ run, metricKey, unit }) {
  const profiles = Object.keys(run.profiles || {});
  const data = Object.keys(run.profiles?.[profiles[0]]?.scenarios || {}).map((scenario) => {
    const point = { scenario: scenarioLabel(scenario) };
    for (const profile of profiles) {
      const agg = run.profiles[profile]?.scenarios?.[scenario];
      const value = agg?.[metricKey]?.median;
      point[profile] = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
    }
    return point;
  });
  const colors = { low: "#10b981", high: "#f59e0b" };
  return (
    <div className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 40 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="scenario"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))", fontFamily: "Geist Mono" }}
            angle={-28}
            textAnchor="end"
            interval={0}
            height={70}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))", fontFamily: "Geist Mono" }}
            width={56}
          />
          <ReTooltip
            contentStyle={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
              color: "hsl(var(--card-foreground))",
            }}
            formatter={(value) => [`${value} ${unit}`, ""]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {profiles.map((profile) => (
            <Bar
              key={profile}
              dataKey={profile}
              fill={colors[profile] ?? "#6366f1"}
              radius={[3, 3, 0, 0]}
              maxBarSize={26}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendChart({ points, metricLabel, profile }) {
  if (!points.length) {
    return <p className="py-16 text-center text-xs text-muted-foreground">No runs yet.</p>;
  }
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 16, left: -12, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="shortTime"
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))", fontFamily: "Geist Mono" }}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))", fontFamily: "Geist Mono" }}
            width={64}
          />
          <ReTooltip
            contentStyle={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
              color: "hsl(var(--card-foreground))",
            }}
            formatter={(value) => fmtMs(value)}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            type="monotone"
            dataKey="value"
            name={`${metricLabel} (${profile})`}
            stroke={profile === "low" ? "#10b981" : "#f59e0b"}
            strokeWidth={2}
            dot={{ r: 3 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FirstLastSpark({ points, unit, colorOverride, target }) {
  if (!points.length) return <p className="py-6 text-center font-mono text-xs text-muted-foreground">—</p>;
  const first = points[0]?.value;
  const last = points[points.length - 1]?.value;
  let stroke = colorOverride;
  if (!stroke) {
    if (points.length === 1) stroke = "#64748b";
    else if (Number.isFinite(first) && Number.isFinite(last)) stroke = last < first ? "#2563eb" : last > first ? "#dc2626" : "#64748b";
    else stroke = "#64748b";
  }
  const values = points.map((p) => p.value).filter(Number.isFinite);
  const domainMax = Math.max(1, ...values, Number.isFinite(target) ? target * 1.05 : 0);
  const lastLabel = points[points.length - 1]?.label;
  return (
    <div className="h-[56px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.35} />
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))", fontFamily: "Geist Mono" }} interval={0} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))", fontFamily: "Geist Mono" }} width={38} domain={[0, domainMax]} axisLine={false} tickLine={false} tickFormatter={(v) => `${Math.round(v)}`} />
          {Number.isFinite(target) ? (
            <>
              <ReferenceLine
                y={target}
                stroke="#8b5cf6"
                strokeDasharray="4 3"
                strokeOpacity={0.75}
                label={{ value: `target ${Math.round(target)}`, position: "insideBottomRight", fontSize: 9, fill: "hsl(var(--muted-foreground))", fontFamily: "Geist Mono" }}
              />
              <ReferenceDot
                x={lastLabel}
                y={target}
                r={4}
                fill="#8b5cf6"
                stroke="hsl(var(--card))"
                strokeWidth={1}
              />
            </>
          ) : null}
          <ReTooltip
            contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 11, color: "hsl(var(--card-foreground))" }}
            formatter={(value) => [`${Number(value).toFixed(1)} ${unit}`, ""]}
            labelFormatter={(label, payload) => payload?.[0]?.payload?.time ? `${label} · ${payload[0].payload.time}` : label}
          />
          <Line type="monotone" dataKey="value" stroke={stroke} strokeWidth={1.8} dot={{ r: points.length === 1 ? 4 : 2.5, fill: stroke, strokeWidth: 0 }} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
