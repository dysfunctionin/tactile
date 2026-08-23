import { config } from "./config.js";
import { describeFailure, loadResults, readSource, writeSource } from "./data.js";
import { compareBars, durationChart, relativeTrend, stepBars } from "./charts.js";
import { formatMs, formatPercent, scenarioMetrics, stepComparison, trendClass, verdict } from "./metrics.js";

const root = document.querySelector("#app");
let themes = [];
let state = {
  source: readSource(),
  history: null,
  summary: null,
  entries: [],
  latestRunId: null,
  filter: "",
  graphType: null,
};

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

/** A scenario is only current if its newest record came from the latest run. */
function isCurrent(entry) {
  return entry.runs[0]?.runId === state.latestRunId;
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

function stalenessNote(entry) {
  if (isCurrent(entry)) return null;
  const note = h("span", "pill stale", "not in latest run");
  note.title = `Newest record is from run ${entry.runs[0]?.runId}`;
  return note;
}

function scenarioDetail(entry) {
  const metrics = scenarioMetrics(entry);
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
      `average ${formatMs(metrics.average)} over ${metrics.runCount} run${metrics.runCount === 1 ? "" : "s"}`,
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
  for (const label of ["Run", "Finished", "Status", "Duration", "Timeout ratio"]) {
    runHeadRow.append(h("th", null, label));
  }
  runHead.append(runHeadRow);
  runs.append(runHead);
  const runBody = h("tbody");
  for (const run of entry.runs) {
    const row = h("tr", run.runId === state.latestRunId ? "is-latest" : null);
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

function scenarioCard(entry, key, { expanded }) {
  const metrics = scenarioMetrics(entry);
  const card = h("article", `card status-${metrics.status}${isCurrent(entry) ? "" : " is-stale"}`);

  const header = h("header", "card-header");
  const heading = h("div", "card-heading");
  const title = h("h3");
  const link = h("a", "card-link", entry.scenario);
  link.href = `#/scenario/${encodeURIComponent(key)}`;
  title.append(link);
  heading.append(title);
  heading.append(h("p", "card-path", `${entry.type} · ${entry.suite} · ${entry.file}`));
  header.append(heading);

  const badges = h("div", "card-badges");
  badges.append(statusPill(metrics.status));
  badges.append(h("span", "pill neutral", formatMs(metrics.current)));
  const change = h("span", `pill ${trendClass(metrics.deltaVsPrevious)}`, formatPercent(metrics.deltaVsPrevious));
  change.title = "Change against the previous recorded run";
  badges.append(change);
  if (metrics.isBest) badges.append(h("span", "pill better", "best yet"));
  if (metrics.isWorst && metrics.runCount > 1) badges.append(h("span", "pill worse", "slowest yet"));
  const stale = stalenessNote(entry);
  if (stale) badges.append(stale);
  header.append(badges);
  card.append(header);

  card.append(h("p", "card-verdict", verdict(metrics)));

  if (expanded) card.append(scenarioDetail(entry));
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

function buildNavGroups() {
  const container = h("div", "nav-groups");
  const needle = state.filter.trim().toLowerCase();
  const active = decodeURIComponent((window.location.hash.match(/^#\/scenario\/(.+)$/) || [])[1] || "");

  const byType = new Map();
  for (const [key, entry] of state.entries) {
    const haystack = `${entry.type} ${entry.suite} ${entry.scenario}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    if (!byType.has(entry.type)) byType.set(entry.type, new Map());
    const suites = byType.get(entry.type);
    if (!suites.has(entry.suite)) suites.set(entry.suite, []);
    suites.get(entry.suite).push([key, entry]);
  }

  if (!byType.size) {
    container.append(h("p", "nav-empty", "No scenarios match that filter."));
    return container;
  }

  const ordered = [...byType.keys()].sort((a, b) => {
    const rank = (type) => (config.timedTypes.includes(type) ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  for (const type of ordered) {
    const suites = byType.get(type);
    const count = [...suites.values()].reduce((sum, list) => sum + list.length, 0);
    const group = h("details", "nav-group");
    group.open = Boolean(needle) || config.timedTypes.includes(type);
    group.append(h("summary", null, `${type} (${count})`));

    for (const [suite, list] of [...suites.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const suiteBlock = h("div", "nav-suite");
      suiteBlock.append(h("p", "nav-suite-label", suite));
      const sorted = list.sort((a, b) => (b[1].runs[0]?.durationMs || 0) - (a[1].runs[0]?.durationMs || 0));
      for (const [key, entry] of sorted) {
        const link = h("a", "nav-link");
        link.href = `#/scenario/${encodeURIComponent(key)}`;
        if (key === active) link.classList.add("is-active");
        link.append(h("span", `dot status-${entry.runs[0]?.status || "unknown"}`));
        link.append(h("span", "nav-link-text", entry.scenario));
        link.append(h("span", "nav-link-time", formatMs(entry.runs[0]?.durationMs)));
        suiteBlock.append(link);
      }
      group.append(suiteBlock);
    }
    container.append(group);
  }

  return container;
}

function renderSidebar() {
  const aside = h("aside", "sidebar");

  const brand = h("div", "brand");
  brand.append(h("strong", null, "Tactile"));
  brand.append(h("span", "brand-sub", "performance"));
  aside.append(brand);

  const overview = h("a", "nav-home", "Overview");
  overview.href = "#/";
  if (!window.location.hash || window.location.hash === "#/") overview.classList.add("is-active");
  aside.append(overview);

  const graph = h("a", "nav-home", "Scenario graph");
  graph.href = "#/graph";
  if (window.location.hash === "#/graph") graph.classList.add("is-active");
  aside.append(graph);

  const search = h("input", "nav-search");
  search.type = "search";
  search.placeholder = "Filter scenarios";
  search.value = state.filter;
  search.addEventListener("input", () => {
    state.filter = search.value;
    aside.querySelector(".nav-groups").replaceWith(buildNavGroups());
  });
  aside.append(search);
  aside.append(buildNavGroups());

  return aside;
}

function renderControls() {
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

  return controls;
}

function renderOverview(main) {
  const latest = state.history.runs?.[0];
  const header = h("header", "page-header");
  const title = h("div", "page-title");
  title.append(h("h1", null, "Overview"));
  title.append(
    h(
      "p",
      "page-subtitle",
      latest
        ? `Latest run ${latest.runId} · ${latest.branch}@${latest.commit} · ${new Date(latest.finishedAt).toLocaleString()}`
        : "No runs recorded yet",
    ),
  );
  header.append(title);
  header.append(renderControls());

  if (latest) {
    const totals = h("div", "totals");
    for (const [label, value, tone] of [
      ["Scenarios in run", latest.totals.total, "neutral"],
      ["Passed", latest.totals.pass, "better"],
      ["Failed", latest.totals.fail, latest.totals.fail ? "worse" : "neutral"],
      ["Timed out", latest.totals.timeout, latest.totals.timeout ? "worse" : "neutral"],
      ["Retained overall", state.entries.length, "neutral"],
    ]) {
      totals.append(metricBlock(label, String(value), tone));
    }
    header.append(totals);

    const notInRun = state.entries.filter(([, entry]) => !isCurrent(entry)).length;
    if (notInRun) {
      header.append(
        h(
          "p",
          "coverage-note",
          `The latest run covered ${latest.totals.total} of ${state.entries.length} retained scenarios. ` +
            `${notInRun} kept results from an earlier run and are marked "not in latest run".`,
        ),
      );
    }
  }
  main.append(header);

  const hot = state.entries.filter(([, entry]) => matchesHotTopic(entry));
  const hotSection = section(
    `Hot topic — ${config.hotTopic.title}`,
    `${config.hotTopic.subtitle}. ${hot.length} scenario${hot.length === 1 ? "" : "s"} matched, shown in full.`,
  );
  if (!hot.length) {
    hotSection.append(h("p", "empty", `Nothing matched ${config.hotTopic.match.join(", ")} in the retained runs.`));
  }
  const hotGrid = h("div", "grid");
  const hotSorted = hot.sort((a, b) => (b[1].runs[0]?.durationMs || 0) - (a[1].runs[0]?.durationMs || 0));
  for (const [key, entry] of hotSorted) hotGrid.append(scenarioCard(entry, key, { expanded: true }));
  hotSection.append(hotGrid);
  main.append(hotSection);

  const failingNow = state.entries.filter(([, entry]) => isCurrent(entry) && entry.runs[0].status !== "pass");
  const failingEarlier = state.entries.filter(([, entry]) => !isCurrent(entry) && entry.runs[0].status !== "pass");

  const failSection = section(
    "Failures",
    "Separated by whether the failure comes from the latest run or from an earlier run that has not been repeated.",
  );
  failSection.append(h("h3", "sub-heading", `Failing in the latest run (${failingNow.length})`));
  if (!failingNow.length) failSection.append(h("p", "empty", "Nothing failed in the latest run."));
  const nowGrid = h("div", "grid");
  for (const [key, entry] of failingNow) nowGrid.append(scenarioCard(entry, key, { expanded: false }));
  failSection.append(nowGrid);

  failSection.append(h("h3", "sub-heading", `Failing when last run (${failingEarlier.length})`));
  if (!failingEarlier.length) failSection.append(h("p", "empty", "No stale failures."));
  const earlierGrid = h("div", "grid");
  for (const [key, entry] of failingEarlier) earlierGrid.append(scenarioCard(entry, key, { expanded: false }));
  failSection.append(earlierGrid);

  main.append(failSection);
}

function renderScenario(main, key) {
  const found = state.entries.find(([candidate]) => candidate === key);
  if (!found) {
    const missing = section("Scenario not found", "It may have been renamed, or dropped out of the retained runs.");
    const back = h("a", "toggle", "Back to overview");
    back.href = "#/";
    missing.append(back);
    main.append(missing);
    return;
  }

  const [, entry] = found;
  const metrics = scenarioMetrics(entry);

  const header = h("header", "page-header");
  const title = h("div", "page-title");
  const crumb = h("p", "breadcrumb");
  const back = h("a", null, "Overview");
  back.href = "#/";
  crumb.append(back, document.createTextNode(` / ${entry.type} / ${entry.suite}`));
  title.append(crumb);
  title.append(h("h1", null, entry.scenario));
  title.append(h("p", "page-subtitle", entry.file));
  header.append(title);
  header.append(renderControls());

  const badges = h("div", "card-badges");
  badges.append(statusPill(metrics.status));
  if (metrics.isBest) badges.append(h("span", "pill better", "best yet"));
  if (metrics.isWorst && metrics.runCount > 1) badges.append(h("span", "pill worse", "slowest yet"));
  const stale = stalenessNote(entry);
  if (stale) badges.append(stale);
  header.append(badges);
  header.append(h("p", "card-verdict", verdict(metrics)));
  main.append(header);

  const detailSection = section("Latency detail", "Every retained run, with per-action timings where recorded.");
  detailSection.append(scenarioDetail(entry));
  main.append(detailSection);
}

function renderGraph(main) {
  const header = h("header", "page-header");
  const title = h("div", "page-title");
  title.append(h("h1", null, "Scenario graph"));
  title.append(
    h("p", "page-subtitle", "Compare scenarios against each other and watch them move across the retained runs."),
  );
  header.append(title);
  header.append(renderControls());
  main.append(header);

  const types = [...new Set(state.entries.map(([, entry]) => entry.type))].sort();
  const filters = h("div", "graph-filters");
  const allButton = h("button", `chip${state.graphType ? "" : " is-active"}`, "all types");
  allButton.type = "button";
  allButton.addEventListener("click", () => {
    state.graphType = null;
    route();
  });
  filters.append(allButton);
  for (const type of types) {
    const chip = h("button", `chip${state.graphType === type ? " is-active" : ""}`, type);
    chip.type = "button";
    chip.addEventListener("click", () => {
      state.graphType = type;
      route();
    });
    filters.append(chip);
  }
  main.append(filters);

  const scoped = state.graphType ? state.entries.filter(([, entry]) => entry.type === state.graphType) : state.entries;

  const compare = section(
    "Cost comparison",
    `${scoped.length} scenario${scoped.length === 1 ? "" : "s"} in scope. Bars show the most recent duration for each, with the change against its previous run.`,
  );
  compare.append(compareBars(scoped));
  main.append(compare);

  const trend = section(
    "Movement across runs",
    "Each line is indexed to that scenario's oldest retained run, so scenarios of very different cost can be compared on one axis. Above 100% is slower than its baseline.",
  );
  trend.append(relativeTrend(scoped));
  main.append(trend);
}

function route() {
  if (!state.history) return;
  root.replaceChildren();
  root.append(renderSidebar());
  const main = h("main", "content");
  const match = window.location.hash.match(/^#\/scenario\/(.+)$/);
  if (match) renderScenario(main, decodeURIComponent(match[1]));
  else if (window.location.hash === "#/graph") renderGraph(main);
  else renderOverview(main);
  root.append(main);
  window.scrollTo(0, 0);
}

function renderError(lines) {
  root.replaceChildren();
  const node = h("main", "content");
  const block = section("No results loaded");
  for (const line of lines) block.append(h("p", "empty", line));
  node.append(block);
  root.append(node);
}

async function start() {
  root.replaceChildren(h("p", "empty", "Loading results…"));
  try {
    const { history, summary } = await loadResults(state.source);
    state = {
      ...state,
      history,
      summary,
      latestRunId: history.runs?.[0]?.runId ?? null,
      entries: Object.entries(history.scenarios || {}),
    };
    route();
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
  window.addEventListener("hashchange", route);
  await start();
}

void boot();
