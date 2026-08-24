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

async function closeAsDirtySession(page) {
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await page.close();
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
    await expect(fresh.getByRole("dialog", { name: "Restore closed workspaces?" })).toHaveCount(0);
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

scenario("closing one dirty tab never opens recovery in another live tab", async ({ page, context, artifactPath }) => {
  await importThroughSettings(page, artifactPath);
  const second = await context.newPage();
  await second.goto("/");
  await expect(workspaceCell(second, "home")).toBeVisible();

  await closeAsDirtySession(page);
  await second.waitForTimeout(2_500);
  await expect(second.getByRole("dialog", { name: "Restore closed workspaces?" })).toHaveCount(0);

  const fresh = await context.newPage();
  await fresh.goto("/");
  await expect(fresh.getByRole("dialog", { name: "Restore closed workspaces?" })).toBeVisible({ timeout: 5_000 });
  await fresh.close();
  await second.close();
});

scenario(
  "restore tabs reopens every orphan without claiming a live workspace",
  { timeoutMs: 30_000 },
  async ({ page, context, artifactPath, spec, step }) => {
    await step("import first orphan", () => importThroughSettings(page, artifactPath));
    await step("edit first orphan", () => editCell(page, spec.rootSheetId, "Recovered first"));

    const second = await context.newPage();
    await step("import second orphan", () => importThroughSettings(second, artifactPath));
    await step("edit second orphan", () => editCell(second, spec.rootSheetId, "Recovered second"));

    await step("close first orphan", () => closeAsDirtySession(page));
    await step("close second orphan", () => closeAsDirtySession(second));

    const recovery = await context.newPage();
    await step("open recovery tab", () => recovery.goto("/"));
    const dialog = recovery.getByRole("dialog", { name: "Restore closed workspaces?" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.locator(".session-recovery-list li")).toHaveCount(2);
    const orphanSessionIds = await recovery.evaluate(() =>
      Object.entries(JSON.parse(localStorage.getItem("tactile.browser.sessions.v1") || "{}"))
        .filter(([, record]) => record.state === "orphan")
        .map(([sessionId]) => sessionId),
    );

    const opened = context.waitForEvent("page");
    await step("request restore tabs", () => dialog.getByRole("button", { name: "Restore tabs" }).click());
    const restoredSecond = await step("wait for restored tab", () => opened);
    await step("wait for restored workspaces", () =>
      Promise.all([recovery.waitForLoadState("domcontentloaded"), restoredSecond.waitForLoadState("domcontentloaded")]),
    );
    await expect
      .poll(
        async () =>
          orphanSessionIds.includes(
            await recovery.evaluate(() => sessionStorage.getItem("tactile.browser.session.v1")),
          ),
        { timeout: 5_000 },
      )
      .toBe(true);
    await step("show first restored workspace", () =>
      expect(workspaceCell(recovery, spec.rootSheetId)).toBeVisible({ timeout: 5_000 }),
    );
    await step("show second restored workspace", () =>
      expect(workspaceCell(restoredSecond, spec.rootSheetId)).toBeVisible({ timeout: 5_000 }),
    );

    const values = await Promise.all([
      workspaceCell(recovery, spec.rootSheetId).textContent(),
      workspaceCell(restoredSecond, spec.rootSheetId).textContent(),
    ]);
    expect(values.join(" ")).toContain("Recovered first");
    expect(values.join(" ")).toContain("Recovered second");
    await restoredSecond.close();
  },
);
