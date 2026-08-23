import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILT_IN_THEMES } from "../../src/core/workspace/themes.js";

/**
 * Vendors the app's palette into the dashboard as plain data.
 *
 * The dashboard reads the generated JSON, never `src/`, so it can be lifted
 * into its own repository without carrying an import back into Tactile.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "src", "themes.json");

const themes = BUILT_IN_THEMES.map(({ id, name, description, tokens }) => ({
  id,
  name,
  description,
  colorScheme: tokens.colorScheme === "dark" ? "dark" : "light",
  tokens: {
    paper: tokens.paper,
    paperElevated: tokens.paperElevated,
    ink: tokens.ink,
    defaultInk: tokens.defaultInk,
    accent: tokens.accent,
    accentSoft: tokens.accentSoft,
    line: tokens.line,
    lineStrong: tokens.lineStrong,
    elevationShadow: tokens.elevationShadow,
    surfaceHighlight: tokens.surfaceHighlight,
  },
}));

await writeFile(target, `${JSON.stringify(themes, null, 2)}\n`, "utf8");
console.log(`wrote ${themes.length} themes to ${path.relative(process.cwd(), target)}`);
