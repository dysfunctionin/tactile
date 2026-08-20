import { chromium } from "@playwright/test";
import { defineConfig } from "@playwright/test";

const baseURL = process.env.TACTILE_BASE_URL || "http://127.0.0.1:5187";

// The first request against a fresh Vite dev server pays a one-time cost to
// pre-bundle dependencies and build the marketplace plugins. That work is
// cached after the initial browser load, but it can take well beyond a single
// test's navigation timeout. Gate readiness on an actual app render so the
// warm-up happens once here instead of racing the first test.
let warmupReady = null;
async function waitForAppReady() {
  if (!warmupReady) {
    warmupReady = (async () => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(baseURL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".sheet-cell", { timeout: 120_000 });
      } finally {
        await browser.close();
      }
    })().catch((error) => {
      warmupReady = null;
      throw error;
    });
  }
  await warmupReady;
}

export default defineConfig({
  testDir: "../../tests/e2e",
  testMatch: /.*\.e2e\.spec\.[cm]?[jt]s$/,
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5187",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
    healthcheck: {
      test: waitForAppReady,
      timeout: 120_000,
    },
  },
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    trace: "retain-on-failure",
  },
});
