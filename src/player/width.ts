/**
 * Advance widths in Helvetica units (per 1000 em), used to size status text.
 * The client's font is not known, so these are estimates. D is the unit of length.
 */
export const ADV: Record<string, number> = {
  " ": 278, "\u00a0": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191, "(": 333, ")": 333,
  "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278, ":": 278, ";": 278, "<": 584, "=": 584,
  ">": 584, "?": 556, "@": 1015, "[": 278, "\\": 278, "]": 278, "^": 469, "_": 556, "`": 333, "{": 334,
  "|": 260, "}": 334, "~": 584,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
  n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556, "8": 556, "9": 556,
};

export const NBSP = "\u00a0";
export const D = ADV.D;
/** Width of text in units. Characters without a width are counted as "#" (556). */
export function widthOf(text: string): number {
  return [...text].reduce((sum, c) => sum + (ADV[c] ?? ADV["#"]), 0);
}
/**
 * Measured in the client: a row holds 40 "#" and 9 non-breaking spaces with a Z after
 * them, and not 10 spaces. So a row is between 25,353 and 25,631 units wide.
 * Lines are padded to 40 "#" and 11 spaces (25,298 units), which always fits.
 * That leaves at most 333 units on the row, so the next line's first word must not fit.
 */
export const LINE_WIDTH = 40 * ADV["#"] + 11 * ADV[NBSP];
/** Non-breaking spaces that pad a line out to LINE_WIDTH, given what is already on it. */
export function fillerFor(lineText: string): string {
  const need = LINE_WIDTH - widthOf(lineText);
  return NBSP.repeat(Math.max(0, Math.round(need / ADV[NBSP])));
}
/**
 * One non-breaking space starts each line after a new line. With the room left at most
 * 333 units, the space (278) plus the narrowest first character (222) is wider than that,
 * so the next line's first word moves down.
 */
export const LINE_INDENT = NBSP;

/** Pads text with non-breaking spaces, on both sides, to `units` wide (within half a space). */
export function padTo(text: string, units: number): string {
  const spaces = Math.round((units - widthOf(text)) / ADV[NBSP]);
  if (spaces < 0) throw new Error("text is wider than the target");
  const left = Math.floor(spaces / 2);
  return NBSP.repeat(left) + text + NBSP.repeat(spaces - left);
}
