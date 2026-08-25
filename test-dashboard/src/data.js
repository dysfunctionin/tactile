import { config } from "./config.js";

const STORAGE_KEY = "tactile-dashboard-source";
const FILES = { history: "history.json", summary: "summary.json" };

/**
 * Result sources.
 *
 * "local" reads the checkout this page is served from. "remote" reads any base
 * URL that serves the same two files and allows cross-origin reads, such as a
 * raw file host, GitHub Pages, or an object store.
 */
export function readSource() {
  const fromQuery = new URL(window.location.href).searchParams.get("source");
  if (fromQuery) return normalize(fromQuery);
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return normalize(stored);
  } catch {
    /* storage unavailable, fall through to local */
  }
  return { kind: "local", base: config.resultsBase, label: "Local run" };
}

export function writeSource(value) {
  const source = normalize(value);
  try {
    if (source.kind === "local") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, source.base);
  } catch {
    /* storage unavailable; the source still applies for this page load */
  }
  return source;
}

function normalize(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "local") return { kind: "local", base: config.resultsBase, label: "Local run" };
  // A link straight to history.json still identifies the directory holding it.
  const base = trimmed.replace(/\/(history|summary)\.json$/i, "").replace(/\/$/, "");
  return { kind: "remote", base, label: base };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

export async function loadResults(source) {
  const base = source.base.replace(/\/$/, "");
  const [history, summary] = await Promise.all([
    fetchJson(`${base}/${FILES.history}`),
    fetchJson(`${base}/${FILES.summary}`).catch(() => null),
  ]);
  return { history, summary, source };
}

export function describeFailure(error, source) {
  const detail = String(error?.message || error);
  if (source.kind === "local") {
    return ["Could not read local results.", "Run a suite first, for example npm test, then reload.", detail];
  }
  return [
    "Could not read results from that URL.",
    "The host must serve history.json and summary.json and allow cross-origin reads.",
    "GitHub Actions artifacts are authenticated zip downloads and cannot be fetched directly; publish the JSON to a raw file host or Pages instead.",
    detail,
  ];
}
