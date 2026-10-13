/**
 * Lays out ASCII art for the status message. The art itself comes from the converter on the Mac
 * (src-tauri/src/ascii.rs). Here, plain spaces become non-breaking spaces, since the client
 * collapses plain spaces, and every row is padded to the same width.
 */
import { ADV, LINE_WIDTH, NBSP, padTo, widthOf } from "./width";

/**
 * Rows are padded to the width of 40 "#", so the art fills the status box. The client draws status
 * text from the left edge, so a narrower block would sit at the left. The first and last rows also get
 * the client's curly quote, so they are 38 "#" wide. Measured in the client (scripts/ascii_art.ts).
 */
const ROW_WIDTH = 40 * ADV["#"];
const EDGE_ROW_WIDTH = 38 * ADV["#"];

/** Spaces become non-breaking, and rows are padded on both sides to the same width so the art is a block. */
export function padArt(rows: string[]): string[] {
  const spaced = rows.map((row) => row.replace(/ /g, NBSP));
  const last = spaced.length - 1;
  const onEdge = (i: number) => i === 0 || i === last;
  const bodyWidth = Math.max(ROW_WIDTH, ...spaced.filter((_, i) => !onEdge(i)).map(widthOf));
  const edgeWidth = Math.max(EDGE_ROW_WIDTH, ...spaced.filter((_, i) => onEdge(i)).map(widthOf));
  return spaced.map((row, i) => padTo(row, onEdge(i) ? edgeWidth : bodyWidth));
}

/** True when every row fits in the client's status box. A wider row wraps onto a second line. */
export function fitsStatusBox(rows: string[]): boolean {
  return rows.every((row) => widthOf(row) <= LINE_WIDTH);
}
