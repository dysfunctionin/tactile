import { expect } from "@playwright/test";

import { defineSuite } from "../../harness/playwright.mjs";
import { largeSheetFile } from "../../scenarios/large-sheet.mjs";
import { smallSheetFile } from "../../scenarios/small-sheet.mjs";

const scenario = defineSuite({ type: "e2e", suite: "workspace-import", setup: smallSheetFile });

/**
 * Import driven from the Settings panel rather than the hidden input, so the
 * command wiring is covered and not just the file reader.
 */
async function importThroughSettings(page, artifactPath) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("tab", { name: "Files & ownership" }).click();

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import workspace" }).click();
  await (await chooser).setFiles(artifactPath);
}

scenario("keeps an imported small workspace after a reload", async ({ page, artifactPath, spec }) => {
  await importThroughSettings(page, artifactPath);

  const rootCell = page.locator(`[data-object-id="${spec.rootSheetId}"][data-cell-address="A1"]`);
  await expect(rootCell).toBeVisible({ timeout: 120_000 });
  const importState = await page.evaluate(() => {
    const sessionId = sessionStorage.getItem("tactile.browser.session.v1");
    const registry = JSON.parse(localStorage.getItem("tactile.browser.sessions.v1") || "{}");
    const record = registry[sessionId];
    return {
      lastChangedAt: record?.lastChangedAt,
      lastExportedAt: record?.lastExportedAt,
      needsExport: record?.needsExport,
    };
  });
  expect(importState.lastChangedAt).toBeGreaterThan(0);
  expect(importState.lastExportedAt).toBe(importState.lastChangedAt);
  expect(importState.needsExport).toBe(false);

  await page.reload();
  await expect(rootCell).toBeVisible({ timeout: 120_000 });
  await expect(rootCell).toContainText("Item-00");
});

scenario(
  "keeps an imported 250k-cell workspace after a reload",
  { setup: largeSheetFile },
  async ({ page, artifactPath, spec }) => {
    await importThroughSettings(page, artifactPath);

    const rootCell = page.locator(`[data-object-id="${spec.rootSheetId}"][data-cell-address="A1"]`);
    await expect(rootCell).toBeVisible({ timeout: 120_000 });

    await page.reload();
    await expect(rootCell).toBeVisible({ timeout: 120_000 });
    await expect(rootCell).toContainText("Row-0001", { timeout: 120_000 });
  },
);
