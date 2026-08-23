/**
 * Dashboard configuration.
 *
 * `hotTopic.match` decides which scenarios are promoted to the detailed section
 * at the top. Change it when the thing you are optimising changes; everything
 * else stays available further down behind an expander.
 */
export const config = {
  resultsBase: "/test-results",

  hotTopic: {
    title: "250k-cell workspace",
    subtitle: "Interaction and engine latency on the large sheet stress workspace",
    // Matched case-insensitively against scenario, suite, type and file.
    match: ["250k", "large-sheet"],
  },

  // Scenario types shown before the rest, since these carry the latency signal.
  timedTypes: ["e2e", "performance"],

  // A run slower than the previous by more than this is called out as a regression.
  regressionPercent: 5,
};
