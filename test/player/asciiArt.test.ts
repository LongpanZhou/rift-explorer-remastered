import { expect, test } from "bun:test";
import { asciiRows, fitsStatusBox, padArt, SHADES } from "../../src/player/asciiArt";
import { ADV, LINE_WIDTH, NBSP, widthOf } from "../../src/player/width";

test("dark cells get the densest shade and light cells get a space", () => {
  expect(asciiRows([0, 255], 2, false)).toEqual([`${SHADES[0]} `]);
});

test("the shade follows the luminance in eight even steps", () => {
  expect(asciiRows([31, 32], 2, false)).toEqual([`${SHADES[0]}${SHADES[1]}`]);
  expect(asciiRows([224, 255], 2, false)).toEqual([`${SHADES[7]}${SHADES[7]}`]);
});

test("cells are cut into rows of the given width", () => {
  expect(asciiRows([0, 0, 255, 255], 2, false)).toEqual([`${SHADES[0]}${SHADES[0]}`, `${SHADES[7]}${SHADES[7]}`]);
});

test("invert swaps dark and light", () => {
  expect(asciiRows([0, 255], 2, true)).toEqual([` ${SHADES[0]}`]);
});

test("no picture gives no rows", () => {
  expect(asciiRows([], 10, false)).toEqual([]);
  expect(padArt([])).toEqual([]);
});

test("art rows use non-breaking spaces only, since the client collapses plain spaces", () => {
  expect(padArt(["# "])).toEqual([`#${NBSP}`]);
});

test("art rows are padded to the same width", () => {
  const rows = padArt(["##", "#"]);
  expect(rows).toEqual([`##`, `${NBSP}#${NBSP}`]);
  expect(widthOf(rows[0])).toBe(widthOf(rows[1]));
});

test("40 columns of any shade fit the status box", () => {
  expect(fitsStatusBox(padArt([SHADES.repeat(5)]))).toBe(true);
  expect(fitsStatusBox(padArt(["=".repeat(40)]))).toBe(true);
});

test("60 columns of the widest shade do not fit the status box, so the slider can preview them but not set them", () => {
  expect(fitsStatusBox(padArt(["=".repeat(60)]))).toBe(false);
});

test("a row of 45 '#' fits the status box and one more '#' does not", () => {
  expect(fitsStatusBox(["#".repeat(45)])).toBe(true);
  expect(fitsStatusBox(["#".repeat(46)])).toBe(false);
  expect(widthOf("#".repeat(45))).toBeLessThanOrEqual(LINE_WIDTH);
});

test("a wide row makes the whole art too wide, even when the other rows fit", () => {
  expect(fitsStatusBox(["#".repeat(10), "#".repeat(60), "#".repeat(10)])).toBe(false);
});

test("no rows fit trivially", () => {
  expect(fitsStatusBox([])).toBe(true);
});

test("every shade has a width estimate, so the status box check covers it", () => {
  expect(SHADES).toHaveLength(8);
  for (const shade of SHADES) expect(ADV[shade]).toBeDefined();
});
