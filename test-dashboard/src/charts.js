import { formatMs } from "./metrics.js";

const NS = "http://www.w3.org/2000/svg";

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
