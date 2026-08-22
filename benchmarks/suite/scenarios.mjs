const ROOT_BY_PROFILE = {
  low: "low-root-sheet",
  high: "perf-root-sheet",
};

export function rootObjectId(profile) {
  return ROOT_BY_PROFILE[profile] || ROOT_BY_PROFILE.low;
}

async function waitForImported(page, profile) {
  const rootId = rootObjectId(profile);
  await page
    .locator(`[data-object-id="${rootId}"][data-cell-address="A1"]`)
    .waitFor({ state: "attached", timeout: 120_000 });
  await page.waitForTimeout(400);
}

export async function importFixture(page, fixturePath, profile) {
  const input = page.locator('input[type="file"][accept*=".json"]');
  await input.setInputFiles(fixturePath);
  await waitForImported(page, profile);
}

export async function ensureBase(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await page.locator(".spatial-layer").count()) === 0) break;
    await page.keyboard.press("[");
    await page.waitForTimeout(950);
  }
  // Reset scroll to origin so next scenario's anchors (B1/B3/C2/M9) are mounted.
  await page.evaluate(() => {
    const scroller = document.querySelector("[data-sheet-scroll]");
    if (scroller) { scroller.scrollTop = 0; scroller.scrollLeft = 0; }
  }).catch(() => {});
  await page.waitForTimeout(180);
}

async function scrollCellIntoView(page, rootId, address) {
  // Virtual grid only mounts visible window. If target cell is not in DOM,
  // we must scroll the [data-sheet-scroll] so it becomes mounted.
  await page.evaluate(({ addr }) => {
    const scroller = document.querySelector("[data-sheet-scroll]");
    if (!scroller) return;
    // Parse address e.g. M9 → col 12, row 8 (0-indexed)
    const m = /^([A-Z]+)(\d+)$/.exec(String(addr).toUpperCase());
    if (!m) { scroller.scrollTop = 0; scroller.scrollLeft = 0; return; }
    const letters = m[1];
    let col = 0;
    for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
    col -= 1;
    const row = parseInt(m[2], 10) - 1;
    // Match sheet metrics (rowHeight 31, columnWidth 126, headers 34/25)
    const colWidth = 126, rowHeight = 31;
    // Scroll just enough to bring target into view, with small margin.
    const targetLeft = col * colWidth;
    const targetTop = row * rowHeight;
    // Keep existing scroll if already in view; otherwise jump.
    const margin = 120;
    if (scroller.scrollLeft > targetLeft + margin || scroller.scrollLeft + scroller.clientWidth < targetLeft + colWidth + margin) {
      scroller.scrollLeft = Math.max(0, targetLeft - margin);
    }
    if (scroller.scrollTop > targetTop + margin || scroller.scrollTop + scroller.clientHeight < targetTop + rowHeight + margin) {
      scroller.scrollTop = Math.max(0, targetTop - margin);
    }
  }, { addr: address }).catch(() => {});
  // Wait a frame for virtual range to recompute and mount, plus React commit.
  await page.waitForTimeout(240);
  // Fallback: if still not attached, reset and try scrollIntoView after mount
  await page.evaluate(({ objectId, addr }) => {
    const cell = document.querySelector(`[data-object-id="${objectId}"][data-cell-address="${addr}"]`);
    if (cell) cell.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, { objectId: rootId, addr: address }).catch(() => {});
  await page.waitForTimeout(140);
}

export async function measureLoadWarm(page, baseUrl, profile) {
  const started = Date.now();
  await page.goto(`${baseUrl}/?perf-warm=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  const rootId = rootObjectId(profile);
  await page
    .locator(`[data-object-id="${rootId}"][data-cell-address="A1"]`)
    .waitFor({ state: "attached", timeout: 120_000 });
  await page.waitForTimeout(500);
  const navigation = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0];
    if (!entry) return null;
    return {
      domContentLoadedMs: entry.domContentLoadedEventEnd,
      loadEventMs: entry.loadEventEnd,
      responseStartMs: entry.responseStart,
      durationMs: entry.duration,
    };
  });
  return { wallClockMs: Date.now() - started, navigation };
}

export async function typingBurstAction(page, profile) {
  const rootId = rootObjectId(profile);
  const address = "B1";
  await ensureBase(page);
  await scrollCellIntoView(page, rootId, address);
  const cell = page.locator(`[data-object-id="${rootId}"][data-cell-address="${address}"]`);
  await cell.waitFor({ state: "attached", timeout: 30_000 });
  await cell.click();
  await cell.press("F2");
  const editor = page.locator(".formula-editor");
  await editor.waitFor({ state: "visible", timeout: 30_000 });
  const initial = await editor.inputValue();
  await editor.press("End");
  const chars = "123456789012345678901234".split("");
  const expectedFull = `${initial}${chars.join("")}`;
  for (const char of chars) {
    await editor.type(char);
    await page.waitForTimeout(28);
  }
  await editor.press("Enter");
  // Strict validation: exact full value, not just prefix
  await page.waitForFunction(
    ({ objectId, address: addr, expected }) =>
      (document.querySelector(`[data-object-id="${objectId}"][data-cell-address="${addr}"] .cell-value`)
        ?.textContent || "") === expected,
    { objectId: rootId, address, expected: expectedFull },
    { timeout: 30_000 },
  );
  const final = await page.evaluate(({ objectId, addr }) => document.querySelector(`[data-object-id="${objectId}"][data-cell-address="${addr}"] .cell-value`)?.textContent || "", { objectId: rootId, addr: address });
  if (final !== expectedFull) throw new Error(`typing validation failed: expected "${expectedFull}" got "${final}"`);
  return { typedChars: chars.length, initial, expectedFull, final };
}

export async function formulaAddAction(page, profile) {
  const rootId = rootObjectId(profile);
  // M10 on low; on high the historic M9 lives inside a collapsed row-group
  // (rows 7–18) and a filtered row, so it never mounts — use a visible cell.
  const address = profile === "high" ? "M5" : "M10";
  const formula = "=SUM(B2:B6)";
  await ensureBase(page);
  await scrollCellIntoView(page, rootId, address);
  // B2:B6 deterministic sum observed as 54 on low (one row filtered), validate numerically
  const expected = null;
  const cell = page.locator(`[data-object-id="${rootId}"][data-cell-address="${address}"]`);
  await cell.waitFor({ state: "attached", timeout: 30_000 });
  await cell.dblclick();
  const inline = page.locator(`[data-object-id="${rootId}"][data-cell-address="${address}"] .cell-inline-editor`);
  const bar = page.locator(".formula-editor");
  let editor = inline;
  try { await inline.waitFor({ state: "visible", timeout: 3500 }); }
  catch {
    await cell.press("F2");
    await bar.waitFor({ state: "visible", timeout: 10_000 });
    editor = bar;
  }
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  await editor.type(formula, { delay: 18 });
  await editor.press("Enter");
  // Wait for formula to resolve (any non-"=" value)
  await page.waitForFunction(
    ({ objectId, address: addr }) => {
      const text = (document.querySelector(`[data-object-id="${objectId}"][data-cell-address="${addr}"] .cell-value`)?.textContent || "").trim();
      return text.length > 0 && !text.startsWith("=");
    },
    { objectId: rootId, address },
    { timeout: 30_000 },
  );
  const final = await page.evaluate(({ objectId, addr }) => (document.querySelector(`[data-object-id="${objectId}"][data-cell-address="${addr}"] .cell-value`)?.textContent || "").trim(), { objectId: rootId, addr: address });
  if (!final || final.startsWith("=") || final.startsWith("#")) throw new Error(`formula validation failed at ${address}: got "${final}" from ${formula}`);
  const finalNum = Number(final.replace(/,/g,""));
  if (!Number.isFinite(finalNum)) throw new Error(`formula validation failed at ${address}: expected numeric result got "${final}" from ${formula}`);
  return { formula, address, final };
}

async function insertAxisViaMenu(page, profile, axis) {
  const rootId = rootObjectId(profile);
  const addr = axis === "row" ? "B4" : "C1";
  await scrollCellIntoView(page, rootId, addr);
  const anchor = `[data-object-id="${rootId}"][data-cell-address="${addr}"]`;
  const label = axis === "row" ? "Insert row above" : "Insert column left";
  // Capture values for strict post-check
  const beforeVals = await page.evaluate(({ objectId, a }) => {
    const v = (addr) => (document.querySelector(`[data-object-id="${objectId}"][data-cell-address="${addr}"] .cell-value`)?.textContent || "").trim();
    if (a === "B4") return { pivot: v("B4"), next: v("B5") };
    return { pivot: v("C1"), next: v("D1") };
  }, { objectId: rootId, a: addr });
  const before = await page.evaluate(() => document.querySelectorAll(".virtual-cell-slot").length);
  const opStart = Date.now();
  const loc = page.locator(anchor);
  await loc.waitFor({ state: "attached", timeout: 15_000 });
  await loc.click({ button: "right" });
  const menu = page.locator(".cell-context-menu");
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  const submenuTrigger = menu.locator('[role="menuitem"]', { hasText: "Rows & columns" }).first();
  await submenuTrigger.waitFor({ state: "visible", timeout: 10_000 });
  await submenuTrigger.click();
  const submenu = page.locator(".cell-menu-submenu");
  await submenu.waitFor({ state: "visible", timeout: 10_000 });
  const item = submenu.locator('[role="menuitem"]', { hasText: label }).first();
  await item.waitFor({ state: "visible", timeout: 15_000 });
  await item.click();
  await menu.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(220);
  // Strict validation: new pivot should be empty, next should now hold old pivot
  await page.waitForFunction(({ objectId, a, beforePivot }) => {
    const v = (addr) => (document.querySelector(`[data-object-id="${objectId}"][data-cell-address="${addr}"] .cell-value`)?.textContent || "").trim();
    if (a === "B4") {
      const pivot = v("B4"), next = v("B5");
      return pivot === "" && next === beforePivot;
    } else {
      const pivot = v("C1"), next = v("D1");
      return pivot === "" && next === beforePivot;
    }
  }, { objectId: rootId, a: addr, beforePivot: beforeVals.pivot }, { timeout: 15_000 });
  const afterVals = await page.evaluate(({ objectId, a }) => {
    const v = (addr) => (document.querySelector(`[data-object-id="${objectId}"][data-cell-address="${addr}"] .cell-value`)?.textContent || "").trim();
    if (a === "B4") return { pivot: v("B4"), next: v("B5") };
    return { pivot: v("C1"), next: v("D1") };
  }, { objectId: rootId, a: addr });
  if (afterVals.pivot !== "" || afterVals.next !== beforeVals.pivot) {
    throw new Error(`${axis} insert validation failed: before pivot "${beforeVals.pivot}" → after pivot "${afterVals.pivot}" next "${afterVals.next}"`);
  }
  return { ms: Date.now() - opStart, mountedCellsBefore: before, beforeVals, afterVals };
}

export async function addRowsAction(page, profile, times = 8) {
  await ensureBase(page);
  const ops = [];
  for (let index = 0; index < times; index += 1) {
    ops.push(await insertAxisViaMenu(page, profile, "row"));
    await page.waitForTimeout(120);
  }
  return { ops, count: times };
}

export async function addColumnsAction(page, profile, times = 8) {
  await ensureBase(page);
  const ops = [];
  for (let index = 0; index < times; index += 1) {
    ops.push(await insertAxisViaMenu(page, profile, "column"));
    await page.waitForTimeout(120);
  }
  return { ops, count: times };
}

export async function scrollVerticalAction(page, profile) {
  const rootId = rootObjectId(profile);
  await page.locator(`[data-object-id="${rootId}"][data-cell-address="A1"]`).click();
  await page.evaluate(async () => {
    const scroller = document.querySelector("[data-sheet-scroll]");
    if (!scroller) throw new Error("Sheet scroller was not found.");
    const startTop = scroller.scrollTop;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    for (let frame = 0; frame < 72; frame += 1) {
      const progress = (frame + 1) / 72;
      scroller.scrollTop = Math.min(maxTop, startTop + maxTop * progress * 0.5);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    for (let frame = 0; frame < 24; frame += 1) {
      const progress = (frame + 1) / 24;
      scroller.scrollTop = maxTop * (1 - progress);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    scroller.scrollTop = startTop;
  });
}

export async function scrollDiagonalAction(page) {
  await page.evaluate(async () => {
    const scroller = document.querySelector("[data-sheet-scroll]");
    if (!scroller) throw new Error("Sheet scroller was not found.");
    const startTop = scroller.scrollTop;
    const startLeft = scroller.scrollLeft;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    for (let frame = 0; frame < 72; frame += 1) {
      const progress = (frame + 1) / 72;
      scroller.scrollTop = Math.min(maxTop, startTop + Math.max(900, maxTop * progress * 0.12));
      scroller.scrollLeft = Math.min(maxLeft, startLeft + Math.max(500, maxLeft * progress * 0.08));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    scroller.scrollTop = startTop;
    scroller.scrollLeft = startLeft;
  });
}

async function openFloating(page, objectId) {
  const cell = page.locator(`[data-object-id="${objectId}"][data-cell-address="A1"]`);
  await cell.click();
  await page.waitForTimeout(220);
  await page
    .locator('.spatial-layer[data-spatial-phase="floating"]')
    .last()
    .waitFor({ state: "attached", timeout: 15_000 });
}

async function expandTop(page) {
  await page.locator(".object-window-expand").last().click();
  await page.waitForTimeout(100);
  await page
    .locator('.spatial-layer[data-spatial-phase="full"]')
    .last()
    .waitFor({ state: "attached", timeout: 15_000 });
}

export async function inOutAction(page, profile) {
  await ensureBase(page);
  const rootId = rootObjectId(profile);
  await openFloating(page, rootId);
  await page.keyboard.press("]");
  await page.waitForTimeout(100);
  await page.keyboard.press("[");
  await page.waitForTimeout(900);
}

export async function nestedAction(page, profile) {
  await ensureBase(page);
  const layerIds =
    profile === "high"
      ? ["perf-layer-1-sheet", "perf-layer-2-sheet", "perf-layer-3-sheet", "perf-layer-4-sheet"]
      : ["low-layer-1", "low-layer-2", "low-layer-3", "low-layer-4"];
  const rootId = rootObjectId(profile);
  await openFloating(page, rootId);
  await expandTop(page);
  for (const id of layerIds) {
    await openFloating(page, id);
  }
  await page.keyboard.press("]");
  await page.waitForTimeout(100);
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("[");
    await page.waitForTimeout(700);
  }
}
