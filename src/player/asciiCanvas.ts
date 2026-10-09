/**
 * Runs jscii (MIT, by Dominick Pham, https://github.com/EnotionZ/jscii) on a canvas
 * that already holds the picture at cols x rows pixels, one pixel per character.
 */
import "jscii";
import { normalizeRows } from "./asciiArt";

const Jscii = (window as unknown as { Jscii: new (params: object) => Jscii }).Jscii;
interface Jscii {
  dimension(width: number, height: number): Jscii;
  render(): void;
}

export function asciiFromCanvas(source: HTMLCanvasElement, cols: number, rows: number, invert: boolean): string[] {
  if (invert) {
    // Inverted by hand, because canvas filters are not supported in every webview.
    const ctx = source.getContext("2d");
    if (!ctx) return [];
    const image = ctx.getImageData(0, 0, cols, rows);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = 255 - image.data[i];
      image.data[i + 1] = 255 - image.data[i + 1];
      image.data[i + 2] = 255 - image.data[i + 2];
    }
    ctx.putImageData(image, 0, 0);
  }
  let raw = "";
  const converter = new Jscii({ el: source, width: cols, fn: (text: string) => (raw = text) });
  converter.dimension(cols, rows).render();
  return normalizeRows(raw);
}
