import assert from "node:assert/strict";
import test from "node:test";

import { cellId } from "../src/sheet/coordinates.js";
import {
  autoRowHeight,
  autoRowHeights,
  columnFitWidth,
  measureColumnWidths,
  naturalColumnWidth,
  naturalRowHeight,
} from "../src/sheet/textMeasure.js";

// In Node (no canvas) measureTextWidth falls back to length * fontSize * 0.58,
// so expected values are deterministic.
function objectWithCells(cells) {
  return { rows: 256, columns: 64, cells };
}

test("column fit uses the widest cell once, without double padding", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "a" },
    [cellId(1, 0)]: { value: "longest" },
  });
  // 7 chars * 11.5 * 0.58 = 46.69 + 16 padding + 10 gap = 72.69 -> 73.
  assert.equal(naturalColumnWidth(object, 0), 73);
});

test("column fit measures each column independently", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "tiny" },
    [cellId(0, 1)]: { value: "a considerably longer value" },
  });
  const short = naturalColumnWidth(object, 0);
  const long = naturalColumnWidth(object, 1);
  assert.ok(short < long, "narrow column should not inherit the wide neighbor's width");
});

test("column fit uses the widest single line of a multi-line cell", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "ab\nabcdefghij" },
  });
  // Widest line is 10 chars: 10 * 11.5 * 0.58 = 66.7 + 26 = 92.7 -> 93.
  assert.equal(naturalColumnWidth(object, 0), 93);
});

test("column fit honors per-cell font size", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "hi", style: { fontSize: 20 } },
    [cellId(1, 0)]: { value: "longertext" },
  });
  // "longertext" at 11.5px is wider: 10 * 11.5 * 0.58 = 66.7 + 26 = 92.7 -> 93.
  assert.equal(naturalColumnWidth(object, 0), 93);
});

test("empty columns fit at least their header label", () => {
  assert.equal(naturalColumnWidth(objectWithCells({}), 0), 32); // "A" @ 10px
  assert.equal(naturalColumnWidth(objectWithCells({}), 51), 38); // "AZ" @ 10px
});

test("row fit is driven by the largest font for single-line rows", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "x", style: { fontSize: 14 } },
    [cellId(0, 1)]: { value: "y" },
  });
  // 14 * 1.18 = 16.52 + 14 = 30.52 -> 31.
  assert.equal(naturalRowHeight(object, 0), 31);
});

test("row fit accounts for wrapped content at the cell's column width", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "m".repeat(30), style: { wrap: true } },
  });
  // usable width 84; 30 * 11.5 * 0.58 = 200.1 -> ceil(200.1 / 84) = 3 lines.
  // 3 * 11.5 * 1.18 = 40.71 + 14 = 54.71 -> 55.
  assert.equal(
    naturalRowHeight(object, 0, () => 100),
    55,
  );
});

test("row fit accounts for explicit newlines", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "a\nb\nc" },
  });
  assert.equal(
    naturalRowHeight(object, 0, () => 100),
    55,
  );
});

test("empty rows fit at the single-line baseline", () => {
  // 11.5 * 1.18 = 13.57 + 14 = 27.57 -> 28.
  assert.equal(naturalRowHeight(objectWithCells({}), 0), 28);
});

test("auto height stays null for plain single-line rows", () => {
  const object = objectWithCells({ [cellId(0, 0)]: { value: "x" } });
  assert.equal(
    autoRowHeight(object, 0, () => 100),
    null,
  );
});

test("auto height uses the cell's font size for wrapped line height", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "n".repeat(30), style: { wrap: true, fontSize: 20 } },
  });
  // 30 * 20 * 0.58 = 348; usable 84 -> ceil(348 / 84) = 5 lines.
  // 5 * 20 * 1.18 = 118 + 14 = 132.
  assert.equal(
    autoRowHeight(object, 0, () => 100),
    132,
  );
});

test("embedded cells measure their projected label plus the plugin icon", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "", embed: { objectId: "obj-1", type: "code" } },
  });
  // "Code B5" at 11.5px: 7 * 11.5 * 0.58 = 46.69 + 16 + 10 + 14 icon + 6 gap
  // = 92.69 -> 93.
  const fitted = columnFitWidth(
    measureColumnWidths(object, new Map(), () => "Code B5"),
    0,
  );
  assert.equal(fitted, 93);
  // Without a provider the embed cell still reserves the icon plus padding so
  // the pill never gets clipped to the bare header label.
  const iconOnly = columnFitWidth(measureColumnWidths(object, new Map()), 0);
  assert.equal(iconOnly, 46);
});

test("link cells reserve the link icon alongside their URL text", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "https://example.com/notes" },
  });
  // URL is 25 chars: 25 * 11.5 * 0.58 = 166.75 + 16 + 10 + 14 + 6 = 212.75
  // -> 213.
  const fitted = columnFitWidth(measureColumnWidths(object, new Map()), 0);
  assert.equal(fitted, 213);
});

test("auto heights are a sparse map of only rows that wrap", () => {
  const object = objectWithCells({
    [cellId(0, 0)]: { value: "wrapped ".repeat(4), style: { wrap: true } },
    [cellId(1, 0)]: { value: "plain" },
  });
  const heights = autoRowHeights(object, () => 100);
  assert.ok(heights[0] > 0);
  assert.equal(heights[1], undefined);
});
