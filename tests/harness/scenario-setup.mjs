import { mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { RESULTS_DIR, repoRelative } from "./writer.mjs";
import { roundMs } from "./schema.mjs";

const ARTIFACT_ROOT = path.join(RESULTS_DIR, "scenarios");

/**
 * Scenario setup template.
 *
 * `materialize` builds the situation a test needs and returns the context the
 * test body receives. Anything it returns under `artifacts` is summarized into
 * the result record so a dashboard can tell which fixture a run used.
 */
export function defineScenarioSetup({ id, label, profile = null, materialize, teardown = null }) {
  if (typeof id !== "string" || !id) throw new TypeError("Scenario setup requires an id");
  if (typeof materialize !== "function") throw new TypeError(`Scenario setup "${id}" requires materialize()`);

  return Object.freeze({
    id,
    label: label || id,
    profile,
    async run() {
      const artifactDir = path.join(ARTIFACT_ROOT, id);
      const started = performance.now();
      const context = (await materialize({ artifactDir, ensureArtifactDir: () => ensureDir(artifactDir) })) || {};
      const durationMs = roundMs(performance.now() - started);
      return {
        context,
        summary: {
          id,
          label: label || id,
          profile,
          durationMs,
          artifactPath: context.artifactPath ? repoRelative(context.artifactPath) : null,
          fingerprint: context.fingerprint || null,
          counts: context.counts || null,
        },
      };
    },
    teardown,
  });
}

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
  return directory;
}
