import { expect, test } from "bun:test";
import { normalizeRows } from "../../src/player/asciiArt";
import { ADV, NBSP, widthOf } from "../../src/player/width";

test("jscii rows lose their newlines and &nbsp; entities become non-breaking spaces", () => {
  expect(normalizeRows("\n#&nbsp;\n.@")).toEqual([`#${NBSP}`, ".#"]);
});

test("the densest symbol @ becomes # so no symbol is wider than 584 units", () => {
  const [row] = normalizeRows("\n@@@@");
  expect(row).not.toContain("@");
  expect(widthOf(row)).toBe(4 * ADV["#"]);
});

test("rows are padded to the same width with non-breaking spaces only", () => {
  const rows = normalizeRows("\n@@@@\n$$");
  expect(rows).toHaveLength(2);
  expect(Math.abs(widthOf(rows[0]) - widthOf(rows[1]))).toBeLessThanOrEqual(ADV[NBSP]);
  expect(rows.join("")).not.toContain(" ");
});

test("empty input gives no rows", () => {
  expect(normalizeRows("")).toEqual([]);
});
