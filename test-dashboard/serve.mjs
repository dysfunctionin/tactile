import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Zero-dependency static server.
 *
 * Serves the dashboard plus the results directory it reads. Point
 * TACTILE_RESULTS_ROOT elsewhere to run the dashboard against another checkout.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.TACTILE_RESULTS_ROOT
  ? path.resolve(process.env.TACTILE_RESULTS_ROOT)
  : path.resolve(here, "..");
const port = Number(process.env.PORT || 4300);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  let relative = decodeURIComponent(url.pathname);
  if (relative === "/") relative = "/test-dashboard/index.html";
  if (relative.endsWith("/")) relative += "index.html";

  const resolved = path.resolve(repoRoot, `.${relative}`);
  if (!resolved.startsWith(repoRoot)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": TYPES[path.extname(resolved)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(resolved).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end(`not found: ${relative}`);
  }
});

server.listen(port, () => {
  console.log(`Tactile test dashboard: http://127.0.0.1:${port}/test-dashboard/`);
  console.log(`serving from ${repoRoot}`);
});
