import { expect } from "@playwright/test";

import { defineSuite } from "../../harness/playwright.mjs";
import { smallSheetFile } from "../../scenarios/small-sheet.mjs";

const scenario = defineSuite({ type: "e2e", suite: "browser-session", setup: smallSheetFile });

async function importThroughSettings(page, artifactPath) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Files & ownership" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import workspace" }).click();
  await (await chooser).setFiles(artifactPath);
  await page.getByRole("button", { name: "Close settings" }).click();
}

function workspaceCell(page, objectId, address = "A1") {
  return page.locator(`[data-object-id="${objectId}"][data-cell-address="${address}"]`);
}

async function editCell(page, objectId, value) {
  await workspaceCell(page, objectId).click();
  const editor = page.locator(".formula-editor");
  await editor.fill(value);
  await editor.press("Enter");
  await expect(workspaceCell(page, objectId)).toContainText(value);
}

async function reloadDirtySession(page) {
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
}

scenario(
  "an imported workspace survives reload but a new tab starts blank",
  async ({ page, context, artifactPath, spec }) => {
    await importThroughSettings(page, artifactPath);
    await expect(workspaceCell(page, spec.rootSheetId)).toBeVisible();

    await page.reload();
    await expect(workspaceCell(page, spec.rootSheetId)).toBeVisible();

    const fresh = await context.newPage();
    await fresh.goto("/");
    await expect(workspaceCell(fresh, "home")).toBeVisible();
    await expect(workspaceCell(fresh, spec.rootSheetId)).toHaveCount(0);
    await fresh.close();
  },
);

scenario(
  "two live tabs keep independent workspaces across reloads",
  { timeoutMs: 30_000 },
  async ({ page, context, artifactPath, spec, step }) => {
    await step("import first tab", () => importThroughSettings(page, artifactPath));
    await step("edit first tab", () => editCell(page, spec.rootSheetId, "First tab"));

    const second = await context.newPage();
    await step("import second tab", () => importThroughSettings(second, artifactPath));
    await step("edit second tab", () => editCell(second, spec.rootSheetId, "Second tab"));

    await step("reload first tab", () => reloadDirtySession(page));
    await step("reload second tab", () => reloadDirtySession(second));
    await expect(workspaceCell(page, spec.rootSheetId)).toContainText("First tab");
    await expect(workspaceCell(second, spec.rootSheetId)).toContainText("Second tab");
    await second.close();
  },
);

scenario("canceling browser close protection reveals the workspace export action", async ({ page, artifactPath }) => {
  await importThroughSettings(page, artifactPath);
  await page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })));

  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Files & ownership" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Export .zip" })).toBeVisible();
});

scenario("a fresh blank workspace does not register close protection", async ({ page }) => {
  await page.goto("/");
  await expect(workspaceCell(page, "home")).toBeVisible();

  const closeState = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    const sessionId = sessionStorage.getItem("tactile.browser.session.v1");
    const registry = JSON.parse(localStorage.getItem("tactile.browser.sessions.v1") || "{}");
    return {
      prevented: event.defaultPrevented,
      needsExport: registry[sessionId]?.needsExport === true,
    };
  });

  expect(closeState).toEqual({ prevented: false, needsExport: false });
});

scenario(
  "a dirty closed workspace can be restored into a fresh tab",
  { timeoutMs: 30_000 },
  async ({ page, context, artifactPath, spec }) => {
    await importThroughSettings(page, artifactPath);
    await editCell(page, spec.rootSheetId, "Recovered value");
    await page.close();

    const recoveryPage = await context.newPage();
    await recoveryPage.goto("/");
    const filesButton = recoveryPage.getByRole("button", { name: /Browse files/ });
    await expect(filesButton).toHaveAccessibleName(/1 workspace can be restored/);
    await filesButton.click();
    const restoreNotice = recoveryPage.locator(".files-restore-row");
    await expect(restoreNotice).toContainText("Workspaces can be restored");
    await restoreNotice.getByRole("button", { name: "Open Settings" }).click();

    const settings = recoveryPage.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("tab", { name: "Files & ownership" })).toHaveAttribute("aria-selected", "true");
    const restoreRegion = settings.getByRole("region", { name: "Restore workspaces" });
    await expect(restoreRegion.locator(".restore-workspace-row")).toContainText("Small sheet");
    await expect(restoreRegion.locator(".restore-workspace-row")).toContainText("Never");
    await restoreRegion.getByRole("button", { name: "Restore", exact: true }).click();

    await expect(workspaceCell(recoveryPage, spec.rootSheetId)).toContainText("Recovered value");
    await expect(recoveryPage.getByRole("button", { name: "Browse files", exact: true })).toBeVisible();
    await recoveryPage.close();
  },
);

scenario("discard and confirmed discard all remove orphaned workspaces", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const key = "tactile.browser.sessions.v1";
    const registry = JSON.parse(localStorage.getItem(key) || "{}");
    const timestamp = Date.now();
    registry["discard-one"] = {
      ownerId: "discard-owner-one",
      state: "orphan",
      needsExport: true,
      databaseName: "discard-database-one",
      workspaceId: "discard-workspace-one",
      workspaceName: "Discard one",
      lastChangedAt: timestamp - 1_000,
      lastExportedAt: 0,
      lastSeen: timestamp - 1_000,
    };
    registry["discard-two"] = {
      ownerId: "discard-owner-two",
      state: "orphan",
      needsExport: true,
      databaseName: "discard-database-two",
      workspaceId: "discard-workspace-two",
      workspaceName: "Discard two",
      lastChangedAt: timestamp,
      lastExportedAt: 0,
      lastSeen: timestamp,
    };
    localStorage.setItem(key, JSON.stringify(registry));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: JSON.stringify(registry),
        storageArea: localStorage,
      }),
    );
  });

  await page.getByRole("button", { name: /Browse files/ }).click();
  await page.locator(".files-restore-row").getByRole("button", { name: "Open Settings" }).click();
  const restoreRegion = page.getByRole("region", { name: "Restore workspaces" });
  const firstRow = restoreRegion.locator(".restore-workspace-row").filter({ hasText: "Discard one" });
  await firstRow.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(firstRow).toHaveCount(0);

  await restoreRegion.getByRole("button", { name: "Discard all", exact: true }).click();
  const confirmation = restoreRegion.getByRole("alert");
  await expect(confirmation).toContainText("This cannot be undone");
  await confirmation.getByRole("button", { name: "Discard all", exact: true }).click();
  await expect(restoreRegion.locator(".restore-workspace-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Browse files", exact: true })).toBeVisible();
});
