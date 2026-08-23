import { expect } from "@playwright/test";

import { defineSuite } from "../../harness/playwright.mjs";
import { largeSheetFile } from "../../scenarios/large-sheet.mjs";

const scenario = defineSuite({ type: "e2e", suite: "large-sheet", setup: largeSheetFile });

/**
 * Interaction latency on a heavy workspace. Every page action is timed by the
 * harness, so these scenarios report per-action cost rather than one total.
 */
async function importLargeWorkspace(page, artifactPath, spec) {
  await page.goto("/");
  await page.locator('input[type="file"][accept*=".json"]').setInputFiles(artifactPath);
  await expect(page.locator(`[data-object-id="${spec.rootSheetId}"][data-cell-address="A1"]`)).toBeVisible({
    timeout: 120_000,
  });
}

scenario("imports a 250k-cell workspace and renders the root sheet", async ({ page, artifactPath, spec }) => {
  await importLargeWorkspace(page, artifactPath, spec);

  await expect(page.locator(".object-statusbar")).toContainText(`${spec.rootRows} × ${spec.rootColumns}`, {
    timeout: 120_000,
  });
  const mounted = await page.locator(`.sheet-cell[data-object-id="${spec.rootSheetId}"]`).count();
  expect(mounted, "the root sheet must mount cells").toBeGreaterThan(0);
  expect(mounted, "a large sheet must stay virtualized rather than mounting every cell").toBeLessThan(5_000);
});

scenario("scrolls a 250k-cell sheet without losing the grid", async ({ page, artifactPath, spec, step }) => {
  await importLargeWorkspace(page, artifactPath, spec);

  const surface = page.locator("[data-sheet-scroll]").last();
  for (const top of [600, 2_400, 6_000]) {
    await step(`scroll to ${top}px`, () =>
      surface.evaluate((element, offset) => element.scrollTo({ top: offset, left: 0, behavior: "auto" }), top),
    );
  }

  await expect(page.locator(`.sheet-cell[data-object-id="${spec.rootSheetId}"]`).first()).toBeVisible({
    timeout: 120_000,
  });
  const mounted = await page.locator(`.sheet-cell[data-object-id="${spec.rootSheetId}"]`).count();
  expect(mounted, "scrolling must keep cells mounted").toBeGreaterThan(0);
  expect(mounted, "scrolling must not accumulate mounted cells").toBeLessThan(5_000);
});

scenario("commits a typed edit on a 250k-cell sheet", async ({ page, artifactPath, spec }) => {
  await importLargeWorkspace(page, artifactPath, spec);

  const target = page.locator(`[data-object-id="${spec.rootSheetId}"][data-cell-address="B2"]`);
  await target.dblclick();
  await target.locator(".cell-inline-editor").fill("typed-on-large-sheet");
  await page.keyboard.press("Enter");

  await expect(target).toContainText("typed-on-large-sheet", { timeout: 120_000 });
});

scenario("evaluates a formula entered on a 250k-cell sheet", async ({ page, artifactPath, spec }) => {
  await importLargeWorkspace(page, artifactPath, spec);

  const target = page.locator(`[data-object-id="${spec.rootSheetId}"][data-cell-address="C2"]`);
  await target.dblclick();
  await target.locator(".cell-inline-editor").fill("=SUM(B1:B10)");
  await page.keyboard.press("Enter");

  await expect(target).not.toBeEmpty({ timeout: 120_000 });
});
