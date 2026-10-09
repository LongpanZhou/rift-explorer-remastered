import { expect, test } from "bun:test";
import { fillerFor, LINE_INDENT, LINE_WIDTH, widthOf } from "../../src/player/width";

test("a filler pads a line to the measured line width, whatever it already holds", () => {
  for (const text of ["", "abc", "#####", "Testing", "Ekko mid \u26a1 and more text here"]) {
    const total = widthOf(text + fillerFor(text));
    // Within half a non-breaking space of the target.
    expect(Math.abs(total - LINE_WIDTH)).toBeLessThanOrEqual(139);
  }
});

test("a line already at or past the target gets no filler", () => {
  expect(fillerFor("#".repeat(46))).toBe("");
});

test("the indent plus the narrowest first character is wider than the room left, so the next line moves down", () => {
  const roomLeftMax = 25631 - LINE_WIDTH; // the row is narrower than 25,631 units
  const narrowestChar = 222; // "i" and "l"
  expect(widthOf(LINE_INDENT) + narrowestChar).toBeGreaterThan(roomLeftMax);
  expect(LINE_WIDTH).toBeLessThanOrEqual(25353); // a padded line always fits
});
