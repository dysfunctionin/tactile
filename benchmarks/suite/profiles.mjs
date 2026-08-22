import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createPerformanceWorkspace,
  fixtureFingerprint,
  validatePerformanceWorkspace,
  writePerformanceFixture,
} from "../generate-fixture.mjs";

const TIMESTAMP = "2026-08-11T00:00:00.000Z";

export const LOW_STRESS_SPEC = Object.freeze({
  workspaceId: "perf-low-workspace",
  name: "Tactile Perf Low Stress",
  rootSheetId: "low-root-sheet",
  rootRows: 60,
  rootColumns: 14,
  layerRows: 48,
  layerColumns: 12,
  supportRows: 80,
  supportColumns: 10,
  markdownObjectCount: 46,
  targetObjectCount: 70,
});

function columnLabel(index) {
  let current = index + 1;
  let label = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

function cellId(row, column) {
  return `r${row + 1}c${column + 1}`;
}

function cellAddress(row, column) {
  return `${columnLabel(column)}${row + 1}`;
}

function makeCell(row, column, patch = {}) {
  return {
    id: cellId(row, column),
    address: cellAddress(row, column),
    row,
    column,
    value: "",
    formula: "",
    embed: null,
    ...patch,
  };
}

function lowValue(row, column) {
  if (column === 0) return `Item-${String(row % 24).padStart(2, "0")}`;
  if (column >= 1 && column <= 4) return String(((row + 1) * (column + 2)) % 120);
  if (column === 5) return row % 3 === 0 ? "active" : row % 3 === 1 ? "queued" : "review";
  if (column === 6) return `Owner-${(row + 3) % 7}`;
  if (column === 13) return ""; // keep N-column sparse so M9 edit stays predictable
  return `L R${row + 1}C${column + 1}`;
}

function makeLowSheet({ id, title, rows, columns, sheetIndex, embedAt, formulas = true }) {
  const cells = {};
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const embed = embedAt?.(row, column) || null;
      const formula =
        formulas && !embed && column === 7
          ? `=SUM(B${row + 1}:E${row + 1})`
          : "";
      const style =
        row === 0
          ? { bold: true, align: column === 0 ? "left" : "center" }
          : undefined;
      const cell = makeCell(row, column, {
        value: embed ? "" : lowValue(row, column),
        formula,
        embed: embed ? { objectId: embed.objectId, type: embed.type } : null,
        ...(style ? { style } : {}),
      });
      if (row === 0) cell.role = "heading";
      else if (column === 0) cell.role = "label";
      cells[cell.id] = cell;
    }
  }
  return {
    id,
    type: "sheet",
    title,
    description: `Low-stress deterministic sheet ${title}.`,
    rows,
    columns,
    cells,
    rowHeight: 28,
    columnWidth: 118,
    rowHeights: { 4: 34, 17: 40 },
    columnWidths: { 1: 140, 6: 132 },
    rowGroups: [{ id: `${id}-rows-a`, start: 5, end: 9, collapsed: false }],
    columnGroups: [{ id: `${id}-cols-a`, start: 1, end: 4, collapsed: false }],
    conditionalFormats: [
      { id: `${id}-cf-1`, range: `B2:E${Math.min(rows, 30)}`, kind: "sign" },
      { id: `${id}-cf-2`, range: `G2:G${Math.min(rows, 40)}`, kind: "sign" },
    ],
    filters: [{ id: `${id}-filter-status`, column: 5, value: "active" }],
    frozenRows: 1,
    frozenColumns: 1,
  };
}

export function createLowStressWorkspace() {
  const objects = {};
  const spec = LOW_STRESS_SPEC;
  const layerIds = ["low-layer-1", "low-layer-2", "low-layer-3", "low-layer-4"];
  const markdownId = "low-markdown-notes";

  objects[spec.rootSheetId] = makeLowSheet({
    id: spec.rootSheetId,
    title: "Low stress root",
    rows: spec.rootRows,
    columns: spec.rootColumns,
    sheetIndex: 0,
    embedAt: (row, column) => {
      if (row === 0 && column === 0)
        return { type: "sheet", objectId: layerIds[0], title: "Layer one" };
      if (row === 1 && column === 1)
        return { type: "markdown", objectId: markdownId, title: "Notes document" };
      return null;
    },
  });

  layerIds.forEach((id, index) => {
    objects[id] = makeLowSheet({
      id,
      title: `Layer ${index + 1}`,
      rows: spec.layerRows,
      columns: spec.layerColumns,
      sheetIndex: index + 1,
      embedAt:
        index < layerIds.length - 1
          ? (row, column) =>
              row === 0 && column === 0
                ? { type: "sheet", objectId: layerIds[index + 1], title: `Layer ${index + 2}` }
                : null
          : null,
    });
  });

  const supportId = "low-support-sheet";
  objects[supportId] = makeLowSheet({
    id: supportId,
    title: "Support data",
    rows: spec.supportRows,
    columns: spec.supportColumns,
    sheetIndex: 9,
    embedAt: (row, column) =>
      row === 0 && column === 0
        ? { type: "markdown", objectId: markdownId, title: "Notes document" }
        : null,
  });

  objects[markdownId] = {
    id: markdownId,
    type: "markdown",
    title: "Notes document",
    description: "Shared markdown notes object.",
    content: [
      "# Notes",
      "",
      "Deterministic low-stress markdown payload with a table and list.",
      "",
      "| Key | Value |",
      "| --- | ----- |",
      ...Array.from({ length: 12 }, (_, i) => `| key-${i} | ${i * 7} |`),
      "",
      "- item one\n- item two\n- item three",
    ].join("\n"),
  };

  for (let index = 0; index < spec.markdownObjectCount; index += 1) {
    const id = `low-text-${String(index + 1).padStart(3, "0")}`;
    objects[id] = {
      id,
      type: "markdown",
      title: `Text ${String(index + 1).padStart(3, "0")}`,
      description: "Small deterministic text object.",
      content: `## Text ${index + 1}\n\nLocal low-stress fixture object ${index + 1}. A short paragraph of filler text.\n`,
    };
  }

  let serial = 1;
  while (Object.keys(objects).length < spec.targetObjectCount) {
    const id = `low-extra-${String(serial).padStart(2, "0")}`;
    objects[id] = makeLowSheet({
      id,
      title: `Tracker ${String(serial).padStart(2, "0")}`,
      rows: 24,
      columns: 8,
      sheetIndex: 20 + serial,
      formulas: false,
    });
    serial += 1;
  }

  return {
    format: "tactile",
    version: 4,
    id: spec.workspaceId,
    name: spec.name,
    homeObjectId: spec.rootSheetId,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    objects,
    assets: {},
    themes: {},
    activeThemeId: "paper-public",
    settings: { reduceMotion: false, openSingleClick: "floating", openDoubleClick: "full" },
  };
}

export function validateLowStressWorkspace(workspace) {
  const sheetObjects = Object.values(workspace?.objects || {}).filter((o) => o.type === "sheet");
  const usedCells = Object.values(workspace?.objects || {}).reduce(
    (total, object) => (object.type !== "sheet" ? total : total + Object.values(object.cells || {}).length),
    0,
  );
  const checks = {
    format: workspace?.format === "tactile",
    version: workspace?.version === 4,
    objectCountInRange:
      Object.keys(workspace?.objects || {}).length >= 50 &&
      Object.keys(workspace?.objects || {}).length <= 100,
    hasRoot: Boolean(workspace?.objects?.[LOW_STRESS_SPEC.rootSheetId]),
    sheetCount: sheetObjects.length >= 8,
    usedCellsInRange: usedCells >= 1500 && usedCells <= 12000,
    nesting: layerIdsEmbedded(workspace),
  };
  return {
    valid: Object.values(checks).every(Boolean),
    checks,
    counts: {
      objects: Object.keys(workspace?.objects || {}).length,
      sheets: sheetObjects.length,
      usedCells,
    },
  };
}

function layerIdsEmbedded(workspace) {
  const rootCells = Object.values(workspace?.objects?.["low-root-sheet"]?.cells || {});
  return rootCells.some((cell) => cell.embed?.objectId === "low-layer-1");
}

export function profileFingerprint(profile, workspace) {
  return profile === "high"
    ? fixtureFingerprint(workspace)
    : fixtureFingerprint(workspace);
}

export async function writeProfileFixture(profile, outputDir) {
  await mkdir(outputDir, { recursive: true });
  if (profile === "high") {
    const generated = await writePerformanceFixture({ outputDir, writeAssets: false });
    return {
      profile,
      path: path.join(generated.outputDir, "fixture.json"),
      workspace: generated.workspace,
      fingerprint: generated.manifest.workspaceFingerprint,
      validation: generated.manifest.validation,
    };
  }
  const workspace = createLowStressWorkspace();
  const validation = validateLowStressWorkspace(workspace);
  if (!validation.valid) {
    throw new Error(`Low-stress fixture failed validation: ${JSON.stringify(validation.checks)}`);
  }
  const fixturePath = path.join(outputDir, "fixture.json");
  await writeFile(fixturePath, JSON.stringify(workspace), "utf8");
  return {
    profile,
    path: fixturePath,
    workspace,
    fingerprint: fixtureFingerprint(workspace),
    validation,
  };
}
