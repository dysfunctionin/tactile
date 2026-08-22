import { expect, test } from "@playwright/test";

async function setCellValue(page, address, value) {
  const cell = page.locator(`.sheet-cell[data-cell-address="${address}"]`).first();
  await cell.click();
  await cell.dblclick();
  const inlineEditor = cell.locator(".cell-inline-editor");
  await expect(inlineEditor).toBeFocused();
  await inlineEditor.fill(value);
  await inlineEditor.press("Enter");
  await expect(cell).toContainText(String(value).split("\n")[0]);
}

test("previews column resizing before the pointer is released and auto-fits on double-click", async ({ page }) => {
  await page.goto("/");

  const sheet = page.locator("[data-sheet-scroll]").last();
  await expect(sheet).toBeVisible();

  const columnCell = sheet.locator('.sheet-cell[data-cell-address="A1"]').first();
  const columnBefore = await columnCell.boundingBox();
  const columnHandle = sheet.getByRole("separator", { name: "Resize column A" });
  const columnHandleBox = await columnHandle.boundingBox();
  if (!columnBefore || !columnHandleBox) throw new Error("Column resize fixture is not measurable.");

  await page.mouse.move(columnHandleBox.x + columnHandleBox.width / 2, columnHandleBox.y + columnHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    columnHandleBox.x + columnHandleBox.width / 2 + 48,
    columnHandleBox.y + columnHandleBox.height / 2,
    { steps: 4 },
  );
  await expect.poll(async () => (await columnCell.boundingBox())?.width || 0).toBeGreaterThan(columnBefore.width + 20);
  await page.mouse.up();

  const draggedWidth = (await columnCell.boundingBox())?.width || 0;
  const resetColumnHandle = await columnHandle.boundingBox();
  if (!resetColumnHandle) throw new Error("Resized column fixture is not measurable.");
  await page.mouse.dblclick(
    resetColumnHandle.x + resetColumnHandle.width / 2,
    resetColumnHandle.y + resetColumnHandle.height / 2,
  );

  // Double-click auto-fits to content: an empty column narrows to its header
  // width, well below both the default column and the manually dragged width.
  await expect
    .poll(async () => Math.round((await columnCell.boundingBox())?.width || 0))
    .toBeLessThan(columnBefore.width - 20);
  await expect
    .poll(async () => Math.round((await columnCell.boundingBox())?.width || 0))
    .toBeLessThan(draggedWidth - 20);
});

test("previews row resizing before the pointer is released and auto-fits on double-click", async ({ page }) => {
  await page.goto("/");

  const sheet = page.locator("[data-sheet-scroll]").last();
  await expect(sheet).toBeVisible();

  // An explicitly multi-line value so the row's content height is clearly
  // taller than the default single-line row.
  await setCellValue(page, "A1", "line one\nline two");

  const rowCell = sheet.locator('.sheet-cell[data-cell-address="A1"]').first();
  const rowBefore = await rowCell.boundingBox();
  const rowHandle = sheet.getByRole("separator", { name: "Resize row 1", exact: true });
  const rowHandleBox = await rowHandle.boundingBox();
  if (!rowBefore || !rowHandleBox) throw new Error("Row resize fixture is not measurable.");

  await page.mouse.move(rowHandleBox.x + rowHandleBox.width / 2, rowHandleBox.y + rowHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowHandleBox.x + rowHandleBox.width / 2, rowHandleBox.y + rowHandleBox.height / 2 + 24, {
    steps: 4,
  });
  await expect.poll(async () => (await rowCell.boundingBox())?.height || 0).toBeGreaterThan(rowBefore.height + 10);
  await page.mouse.up();

  const draggedHeight = (await rowCell.boundingBox())?.height || 0;
  const resetRowHandle = await rowHandle.boundingBox();
  if (!resetRowHandle) throw new Error("Resized row fixture is not measurable.");
  await page.mouse.dblclick(resetRowHandle.x + resetRowHandle.width / 2, resetRowHandle.y + resetRowHandle.height / 2);

  // Double-click auto-fits to the two-line content height, returning the row
  // to its live auto-grown height and undoing the manual drag.
  await expect
    .poll(async () => Math.round((await rowCell.boundingBox())?.height || 0))
    .toBeLessThan(draggedHeight - 10);
  await expect
    .poll(async () => Math.round((await rowCell.boundingBox())?.height || 0))
    .toBeGreaterThanOrEqual(Math.round(rowBefore.height) - 2);
  await expect
    .poll(async () => Math.round((await rowCell.boundingBox())?.height || 0))
    .toBeLessThanOrEqual(Math.round(rowBefore.height) + 2);
});
