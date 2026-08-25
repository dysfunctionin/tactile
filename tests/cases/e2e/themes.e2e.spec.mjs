import { expect } from "@playwright/test";

import { defineSuite } from "../../harness/playwright.mjs";

const scenario = defineSuite({ type: "e2e", suite: "themes" });

const requestedThemes = [
  "GitHub Dark",
  "Catppuccin Dark",
  "Flexoki Light",
  "Flexoki Dark",
  "Tactile Night",
  "Nord Dark",
  "VSCode Dark",
  "macOS Light",
  "macOS Dark",
  "Notion Light",
  "Notion Dark",
];

function firstShadowAlpha(value) {
  const oklab = value.match(/oklab\([^/]+\/\s*([\d.]+)\)/);
  const rgba = value.match(/rgba\([^)]*,\s*([\d.]+)\)/);
  return Number(oklab?.[1] ?? rgba?.[1] ?? 1);
}

function lastShadowAlpha(value) {
  const matches = [...value.matchAll(/(?:oklab\([^/]+\/\s*([\d.]+)\)|rgba\([^)]*,\s*([\d.]+)\))/g)];
  const match = matches.at(-1);
  return Number(match?.[1] ?? match?.[2] ?? 1);
}

function renderedTheme(page) {
  return page.locator(".tactile-app").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      colorScheme: style.colorScheme,
      paper: style.getPropertyValue("--paper").trim(),
      accent: style.getPropertyValue("--accent").trim(),
    };
  });
}

scenario("keeps the selected theme across live tabs and browser restarts", async ({ page, context }) => {
  await page.goto("/");
  const second = await context.newPage();
  await second.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const tactileNight = dialog.locator(".theme-card", { hasText: "Tactile Night" });
  await tactileNight.click();
  await expect(tactileNight).toHaveClass(/is-selected/);

  const selectedTheme = await renderedTheme(page);
  await expect.poll(() => renderedTheme(second)).toEqual(selectedTheme);
  expect(selectedTheme.colorScheme).toBe("dark");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const preference = JSON.parse(localStorage.getItem("tactile.theme-preference.v1") || "null");
        return preference?.themeId;
      }),
    )
    .toBe("one-dark");

  for (const candidate of [page, second]) {
    expect(
      await candidate.evaluate(() => {
        const sessionId = sessionStorage.getItem("tactile.browser.session.v1");
        const registry = JSON.parse(localStorage.getItem("tactile.browser.sessions.v1") || "{}");
        return registry[sessionId]?.needsExport === true;
      }),
    ).toBe(false);
  }

  await page.close();
  await second.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect.poll(() => renderedTheme(reopened)).toEqual(selectedTheme);
  expect(await reopened.evaluate(() => document.documentElement.dataset.startupTheme)).toBe("dark");
  await reopened.getByRole("button", { name: "Settings" }).click();
  await expect(
    reopened.getByRole("dialog", { name: "Settings" }).locator(".theme-card", { hasText: "Tactile Night" }),
  ).toHaveClass(/is-selected/);
  await reopened.close();
});

scenario("lists and applies every requested built-in theme", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();

  for (const name of requestedThemes) {
    await expect(dialog.locator(".theme-card", { hasText: name })).toHaveCount(1);
  }

  const themeFilters = dialog.getByRole("group", { name: "Filter themes" });
  await expect(themeFilters.getByRole("button", { name: "All themes" })).toHaveAttribute("aria-pressed", "true");
  await themeFilters.getByRole("button", { name: "Dark themes" }).click();
  await expect(dialog.locator(".theme-card")).toHaveCount(8);
  await expect(dialog.locator(".theme-card", { hasText: "Flexoki Light" })).toHaveCount(0);
  await expect(dialog.locator(".theme-card", { hasText: "GitHub Dark" })).toHaveCount(1);
  await themeFilters.getByRole("button", { name: "All themes" }).click();

  const github = dialog.locator(".theme-card", { hasText: "GitHub Dark" });
  await github.click();
  await expect(github).toHaveClass(/is-selected/);
  await expect
    .poll(() =>
      page.locator(".tactile-app").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          colorScheme: style.colorScheme,
          paper: style.getPropertyValue("--paper").trim(),
          ink: style.getPropertyValue("--ink").trim(),
          defaultInk: style.getPropertyValue("--default-ink").trim(),
          accent: style.getPropertyValue("--accent").trim(),
          surfaceHighlight: style.getPropertyValue("--surface-highlight").trim(),
        };
      }),
    )
    .toEqual({
      colorScheme: "dark",
      paper: "#0d1117",
      ink: "#e6edf3",
      defaultInk: "#e6edf3",
      accent: "#2f81f7",
      surfaceHighlight: "rgba(255,255,255,.06)",
    });
  await expect(dialog.getByText("Default tile ink", { exact: true })).toBeVisible();
  const swatchShadow = await github.locator(".theme-swatch").evaluate((element) => getComputedStyle(element).boxShadow);
  expect(firstShadowAlpha(swatchShadow)).toBeLessThanOrEqual(0.07);
  await expect
    .poll(() =>
      dialog.locator(".theme-list").evaluate((element) => ({
        color: getComputedStyle(element).scrollbarColor,
        track: getComputedStyle(element, "::-webkit-scrollbar-track").backgroundColor,
        buttonDisplay: getComputedStyle(element, "::-webkit-scrollbar-button").display,
        thumbToken: getComputedStyle(element).getPropertyValue("--scrollbar-thumb").trim(),
        hoverToken: getComputedStyle(element).getPropertyValue("--scrollbar-thumb-hover").trim(),
      })),
    )
    .toEqual({
      color: "rgb(48, 54, 61) rgb(22, 27, 34)",
      track: "rgb(22, 27, 34)",
      buttonDisplay: "none",
      thumbToken: "#30363d",
      hoverToken: "#2f81f7",
    });

  await dialog.getByRole("button", { name: "Close settings" }).click();
  const cell = page.locator(".sheet-cell").nth(3);
  await cell.click();
  const darkCellVisuals = await cell.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      backgroundImage: style.backgroundImage,
      boxShadow: style.boxShadow,
    };
  });
  expect(darkCellVisuals.color).toBe("rgb(230, 237, 243)");
  expect(darkCellVisuals.backgroundImage).not.toContain("rgb(245, 242, 235)");
  expect(firstShadowAlpha(darkCellVisuals.boxShadow)).toBeLessThanOrEqual(0.07);
  const formatGroupShadow = await page
    .locator(".cell-format-group")
    .first()
    .evaluate((element) => getComputedStyle(element).boxShadow);
  expect(firstShadowAlpha(formatGroupShadow)).toBeLessThanOrEqual(0.07);

  await cell.click({ button: "right" });
  const contextMenu = page.locator(".cell-context-menu");
  await expect(contextMenu).toBeVisible();
  const menuVisuals = await contextMenu.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, boxShadow: style.boxShadow };
  });
  expect(menuVisuals.background).toBe("rgb(22, 27, 34)");
  expect(lastShadowAlpha(menuVisuals.boxShadow)).toBeLessThanOrEqual(0.07);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Files" }).click();
  const filesPanel = page.locator(".files-panel");
  await expect(filesPanel).toBeVisible();
  const filesVisuals = await filesPanel.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      border: style.borderRightColor,
      boxShadow: style.boxShadow,
      sideHighlight: style.getPropertyValue("--surface-highlight-soft").trim(),
    };
  });
  expect(filesVisuals.background).toBe("rgb(22, 27, 34)");
  expect(filesVisuals.border).toBe("rgb(48, 54, 61)");
  expect(filesVisuals.sideHighlight).toBe("rgba(255,255,255,.03)");
  expect(filesVisuals.boxShadow).not.toContain("0.72");
  await filesPanel.getByRole("button", { name: "Close Files" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(dialog).toBeVisible();

  const flexokiLight = dialog.locator(".theme-card", { hasText: "Flexoki Light" });
  await flexokiLight.click();
  await expect(flexokiLight).toHaveClass(/is-selected/);
  await expect
    .poll(() =>
      page.locator(".tactile-app").evaluate((element) => ({
        colorScheme: getComputedStyle(element).colorScheme,
        paper: getComputedStyle(element).getPropertyValue("--paper").trim(),
      })),
    )
    .toEqual({ colorScheme: "light", paper: "#fffcf0" });
  await expect
    .poll(() => dialog.locator(".theme-editor").evaluate((element) => getComputedStyle(element).scrollbarColor))
    .toBe("rgb(218, 216, 206) rgb(230, 228, 217)");
});
