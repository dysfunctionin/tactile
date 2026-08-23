import { createBlankWorkspace, createMarkdownObject } from "../../src/core/workspace/model.js";
import { defineScenarioSetup } from "../harness/scenario-setup.mjs";

import { buildSheet, cellAddress, scenarioCounts } from "./workspace-factory.mjs";

/**
 * Stress scenario for very large sheets.
 *
 * Formulas occupy the trailing column band and reference only columns A-E, so a
 * dependent edit stays bounded and an edit outside that band evaluates nothing.
 */
export const LARGE_SHEET_SPEC = Object.freeze({
  workspaceId: "stress-large-workspace",
  rootSheetId: "stress-root-sheet",
  rootRows: 500,
  rootColumns: 200,
  firstFormulaColumn: 150,
  formulaCount: 25_000,
  supportingSheetCount: 5,
  supportingSheetRows: 300,
  supportingSheetColumns: 100,
  markdownObjectCount: 94,
  usedCellCount: 250_000,
  objectCount: 100,
});

function rootFill(row, column) {
  const line = row + 1;
  if (column < LARGE_SHEET_SPEC.firstFormulaColumn) {
    if (column === 0) return { value: `Row-${String(line).padStart(4, "0")}` };
    return { value: String(((row * 31 + column * 7) % 997) + 1) };
  }
  switch ((column - LARGE_SHEET_SPEC.firstFormulaColumn) % 5) {
    case 0:
      return { formula: `=A${line}+1` };
    case 1:
      return { formula: `=B${line}*2` };
    case 2:
      return { formula: `=SUM(A${line}:E${line})` };
    case 3:
      return { formula: `=IF(B${line}>0,A${line},0)` };
    default:
      return { formula: `=AVERAGE(A${line}:C${line})` };
  }
}

export function createLargeWorkspace() {
  const workspace = createBlankWorkspace({ id: LARGE_SHEET_SPEC.workspaceId, name: "Large sheet stress" });
  delete workspace.objects.home;

  const root = buildSheet({
    id: LARGE_SHEET_SPEC.rootSheetId,
    title: "Stress root",
    rows: LARGE_SHEET_SPEC.rootRows,
    columns: LARGE_SHEET_SPEC.rootColumns,
    fill: rootFill,
  });
  workspace.objects[root.sheet.id] = root.sheet;
  workspace.homeObjectId = root.sheet.id;

  for (let index = 0; index < LARGE_SHEET_SPEC.supportingSheetCount; index += 1) {
    const support = buildSheet({
      id: `stress-support-${index + 1}`,
      title: `Support ${index + 1}`,
      rows: LARGE_SHEET_SPEC.supportingSheetRows,
      columns: LARGE_SHEET_SPEC.supportingSheetColumns,
      fill: (row, column) => ({ value: String(((row * 17 + column * 13 + index) % 499) + 1) }),
    });
    workspace.objects[support.sheet.id] = support.sheet;
  }

  for (let index = 0; index < LARGE_SHEET_SPEC.markdownObjectCount; index += 1) {
    const note = createMarkdownObject({
      id: `stress-note-${index + 1}`,
      title: `Note ${index + 1}`,
      text: `# Note ${index + 1}\n\n${"Stress paragraph. ".repeat(120)}`,
    });
    workspace.objects[note.id] = note;
  }

  return workspace;
}

export const largeSheet = defineScenarioSetup({
  id: "large-sheet",
  label: "250k-cell stress workspace across 100 objects",
  profile: "large",
  materialize() {
    const workspace = createLargeWorkspace();
    return {
      workspace,
      spec: LARGE_SHEET_SPEC,
      rootSheet: workspace.objects[LARGE_SHEET_SPEC.rootSheetId],
      // Column B feeds the formula band; column G is referenced by nothing.
      boundedEditAddress: cellAddress(LARGE_SHEET_SPEC.rootRows - 1, 1),
      isolatedEditAddress: cellAddress(LARGE_SHEET_SPEC.rootRows - 1, 6),
      counts: scenarioCounts(workspace),
    };
  },
});
