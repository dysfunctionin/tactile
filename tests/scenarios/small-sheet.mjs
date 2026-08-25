import { createBlankWorkspace, createMarkdownObject } from "../../src/core/workspace/model.js";
import { defineScenarioSetup } from "../harness/scenario-setup.mjs";

import { buildSheet, scenarioCounts } from "./workspace-factory.mjs";

/** Everyday, human-scale workspace: a handful of sheets and notes. */
export const SMALL_SHEET_SPEC = Object.freeze({
  workspaceId: "small-sheet-workspace",
  rootSheetId: "small-root-sheet",
  rootRows: 60,
  rootColumns: 14,
  firstFormulaColumn: 10,
  supportingSheetCount: 3,
  supportingSheetRows: 48,
  supportingSheetColumns: 12,
  markdownObjectCount: 6,
});

function rootFill(row, column) {
  const line = row + 1;
  if (column === 0) return { value: `Item-${String(row % 24).padStart(2, "0")}` };
  if (column < SMALL_SHEET_SPEC.firstFormulaColumn) return { value: String(((row * 13 + column * 5) % 89) + 1) };
  return (column - SMALL_SHEET_SPEC.firstFormulaColumn) % 2 === 0
    ? { formula: `=B${line}+C${line}` }
    : { formula: `=SUM(B${line}:E${line})` };
}

export function createSmallWorkspace() {
  const workspace = createBlankWorkspace({ id: SMALL_SHEET_SPEC.workspaceId, name: "Small sheet" });
  delete workspace.objects.home;

  const root = buildSheet({
    id: SMALL_SHEET_SPEC.rootSheetId,
    title: "Small root",
    rows: SMALL_SHEET_SPEC.rootRows,
    columns: SMALL_SHEET_SPEC.rootColumns,
    fill: rootFill,
  });
  workspace.objects[root.sheet.id] = root.sheet;
  workspace.homeObjectId = root.sheet.id;

  for (let index = 0; index < SMALL_SHEET_SPEC.supportingSheetCount; index += 1) {
    const support = buildSheet({
      id: `small-support-${index + 1}`,
      title: `Support ${index + 1}`,
      rows: SMALL_SHEET_SPEC.supportingSheetRows,
      columns: SMALL_SHEET_SPEC.supportingSheetColumns,
      fill: (row, column) => ({ value: String(((row * 7 + column * 3 + index) % 61) + 1) }),
    });
    workspace.objects[support.sheet.id] = support.sheet;
  }

  for (let index = 0; index < SMALL_SHEET_SPEC.markdownObjectCount; index += 1) {
    const note = createMarkdownObject({
      id: `small-note-${index + 1}`,
      title: `Note ${index + 1}`,
      text: `# Note ${index + 1}\n\nShort note body.`,
    });
    workspace.objects[note.id] = note;
  }

  return workspace;
}

export const smallSheet = defineScenarioSetup({
  id: "small-sheet",
  label: "small workspace with sheets and notes",
  profile: "small",
  materialize() {
    const workspace = createSmallWorkspace();
    return {
      workspace,
      spec: SMALL_SHEET_SPEC,
      rootSheet: workspace.objects[SMALL_SHEET_SPEC.rootSheetId],
      counts: scenarioCounts(workspace),
    };
  },
});

/** Same workspace written to disk, for tests that import it through the app. */
export const smallSheetFile = defineScenarioSetup({
  id: "small-sheet-file",
  label: "small workspace written to disk",
  profile: "small",
  async materialize({ artifactDir, ensureArtifactDir }) {
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await ensureArtifactDir();
    const artifactPath = path.join(artifactDir, "workspace.json");
    await writeFile(artifactPath, JSON.stringify(createSmallWorkspace()), "utf8");

    const workspace = createSmallWorkspace();
    return { artifactPath, spec: SMALL_SHEET_SPEC, counts: scenarioCounts(workspace) };
  },
});
