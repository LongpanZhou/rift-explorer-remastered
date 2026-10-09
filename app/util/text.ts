/**
 * Text is sent to the sidecar as "n" + UTF-8 hex, so a command argument is always a
 * plain word. The sidecar decodes it (decodeName in player.ts).
 */
export function encodeText(text: string): string {
  return "n" + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}
