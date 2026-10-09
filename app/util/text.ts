/**
 * Text is sent to the sidecar as "n" + UTF-8 hex, so a command argument is always a
 * plain word. The sidecar decodes it (decodeName in player.ts).
 */
export function encodeText(text: string): string {
  return "n" + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Splits status text into the lines the client shows. Display only. */
export function splitClientLines(text: string): string[] {
  return text.split(/\r\n|\r|\n|\u2028|\u2029/);
}

/** Joins lines the way the client stores them: a carriage return between lines. */
export function joinClientLines(lines: string[]): string {
  return lines.join("\r");
}

/** Turns the line breaks typed in the editor (\r\n or \n) into the client's \r. A lone \r is kept. */
export function toClientText(typed: string): string {
  return joinClientLines(typed.split(/\r\n|\n/));
}
