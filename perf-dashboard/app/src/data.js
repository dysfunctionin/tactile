async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return response.json();
}

export async function loadManifest() {
  return fetchJson("./data/runs.json");
}

export async function loadRun(run) {
  return fetchJson(`./data/${run.file}`);
}
