import { formatMs, formatPercent, scenarioMetrics, stepComparison, verdict } from "./metrics.js";

export function cleanDiagnostic(value) {
  return value ? String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") : "";
}

function cell(value) {
  return String(value ?? "—")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function table(headers, rows) {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function latestResult(summary, entry) {
  return summary?.results?.find(
    (record) =>
      record.runId === entry.runs[0]?.runId &&
      record.type === entry.type &&
      record.suite === entry.suite &&
      record.scenario === entry.scenario,
  );
}

export function createAgentContext(entry, summary) {
  const metrics = scenarioMetrics(entry);
  const steps = stepComparison(entry);
  const result = latestResult(summary, entry);
  const errorsByRun = entry.runs
    .map((run, index) => ({ run, error: run.error || (index === 0 ? result?.error : null) }))
    .filter(({ error }) => error);
  const lines = [
    "# Tactile test scenario context",
    "",
    "> Use this as factual evidence for the accompanying request. Durations are milliseconds and lower is better. Retained runs are newest first. Do not treat a timing difference as causal without supporting evidence.",
    "",
    "## Scenario",
    `- **Name:** ${entry.scenario}`,
    `- **Type / suite:** ${entry.type} / ${entry.suite}`,
    `- **Source:** ${entry.file}`,
    `- **Latest status:** ${metrics.status}`,
    `- **Assessment:** ${verdict(metrics)}`,
    "",
    "## Performance summary",
    `- **Latest:** ${formatMs(metrics.current)}`,
    `- **Previous:** ${formatMs(metrics.previous)}`,
    `- **Change vs previous:** ${formatPercent(metrics.deltaVsPrevious)}`,
    `- **Best previous:** ${formatMs(metrics.previousBest)}`,
    `- **Change vs best previous:** ${formatPercent(metrics.deltaVsBest)}`,
    `- **Retained range:** ${formatMs(metrics.min)} to ${formatMs(metrics.max)}`,
    `- **Retained average:** ${formatMs(metrics.average)} across ${metrics.runCount} run${metrics.runCount === 1 ? "" : "s"}`,
    "",
    "## Latest recorded actions",
  ];

  if (steps.length) {
    lines.push(
      table(
        ["Action", "Status", "Latest", "Previous", "Change"],
        steps.map((step) => [
          step.name,
          step.status,
          formatMs(step.durationMs),
          formatMs(step.previousMs),
          formatPercent(step.delta),
        ]),
      ),
    );
  } else {
    lines.push("No individual actions were recorded.");
  }

  if (metrics.status !== "pass") {
    lines.push(
      "",
      "Recorded actions are instrumentation, not the final verdict. They can all pass before a later assertion or uninstrumented operation fails the scenario.",
    );
  }

  lines.push(
    "",
    "## Retained runs",
    table(
      ["Run", "Finished (UTC)", "Status", "Cause", "Duration", "Timeout ratio"],
      entry.runs.map((run) => [
        run.runId,
        new Date(run.finishedAt).toISOString(),
        run.status,
        cleanDiagnostic(run.error?.message).split(/\r?\n/).find(Boolean) ||
          (run.status === "pass" ? "—" : "not retained"),
        formatMs(run.durationMs),
        Number.isFinite(run.timeoutRatio) ? run.timeoutRatio.toFixed(3) : "—",
      ]),
    ),
  );

  if (errorsByRun.length) {
    lines.push("", "## Failure causes by run");
    for (const { run, error: runError } of errorsByRun) {
      const errorText = [runError.failureType, runError.message, runError.stack]
        .filter(Boolean)
        .join("\n")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .replaceAll("```", "''' ");
      lines.push("", `### ${run.runId}`, "```text", errorText, "```");
    }
  }

  lines.push(
    "",
    "## Analysis guidance",
    "Answer the accompanying request using this evidence. Separate confirmed facts from hypotheses, call out insufficient evidence, and point to the source file or a focused test when proposing a change.",
  );

  return lines.join("\n");
}
