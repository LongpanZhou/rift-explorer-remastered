/**
 * Pads the rows that jscii produces so they all have the same width in the client.
 * jscii writes rows separated by newlines, and spaces as "&nbsp;" entities. The
 * densest symbol "@" is 1,015 units wide, so it is replaced with "#" (556).
 */
import { NBSP, padTo, widthOf } from "./width";

export function normalizeRows(raw: string): string[] {
  const rows = raw
    .split("\n")
    .filter((row) => row.length > 0)
    .map((row) => row.replace(/&nbsp;/g, NBSP).replace(/@/g, "#"));
  const widest = Math.max(0, ...rows.map(widthOf));
  return rows.map((row) => padTo(row, widest));
}
