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

async function seedOrphanRecords(page, labels) {
  await page.evaluate((workspaceLabels) => {
    const key = "tactile.browser.sessions.v1";
    const registry = JSON.parse(localStorage.getItem(key) || "{}");
    workspaceLabels.forEach((workspaceLabel, index) => {
      const sessionId = `seeded-orphan-${index}`;
      registry[sessionId] = {
        ownerId: `closed-owner-${index}`,
        state: "orphan",
        needsExport: true,
        workspaceLabel,
        databaseName: `tactile-local-workspace-records-${sessionId}`,
        lastSeen: Date.now() - 10_000,
        closedAt: Date.now() - 10_000 - index,
      };
    });
    localStorage.setItem(key, JSON.stringify(registry));
  }, labels);
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
  "restore selected permanently discards unselected workspaces",
  { timeoutMs: 30_000 },
  async ({ page, context, step }) => {
    await page.goto("/");
    await seedOrphanRecords(page, ["Page 1", "Page 2", "Page 3"]);

    const recovery = await context.newPage();
    await step("open recovery page", () => recovery.goto("/"));
    const dialog = recovery.getByRole("dialog", { name: "Restore closed workspaces?" });
    await step("show recovery dialog", () => expect(dialog).toBeVisible({ timeout: 5_000 }));
    await step("select Page 1", () => dialog.getByRole("checkbox", { name: /Page 1/ }).check());
    await step("enable selected restore", () =>
      expect(dialog.getByRole("button", { name: "Restore Selected (1)" })).toBeEnabled(),
    );

    const blankSessionId = await recovery.evaluate(() => sessionStorage.getItem("tactile.browser.session.v1"));
    const opened = context.waitForEvent("page");
    await step("restore selected", () => dialog.getByRole("button", { name: "Restore Selected (1)" }).click());
    const restored = await opened;
    await expect(recovery.getByRole("dialog", { name: "Restore closed workspaces?" })).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(workspaceCell(recovery, "home")).toBeVisible();
    expect(await recovery.evaluate(() => sessionStorage.getItem("tactile.browser.session.v1"))).toBe(blankSessionId);
    await expect
      .poll(() => restored.evaluate(() => sessionStorage.getItem("tactile.browser.session.v1")))
      .toBe("seeded-orphan-0");
    await expect
      .poll(() =>
        recovery.evaluate(() => {
          const registry = JSON.parse(localStorage.getItem("tactile.browser.sessions.v1") || "{}");
          return ["seeded-orphan-1", "seeded-orphan-2"].some((sessionId) => sessionId in registry);
        }),
      )
      .toBe(false);
    await restored.close();
  },
);

scenario(
  "discard permanently removes every recoverable workspace",
  { timeoutMs: 30_000 },
  async ({ page, context }) => {
    await page.goto("/");
    await seedOrphanRecords(page, ["Page 1", "Page 2", "Page 3"]);

    const recovery = await context.newPage();
    await recovery.goto("/");
    const dialog = recovery.getByRole("dialog", { name: "Restore closed workspaces?" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    const blankSessionId = await recovery.evaluate(() => sessionStorage.getItem("tactile.browser.session.v1"));

    await dialog.getByRole("button", { name: "Discard" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(workspaceCell(recovery, "home")).toBeVisible();
    expect(await recovery.evaluate(() => sessionStorage.getItem("tactile.browser.session.v1"))).toBe(blankSessionId);
    await expect
      .poll(() =>
        recovery.evaluate(() => {
          const registry = JSON.parse(localStorage.getItem("tactile.browser.sessions.v1") || "{}");
          return ["seeded-orphan-0", "seeded-orphan-1", "seeded-orphan-2"].some((sessionId) => sessionId in registry);
        }),
      )
      .toBe(false);
  },
);

scenario("restore all keeps popup-blocked workspaces in the recovery flow", async ({ page, context }) => {
  await page.goto("/");
  await seedOrphanRecords(page, ["Page 1", "Page 2", "Page 3", "Page 4"]);

  const recovery = await context.newPage();
  await recovery.goto("/");
  const dialog = recovery.getByRole("dialog", { name: "Restore closed workspaces?" });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await recovery.evaluate(() => {
    const open = window.open.bind(window);
    let opened = false;
    window.open = (...args) => {
      if (opened) return null;
      opened = true;
      return open(...args);
    };
  });

  const opened = context.waitForEvent("page");
  await dialog.getByRole("button", { name: "Restore All" }).click();
  const restoredTab = await opened;
  await expect(recovery.getByRole("dialog", { name: "Restore closed workspaces?" })).toBeVisible({ timeout: 5_000 });
  await expect(recovery.locator(".session-recovery-list li")).toHaveCount(3);
  await expect(workspaceCell(recovery, "home")).toBeVisible();
  await restoredTab.close();
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

    const pagesBeforeRestore = new Set(context.pages());
    await step("request restore tabs", () => dialog.getByRole("button", { name: "Restore All" }).click());
    await expect.poll(() => context.pages().filter((candidate) => !pagesBeforeRestore.has(candidate)).length).toBe(2);
    const [restoredFirst, restoredSecond] = context.pages().filter((candidate) => !pagesBeforeRestore.has(candidate));
    await step("wait for restored workspaces", () =>
      Promise.all([
        restoredFirst.waitForLoadState("domcontentloaded"),
        restoredSecond.waitForLoadState("domcontentloaded"),
      ]),
    );
    await expect(workspaceCell(recovery, "home")).toBeVisible();
    await step("show first restored workspace", () =>
      expect(workspaceCell(restoredFirst, spec.rootSheetId)).toBeVisible({ timeout: 5_000 }),
    );
    await step("show second restored workspace", () =>
      expect(workspaceCell(restoredSecond, spec.rootSheetId)).toBeVisible({ timeout: 5_000 }),
    );

    const values = await Promise.all([
      workspaceCell(restoredFirst, spec.rootSheetId).textContent(),
      workspaceCell(restoredSecond, spec.rootSheetId).textContent(),
    ]);
    expect(values.join(" ")).toContain("Recovered first");
    expect(values.join(" ")).toContain("Recovered second");
    const restoredSessionIds = await Promise.all([
      restoredFirst.evaluate(() => sessionStorage.getItem("tactile.browser.session.v1")),
      restoredSecond.evaluate(() => sessionStorage.getItem("tactile.browser.session.v1")),
    ]);
    expect(restoredSessionIds.every((sessionId) => orphanSessionIds.includes(sessionId))).toBe(true);
    await restoredFirst.close();
    await restoredSecond.close();
  },
);
