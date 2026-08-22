import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildPortablePackage } from "../../src/export.js";
import { createLowStressWorkspace } from "./profiles.mjs";
import { createPerformanceWorkspace } from "../generate-fixture.mjs";

async function writeFolder(workspace, outDir) {
  const pkg = buildPortablePackage(workspace);
  // The native app's workspace_write_snapshot writes the FULL workspace as workspace.json
  // (compact JSON), with side files as mirrors. buildPortablePackage's workspace.json is
  // the *index* — overwrite it with the full workspace so the folder is actually loadable.
  pkg.files["workspace.json"] = JSON.stringify(workspace);
  for (const [relativePath, contents] of Object.entries(pkg.files)) {
    const filePath = path.join(outDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    if (contents && typeof contents === "object" && contents.dataUrl) {
      const match = /^data:.*?;base64,(.*)$/.exec(String(contents.dataUrl));
      const buffer = Buffer.from(match ? match[1] : "", "base64");
      await writeFile(filePath, buffer);
    } else {
      await writeFile(filePath, String(contents ?? ""), "utf8");
    }
  }
  console.log(`Wrote ${Object.keys(pkg.files).length} files to ${outDir}`);
  console.log(`  workspace.json (full, ${Math.round(JSON.stringify(workspace).length / 1024)} KB) + ${Object.keys(pkg.files).filter((p) => p.startsWith("objects/")).length} object files`);
}

const lowOut = path.resolve("benchmarks/.generated/native-workspaces/low");
const highOut = path.resolve("benchmarks/.generated/native-workspaces/high");

await writeFolder(createLowStressWorkspace(), lowOut);
await writeFolder(createPerformanceWorkspace(), highOut);

console.log(`\nLow  folder: ${lowOut}`);
console.log(`High folder: ${highOut}`);
console.log("\nPoint your native app's Source Folder to one of these paths (Settings → Workspace Folder).");
