/**
 * Turns a picture into ASCII art for the status message. Each cell of the picture becomes
 * one character: dark cells get the dense shades and light cells get spaces. The client
 * collapses plain spaces, so they are sent as non-breaking spaces.
 */
import { LINE_WIDTH, NBSP, padTo, widthOf } from "./width";

/** Dark to light. The widest shades are "+" and "=" (584 units), so 40 of any shade fit the status box. */
export const SHADES = "#*+=-:. ";

/** One character per cell. `luminance` holds one 0 (dark) to 255 (light) value per cell, row by row. */
export function asciiRows(luminance: number[], cols: number, invert: boolean): string[] {
  const rows: string[] = [];
  for (let start = 0; start < luminance.length; start += cols) {
    let row = "";
    for (const value of luminance.slice(start, start + cols)) {
      const light = invert ? 255 - value : value;
      row += SHADES[Math.min(SHADES.length - 1, Math.floor((light * SHADES.length) / 256))];
    }
    rows.push(row);
  }
  return rows;
}

/** Spaces become non-breaking, and every row is padded to the widest one so the art is a block. */
export function padArt(rows: string[]): string[] {
  const spaced = rows.map((row) => row.replace(/ /g, NBSP));
  const widest = Math.max(0, ...spaced.map(widthOf));
  return spaced.map((row) => padTo(row, widest));
}

/** True when every row fits in the client's status box. A wider row wraps onto a second line. */
export function fitsStatusBox(rows: string[]): boolean {
  return rows.every((row) => widthOf(row) <= LINE_WIDTH);
}

/**
 * The luminance of each cell of the picture, row by row, with the picture scaled to fit a
 * cols x rows grid, keeping its proportions, on a white background.
 */
export function cellLuminance(image: HTMLImageElement, cols: number, rows: number): number[] {
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cols, rows);
  const scale = Math.min(cols / image.naturalWidth, rows / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, (cols - w) / 2, (rows - h) / 2, w, h);
  const { data } = ctx.getImageData(0, 0, cols, rows);
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) out.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  return out;
}
