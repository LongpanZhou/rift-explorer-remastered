/**
 * ASCII pixel art whose rows all measure the same width.
 *
 * The status text is drawn in a proportional font, so one character can be wider
 * than another. Widths below are Helvetica advance widths (units per 1000 em),
 * measured against "D" as the unit, so "50 D" means one row is as wide as 50 D's.
 * The client's own font is not known, so this is an estimate.
 *
 *   bun scripts/ascii_art.ts          print the art and each row's width in D
 *   bun scripts/ascii_art.ts --set    also set it as your status message
 */
import { join } from "path";

import { D, NBSP, widthOf } from "../src/player/width";
import { padArt } from "../src/player/asciiArt";
import { encodeText, joinClientLines } from "../app/util/text";

/**
 * Smiley on a grid of `cols` x `rows` cells: non-breaking spaces for background,
 * '#' for the face, 'o' for eyes and mouth. Features are placed relative to the grid size.
 */
function smiley(cols = 30, rows = 20): string[] {
  const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
  const eyeY = Math.round(rows * 0.3), eyeDx = Math.round(cols * 0.2);
  const mouthY = Math.round(rows * 0.6), mouthDx = Math.round(cols * 0.22);
  const cell = (x: number, y: number) => {
    const dx = (x - cx) / (cols * 0.47), dy = (y - cy) / (rows * 0.46);
    if (dx * dx + dy * dy > 1) return NBSP;
    if (y === eyeY && Math.abs(Math.abs(x - cx) - eyeDx) < 1) return "o";
    if (y === mouthY && Math.abs(x - cx) >= mouthDx - 1 && Math.abs(x - cx) <= mouthDx) return "o";
    if (y === mouthY + 1 && Math.abs(x - cx) < mouthDx - 1) return "o";
    return "#";
  };
  return Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => cell(x, y)).join(""));
}


const rows = padArt(smiley());
const text = joinClientLines(rows);

for (const r of rows) console.log(`${r}  ${(widthOf(r) / D).toFixed(2)} D`);

if (process.argv.includes("--set")) {
  const sidecar = join(import.meta.dir, "..", "src-tauri", "binaries", "lcu-sidecar-aarch64-apple-darwin");
  const out = Bun.spawnSync([sidecar, "player", "set-status-message", encodeText(text)]);
  console.error(out.exitCode === 0 ? "status set" : `failed: ${out.stderr.toString()}`);
}
