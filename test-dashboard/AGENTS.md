# Dashboard subtree instructions

These rules apply under `test-dashboard/` in addition to root guidance.

## What this is

A static page that reads Tactile test results and charts scenario latency over the retained runs. It exists to answer
"what got slower, and which action caused it" without opening a JSON file.

## Hard constraints

- **No dependencies.** `package.json` has no `dependencies` block and must keep it that way. Charts are hand-written
  SVG; the server is `node:http`. Do not reach for a framework or chart library.
- **No imports from `src/`.** The dashboard must stay liftable into its own repository. Theme tokens are vendored to
  `src/themes.json` by `npm run dashboard:sync-themes`; re-run it when the app palette changes.
- **Read-only.** It consumes `history.json` and `summary.json` and never writes results.

## Layout

| Path              | Holds                                                            |
| ----------------- | ---------------------------------------------------------------- |
| `serve.mjs`       | Zero-dependency static server (`npm run dashboard`, port 4300)   |
| `src/config.js`   | Hot topic, timed types, regression threshold                     |
| `src/data.js`     | Source resolution and fetching, local or remote                  |
| `src/metrics.js`  | Comparison maths and all formatting                              |
| `src/charts.js`   | SVG charts: per-scenario trend, compare bars, multi-series trend |
| `src/app.js`      | Routing and rendering                                            |
| `src/themes.json` | Generated; do not hand-edit                                      |

## Conventions

- Durations are always milliseconds. `formatMs` never switches to seconds, because mixed units in a column are easy to
  misread. Route every duration through it.
- Absolute durations span microseconds to minutes, so any chart comparing scenarios to each other must normalize;
  `relativeTrend` indexes each series to its own oldest retained run.
- A scenario whose newest record predates the latest run is stale. Mark it rather than counting it as current, and keep
  run-scoped totals separate from retained-scenario totals.
- Charts for collapsed scenarios are built on expand; with hundreds of scenarios, eager rendering is noticeable.

## Routes

`#/` overview, `#/graph` cross-scenario comparison, `#/scenario/<type>|<suite>|<name>` detail.

## Verifying a change

There are no tests here. Load the page in a browser and confirm it renders, since DOM assertions pass happily while the
paint is wrong; a CSS specificity bug once left every trend line the same colour with correct markup underneath.
