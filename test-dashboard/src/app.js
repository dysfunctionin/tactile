import { config } from "./config.js";
import { describeFailure, loadResults, readSource, writeSource } from "./data.js";
import { durationChart, stepBars } from "./charts.js";
import { formatMs, formatPercent, scenarioMetrics, stepComparison, trendClass, verdict } from "./metrics.js";

const root = document.querySelector("#app");
let themes = [];
let state = { source: readSource(), history: null, summary: null };

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyTheme(theme) {
  const style = document.documentElement.style;
  for (const [token, value] of Object.entries(theme.tokens)) {
    style.setProperty(`--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value);
  }
  document.documentElement.dataset.colorScheme = theme.colorScheme;
  try {
    window.localStorage.setItem("tactile-dashboard-theme", theme.id);
  } catch {
    /* storage unavailable; theme applies for this page load */
  }
}

function matchesHotTopic(entry) {
  const haystack = `${entry.type} ${entry.suite} ${entry.scenario} ${entry.file}`.toLowerCase();
  return config.hotTopic.match.some((needle) => haystack.includes(needle.toLowerCase()));
}

function statusPill(status) {
  return h("span", `pill status-${status}`, status);
}

function metricBlock(label, value, tone, hint) {
  const block = h("div", `metric ${tone || ""}`);
  block.append(h("span", "metric-label", label), h("strong", "metric-value", value));
  if (hint) block.append(h("span", "metric-hint", hint));
  return block;
}

function scenarioSummaryLine(metrics) {
  const parts = [
    `${metrics.runCount} run${metrics.runCount === 1 ? "" : "s"} retained`,
    `best ${formatMs(metrics.min)}`,
    `worst ${formatMs(metrics.max)}`,
    `average ${formatMs(metrics.average)}`,
  ];
  return parts.join(" · ");
}

function buildDetail(entry, metrics) {
  const detail = h("div", "detail");

  const metricRow = h("div", "metrics");
  metricRow.append(
    metricBlock("Latest", formatMs(metrics.current), "", verdict(metrics)),
    metricBlock(
      "vs previous run",
      formatPercent(metrics.deltaVsPrevious),
      trendClass(metrics.deltaVsPrevious),
      metrics.previous === null ? "no previous run" : `previous ${formatMs(metrics.previous)}`,
    ),
    metricBlock(
      "vs best previous",
      formatPercent(metrics.deltaVsBest),
      trendClass(metrics.deltaVsBest),
      metrics.previousBest === null ? "no earlier runs" : `best was ${formatMs(metrics.previousBest)}`,
    ),
    metricBlock(
      "Spread",
      `${formatMs(metrics.min)} – ${formatMs(metrics.max)}`,
      "",
      `average ${formatMs(metrics.average)}`,
    ),
  );
  detail.append(metricRow);
  detail.append(durationChart(entry));

  const steps = stepComparison(entry);
  detail.append(stepBars(steps));

  if (steps.length) {
    const table = h("table", "steps");
    const head = h("thead");
    const headRow = h("tr");
    for (const label of ["Action", "Status", "Latest", "Previous", "Change"]) headRow.append(h("th", null, label));
    head.append(headRow);
    table.append(head);

    const body = h("tbody");
    for (const step of steps) {
      const row = h("tr");
      row.append(h("td", "step-name", step.name));
      const status = h("td");
      status.append(statusPill(step.status));
      row.append(status);
      row.append(h("td", "numeric", formatMs(step.durationMs)));
      row.append(h("td", "numeric", formatMs(step.previousMs)));
      row.append(h("td", `numeric ${trendClass(step.delta)}`, formatPercent(step.delta)));
      body.append(row);
    }
    table.append(body);
    detail.append(table);
  }

  const runs = h("table", "runs");
  const runHead = h("thead");
  const runHeadRow = h("tr");
  for (const label of ["Run", "Finished", "Status", "Duration", "Timeout ratio"])
    runHeadRow.append(h("th", null, label));
  runHead.append(runHeadRow);
  runs.append(runHead);
  const runBody = h("tbody");
  for (const run of entry.runs) {
    const row = h("tr");
    row.append(h("td", "step-name", run.runId));
    row.append(h("td", null, new Date(run.finishedAt).toLocaleString()));
    const status = h("td");
    status.append(statusPill(run.status));
    row.append(status);
    row.append(h("td", "numeric", formatMs(run.durationMs)));
    row.append(h("td", "numeric", run.timeoutRatio === null ? "—" : run.timeoutRatio.toFixed(3)));
    runBody.append(row);
  }
  runs.append(runBody);
  detail.append(runs);

  return detail;
}

function scenarioCard(entry, { expanded }) {
  const metrics = scenarioMetrics(entry);
  const card = h("article", `card status-${metrics.status}`);

  const header = h("header", "card-header");
  const heading = h("div", "card-heading");
  heading.append(h("h3", null, entry.scenario));
  heading.append(h("p", "card-path", `${entry.type} · ${entry.suite} · ${entry.file}`));
  header.append(heading);

  const badges = h("div", "card-badges");
  badges.append(statusPill(metrics.status));
  badges.append(h("span", "pill neutral", formatMs(metrics.current)));
  const change = h("span", `pill ${trendClass(metrics.deltaVsPrevious)}`, formatPercent(metrics.deltaVsPrevious));
  change.title = "Change against the previous run";
  badges.append(change);
  if (metrics.isBest) badges.append(h("span", "pill better", "best yet"));
  if (metrics.isWorst && metrics.runCount > 1) badges.append(h("span", "pill worse", "slowest yet"));
  header.append(badges);
  card.append(header);

  card.append(h("p", "card-verdict", verdict(metrics)));
  card.append(h("p", "card-meta", scenarioSummaryLine(metrics)));

  if (expanded) {
    card.append(buildDetail(entry, metrics));
  } else {
    const toggle = h("button", "toggle", "Show trend and actions");
    toggle.type = "button";
    let detail = null;
    toggle.addEventListener("click", () => {
      if (!detail) {
        // Charts are built on demand so 350 scenarios stay cheap to render.
        detail = buildDetail(entry, metrics);
        card.append(detail);
        toggle.textContent = "Hide trend and actions";
        return;
      }
      const hidden = detail.hasAttribute("hidden");
      detail.toggleAttribute("hidden", !hidden);
      toggle.textContent = hidden ? "Hide trend and actions" : "Show trend and actions";
    });
    card.append(toggle);
  }

  return card;
}

function section(title, subtitle) {
  const node = h("section", "section");
  const header = h("header", "section-header");
  header.append(h("h2", null, title));
  if (subtitle) header.append(h("p", "section-subtitle", subtitle));
  node.append(header);
  return node;
}

function renderHeader(container) {
  const history = state.history;
  const latest = history.runs?.[0];
  const header = h("header", "page-header");

  const title = h("div", "page-title");
  title.append(h("h1", null, "Tactile performance"));
  title.append(
    h(
      "p",
      "page-subtitle",
      latest
        ? `Run ${latest.runId} · ${latest.branch}@${latest.commit} · ${new Date(latest.finishedAt).toLocaleString()}`
        : "No runs recorded yet",
    ),
  );
  header.append(title);

  const controls = h("div", "controls");

  const themeLabel = h("label", "control");
  themeLabel.append(h("span", "control-label", "Theme"));
  const themeSelect = h("select");
  for (const theme of themes) {
    const option = document.createElement("option");
    option.value = theme.id;
    option.textContent = theme.name;
    themeSelect.append(option);
  }
  let storedTheme = null;
  try {
    storedTheme = window.localStorage.getItem("tactile-dashboard-theme");
  } catch {
    /* storage unavailable */
  }
  themeSelect.value = storedTheme || themes[0]?.id;
  themeSelect.addEventListener("change", () => {
    const theme = themes.find((candidate) => candidate.id === themeSelect.value);
    if (theme) applyTheme(theme);
  });
  themeLabel.append(themeSelect);
  controls.append(themeLabel);

  const sourceLabel = h("label", "control control-wide");
  sourceLabel.append(h("span", "control-label", "Results source"));
  const sourceInput = h("input");
  sourceInput.type = "text";
  sourceInput.placeholder = "local, or https://host/path-to-results";
  sourceInput.value = state.source.kind === "local" ? "local" : state.source.base;
  sourceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      state.source = writeSource(sourceInput.value);
      void start();
    }
  });
  sourceLabel.append(sourceInput);
  controls.append(sourceLabel);

  header.append(controls);

  if (latest) {
    const totals = h("div", "totals");
    const entries = [
      ["Scenarios", latest.totals.total, "neutral"],
      ["Passed", latest.totals.pass, "better"],
      ["Failed", latest.totals.fail, latest.totals.fail ? "worse" : "neutral"],
      ["Timed out", latest.totals.timeout, latest.totals.timeout ? "worse" : "neutral"],
      ["Skipped", latest.totals.skipped, "neutral"],
    ];
    for (const [label, value, tone] of entries) totals.append(metricBlock(label, String(value), tone));
    header.append(totals);
  }

  container.append(header);
}

function renderHotTopic(container, entries) {
  const hot = entries.filter(matchesHotTopic);
  const node = section(
    `Hot topic — ${config.hotTopic.title}`,
    `${config.hotTopic.subtitle}. ${hot.length} scenario${hot.length === 1 ? "" : "s"} matched, shown in full.`,
  );
  if (!hot.length) {
    node.append(h("p", "empty", `Nothing matched ${config.hotTopic.match.join(", ")} in the retained runs.`));
  }
  const grid = h("div", "grid");
  for (const entry of hot.sort((a, b) => (b.runs[0]?.durationMs || 0) - (a.runs[0]?.durationMs || 0))) {
    grid.append(scenarioCard(entry, { expanded: true }));
  }
  node.append(grid);
  container.append(node);
}

function renderFailures(container, entries) {
  const failing = entries.filter((entry) => entry.runs[0] && entry.runs[0].status !== "pass");
  const node = section("Failures", failing.length ? "Scenarios whose latest run did not pass." : "");
  if (!failing.length) {
    node.append(h("p", "empty", "Every scenario passed in the latest run."));
  }
  const grid = h("div", "grid");
  for (const entry of failing) grid.append(scenarioCard(entry, { expanded: false }));
  node.append(grid);
  container.append(node);
}

function renderGroups(container, entries) {
  const byType = new Map();
  for (const entry of entries) {
    if (!byType.has(entry.type)) byType.set(entry.type, new Map());
    const suites = byType.get(entry.type);
    if (!suites.has(entry.suite)) suites.set(entry.suite, []);
    suites.get(entry.suite).push(entry);
  }

  const ordered = [...byType.keys()].sort((a, b) => {
    const rank = (type) => (config.timedTypes.includes(type) ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  const node = section("All scenarios", "Grouped by type and suite. Expand a scenario to build its trend chart.");
  for (const type of ordered) {
    const suites = byType.get(type);
    const count = [...suites.values()].reduce((sum, list) => sum + list.length, 0);
    const typeBlock = h("details", "group");
    if (config.timedTypes.includes(type)) typeBlock.open = true;
    const typeSummary = h("summary", null, `${type} — ${count} scenario${count === 1 ? "" : "s"}`);
    typeBlock.append(typeSummary);

    for (const [suite, list] of [...suites.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const suiteBlock = h("details", "group group-suite");
      suiteBlock.append(h("summary", null, `${suite} — ${list.length}`));
      const grid = h("div", "grid");
      for (const entry of list.sort((a, b) => (b.runs[0]?.durationMs || 0) - (a.runs[0]?.durationMs || 0))) {
        grid.append(scenarioCard(entry, { expanded: false }));
      }
      suiteBlock.append(grid);
      typeBlock.append(suiteBlock);
    }
    node.append(typeBlock);
  }
  container.append(node);
}

function renderError(lines) {
  root.replaceChildren();
  const node = h("section", "section");
  node.append(h("h2", null, "No results loaded"));
  for (const line of lines) node.append(h("p", "empty", line));
  root.append(node);
}

async function start() {
  root.replaceChildren(h("p", "empty", "Loading results…"));
  try {
    const { history, summary } = await loadResults(state.source);
    state = { ...state, history, summary };
    const entries = Object.values(history.scenarios || {});
    root.replaceChildren();
    renderHeader(root);
    renderHotTopic(root, entries);
    renderFailures(root, entries);
    renderGroups(root, entries);
  } catch (error) {
    renderError(describeFailure(error, state.source));
  }
}

async function boot() {
  themes = await fetch("./src/themes.json", { cache: "no-store" }).then((response) => response.json());
  let storedTheme = null;
  try {
    storedTheme = window.localStorage.getItem("tactile-dashboard-theme");
  } catch {
    /* storage unavailable */
  }
  applyTheme(themes.find((theme) => theme.id === storedTheme) || themes[0]);
  await start();
}

void boot();
