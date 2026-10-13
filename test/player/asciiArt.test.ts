import { expect, test } from "bun:test";
import { fitsStatusBox, padArt } from "../../src/player/asciiArt";
import { ADV, LINE_WIDTH, NBSP, widthOf } from "../../src/player/width";

// The shades the converter is asked for (src-tauri/src/ascii.rs), darkest first.
const SHADES = "#*+=-:. ";

test("art rows use non-breaking spaces only, since the client collapses plain spaces", () => {
  const [row] = padArt(["# "]);
  expect(row).toContain("#");
  expect(row).not.toContain(" ");
});

test("art rows are padded to the same width: the first and last to 38 '#', the others to 40", () => {
  const rows = padArt(["##", "#"]);
  expect(widthOf(rows[0])).toBe(38 * ADV["#"]);
  expect(widthOf(rows[1])).toBe(38 * ADV["#"]);
  const body = padArt(["#", "#", "#"]);
  expect(widthOf(body[1])).toBe(40 * ADV["#"]);
});

test("a narrow picture is centered in the status box, not left at its edge", () => {
  const rows = padArt(Array.from({ length: 6 }, (_, i) => (i % 2 ? "#".repeat(20) : "#".repeat(14) + " ".repeat(6))));
  const middle = rows[1];
  expect(widthOf(middle)).toBe(40 * ADV["#"]);
  const leading = middle.length - middle.replace(/^ +/, "").length;
  const trailing = middle.length - middle.replace(/ +$/, "").length;
  expect(leading).toBeGreaterThan(0);
  expect(Math.abs(leading - trailing)).toBeLessThanOrEqual(1);
});

test("no art gives no rows", () => {
  expect(padArt([])).toEqual([]);
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
