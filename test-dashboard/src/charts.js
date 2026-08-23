import { formatMs, formatPercent, percentChange } from "./metrics.js";

const NS = "http://www.w3.org/2000/svg";
const SERIES_COUNT = 8;

function el(name, attributes = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/**
 * Line chart of duration across retained runs, oldest on the left.
 * Best and worst points are marked so a regression is visible at a glance.
 */
export function durationChart(entry, { width = 620, height = 200 } = {}) {
  const runs = [...(entry.runs || [])].reverse();
  const values = runs.map((run) => run.durationMs || 0);
  const figure = document.createElement("figure");
  figure.className = "chart";

  const caption = document.createElement("figcaption");
  caption.textContent = `Duration across the last ${runs.length} run${runs.length === 1 ? "" : "s"} — ${entry.scenario}`;
  figure.append(caption);

  if (runs.length < 2) {
    const note = document.createElement("p");
    note.className = "chart-empty";
    note.textContent =
      runs.length === 1
        ? `Only one run recorded (${formatMs(values[0])}). Run the suite again to build a trend.`
        : "No runs recorded yet.";
    figure.append(note);
    return figure;
  }

  const padding = { top: 18, right: 18, bottom: 34, left: 62 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || max || 1;
  const best = min;
  const worst = max;

  const x = (index) => padding.left + (plotWidth * index) / (runs.length - 1);
  const y = (value) => padding.top + plotHeight - ((value - min) / span) * plotHeight;

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" });
  svg.setAttribute("aria-label", `Duration trend for ${entry.scenario}`);

  for (let index = 0; index <= 3; index += 1) {
    const value = min + (span * index) / 3;
    const gridY = y(value);
    svg.append(el("line", { x1: padding.left, x2: width - padding.right, y1: gridY, y2: gridY, class: "grid" }));
    const label = el("text", { x: padding.left - 8, y: gridY + 4, class: "axis", "text-anchor": "end" });
    label.textContent = formatMs(value);
    svg.append(label);
  }

  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  svg.append(el("polyline", { points, class: "series" }));

  values.forEach((value, index) => {
    const marker = el("circle", {
      cx: x(index),
      cy: y(value),
      r: index === values.length - 1 ? 6 : 4,
      class: `point ${value === best ? "is-best" : value === worst ? "is-worst" : ""}${
        index === values.length - 1 ? " is-current" : ""
      }`,
    });
    const title = el("title");
    title.textContent = `${runs[index].runId} — ${formatMs(value)} (${runs[index].status})`;
    marker.append(title);
    svg.append(marker);

    const stamp = el("text", { x: x(index), y: height - 12, class: "axis", "text-anchor": "middle" });
    stamp.textContent = index === values.length - 1 ? "now" : `-${values.length - 1 - index}`;
    svg.append(stamp);
  });

  figure.append(svg);
  return figure;
}

/** Horizontal bars comparing each action's duration within a scenario. */
export function stepBars(steps) {
  const figure = document.createElement("figure");
  figure.className = "chart";
  const caption = document.createElement("figcaption");
  caption.textContent = "Time per action in the latest run";
  figure.append(caption);

  if (!steps.length) {
    const note = document.createElement("p");
    note.className = "chart-empty";
    note.textContent = "This scenario records no individual actions.";
    figure.append(note);
    return figure;
  }

  const max = Math.max(...steps.map((step) => step.durationMs || 0)) || 1;
  const list = document.createElement("ul");
  list.className = "bars";

  for (const step of steps) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = step.name;
    const track = document.createElement("span");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = `bar-fill${step.status === "pass" ? "" : " is-failed"}`;
    fill.style.width = `${Math.max(1, ((step.durationMs || 0) / max) * 100)}%`;
    track.append(fill);
    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = formatMs(step.durationMs);
    item.append(label, track, value);
    list.append(item);
  }

  figure.append(list);
  return figure;
}

/**
 * Every scenario side by side for the latest run, longest first.
 * Answers "what costs the most right now" in one view.
 */
export function compareBars(entries, { limit = 24 } = {}) {
  const figure = document.createElement("figure");
  figure.className = "chart";
  const caption = document.createElement("figcaption");
  figure.append(caption);

  const ranked = entries
    .filter(([, entry]) => Number.isFinite(entry.runs[0]?.durationMs))
    .sort((a, b) => b[1].runs[0].durationMs - a[1].runs[0].durationMs)
    .slice(0, limit);

  caption.textContent = `Slowest ${ranked.length} scenarios in their most recent run`;

  if (!ranked.length) {
    const note = document.createElement("p");
    note.className = "chart-empty";
    note.textContent = "No durations recorded yet.";
    figure.append(note);
    return figure;
  }

  const max = ranked[0][1].runs[0].durationMs || 1;
  const list = document.createElement("ul");
  list.className = "bars compare-bars";

  for (const [key, entry] of ranked) {
    const run = entry.runs[0];
    const item = document.createElement("li");

    const label = document.createElement("a");
    label.className = "bar-label";
    label.href = `#/scenario/${encodeURIComponent(key)}`;
    label.textContent = entry.scenario;
    label.title = `${entry.type} / ${entry.suite} — ${entry.scenario}`;

    const track = document.createElement("span");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = `bar-fill${run.status === "pass" ? "" : " is-failed"}`;
    fill.style.width = `${Math.max(1, (run.durationMs / max) * 100)}%`;
    track.append(fill);

    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = formatMs(run.durationMs);

    const change = document.createElement("span");
    const delta = percentChange(run.durationMs, entry.runs[1]?.durationMs);
    change.className = `bar-delta ${delta === null ? "" : delta <= -5 ? "better" : delta >= 5 ? "worse" : "steady"}`;
    change.textContent = formatPercent(delta);

    item.append(label, track, value, change);
    list.append(item);
  }

  figure.append(list);
  return figure;
}

/**
 * Several scenarios on one axis, each normalized to its own oldest retained run.
 * Absolute durations differ by orders of magnitude, so relative change is what
 * makes them comparable.
 */
export function relativeTrend(entries, { limit = 8, width = 860, height = 300 } = {}) {
  const figure = document.createElement("figure");
  figure.className = "chart";
  const caption = document.createElement("figcaption");
  figure.append(caption);

  const usable = entries
    .filter(([, entry]) => entry.runs.filter((run) => Number.isFinite(run.durationMs)).length >= 2)
    .sort((a, b) => (b[1].runs[0]?.durationMs || 0) - (a[1].runs[0]?.durationMs || 0))
    .slice(0, limit);

  caption.textContent = `Relative duration of the ${usable.length} slowest scenarios, each indexed to its oldest retained run`;

  if (!usable.length) {
    const note = document.createElement("p");
    note.className = "chart-empty";
    note.textContent = "At least two runs are needed before a trend can be drawn.";
    figure.append(note);
    return figure;
  }

  const series = usable.map(([key, entry], index) => {
    const runs = [...entry.runs].reverse();
    const baseline = runs[0].durationMs || 1;
    return {
      key,
      label: entry.scenario,
      index: index % SERIES_COUNT,
      points: runs.map((run) => ((run.durationMs || 0) / baseline) * 100),
      runs,
    };
  });

  const columns = Math.max(...series.map((line) => line.points.length));
  const values = series.flatMap((line) => line.points);
  const max = Math.max(100, ...values);
  const min = Math.min(100, ...values);
  const span = max - min || 1;

  const padding = { top: 16, right: 16, bottom: 34, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (i) => padding.left + (columns === 1 ? plotWidth / 2 : (plotWidth * i) / (columns - 1));
  const y = (value) => padding.top + plotHeight - ((value - min) / span) * plotHeight;

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, role: "img" });
  svg.setAttribute("aria-label", "Relative duration trend across scenarios");

  for (let index = 0; index <= 4; index += 1) {
    const value = min + (span * index) / 4;
    const gridY = y(value);
    svg.append(el("line", { x1: padding.left, x2: width - padding.right, y1: gridY, y2: gridY, class: "grid" }));
    const label = el("text", { x: padding.left - 8, y: gridY + 4, class: "axis", "text-anchor": "end" });
    label.textContent = `${Math.round(value)}%`;
    svg.append(label);
  }

  // The 100% line is the baseline every series is measured against.
  svg.append(
    el("line", { x1: padding.left, x2: width - padding.right, y1: y(100), y2: y(100), class: "grid baseline" }),
  );

  for (const line of series) {
    const points = line.points.map((value, i) => `${x(i)},${y(value)}`).join(" ");
    const path = el("polyline", { points, class: `series series-${line.index}` });
    path.dataset.seriesKey = line.key;
    svg.append(path);
    line.points.forEach((value, i) => {
      const marker = el("circle", {
        cx: x(i),
        cy: y(value),
        r: i === line.points.length - 1 ? 5 : 3,
        class: `point series-${line.index}`,
      });
      marker.dataset.seriesKey = line.key;
      const title = el("title");
      title.textContent = `${line.label} — ${formatMs(line.runs[i].durationMs)} (${Math.round(value)}% of baseline)`;
      marker.append(title);
      svg.append(marker);
    });
  }

  for (let i = 0; i < columns; i += 1) {
    const stamp = el("text", { x: x(i), y: height - 12, class: "axis", "text-anchor": "middle" });
    stamp.textContent = i === columns - 1 ? "now" : `-${columns - 1 - i}`;
    svg.append(stamp);
  }

  figure.append(svg);

  const hidden = new Set();
  let highlighted = null;

  function paint() {
    for (const node of svg.querySelectorAll("[data-series-key]")) {
      const key = node.dataset.seriesKey;
      node.classList.toggle("is-hidden", hidden.has(key));
      node.classList.toggle("is-emphasised", highlighted === key);
      node.classList.toggle("is-muted", highlighted !== null && highlighted !== key && !hidden.has(key));
    }
  }

  const legend = document.createElement("ul");
  legend.className = "legend";
  for (const line of series) {
    const item = document.createElement("li");

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "legend-toggle";
    toggle.setAttribute("aria-pressed", "true");
    toggle.title = "Show or hide this line";
    const swatch = document.createElement("span");
    swatch.className = `swatch series-${line.index}`;
    const label = document.createElement("span");
    label.className = "legend-label";
    label.textContent = line.label;
    toggle.append(swatch, label);

    toggle.addEventListener("click", () => {
      const nowHidden = !hidden.has(line.key);
      if (nowHidden) hidden.add(line.key);
      else hidden.delete(line.key);
      toggle.setAttribute("aria-pressed", String(!nowHidden));
      item.classList.toggle("is-off", nowHidden);
      paint();
    });
    // Hovering the legend isolates one line without changing what is toggled on.
    toggle.addEventListener("pointerenter", () => {
      if (hidden.has(line.key)) return;
      highlighted = line.key;
      paint();
    });
    toggle.addEventListener("pointerleave", () => {
      highlighted = null;
      paint();
    });

    const latest = line.points.at(-1);
    const change = document.createElement("span");
    change.className = `bar-delta ${latest <= 95 ? "better" : latest >= 105 ? "worse" : "steady"}`;
    change.textContent = `${Math.round(latest)}% of baseline`;

    const link = document.createElement("a");
    link.className = "legend-link";
    link.href = `#/scenario/${encodeURIComponent(line.key)}`;
    link.textContent = "details";
    link.title = `Open ${line.label}`;

    item.append(toggle, change, link);
    legend.append(item);
  }
  figure.append(legend);

  return figure;
}
