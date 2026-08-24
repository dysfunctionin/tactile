import { readFile } from "node:fs/promises";

import { expect } from "@playwright/test";
import JSZip from "jszip";

import { defineSuite } from "../../harness/playwright.mjs";
import { largeSheetFile } from "../../scenarios/large-sheet.mjs";

const scenario = defineSuite({ type: "e2e", suite: "workspace-export", setup: largeSheetFile });

/**
 * Guards the export path against writing out less than the workspace holds.
 *
 * A virtual sheet is only resident for the blocks the grid painted, so a bug in
 * hydration surfaces here as a short CSV rather than as a visible failure. The
 * stress workspace is used because it is the one above the residency threshold.
 */
async function importLargeWorkspace(page, artifactPath, spec) {
  await page.goto("/");
  await page.locator('input[type="file"][accept*=".json"]').setInputFiles(artifactPath);
  await expect(page.locator(`[data-object-id="${spec.rootSheetId}"][data-cell-address="A1"]`)).toBeVisible({
    timeout: 120_000,
  });
}

async function exportZip(page, testInfo) {
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: /Export workspace/ }).click();
  const file = testInfo.outputPath("exported-workspace.zip");
  await (await download).saveAs(file);
  return JSZip.loadAsync(await readFile(file));
}

scenario("exports every row of a 250k-cell sheet", async ({ page, artifactPath, spec, testInfo }) => {
  await importLargeWorkspace(page, artifactPath, spec);

  const zip = await exportZip(page, testInfo);
  const csv = zip.file(`objects/${spec.rootSheetId}/sheet.csv`);
  expect(csv, "the root sheet must be in the package").not.toBeNull();

  const lines = (await csv.async("text")).split(/\r?\n/).filter((line) => line.length);

  expect(lines.length, "export must not truncate a sheet to the rows that were on screen").toBe(spec.rootRows);
  // The last row is the one a partially resident sheet would silently drop.
  expect(lines.at(-1)).toContain(`Row-${String(spec.rootRows).padStart(4, "0")}`);
});

scenario("exports the workspace index alongside the sheets", async ({ page, artifactPath, spec, testInfo }) => {
  await importLargeWorkspace(page, artifactPath, spec);

  const zip = await exportZip(page, testInfo);
  const index = zip.file("workspace.json");
  expect(index, "the package must carry its index").not.toBeNull();

  const parsed = JSON.parse(await index.async("text"));
  const objects = parsed.objects || [];

  expect(objects.length).toBe(spec.objectCount);
  expect(objects.find((object) => object.id === spec.rootSheetId)?.file).toBe(
    `objects/${spec.rootSheetId}/sheet.csv`,
  );
});
