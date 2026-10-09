import { invoke } from "@tauri-apps/api/core";
import { EXIT } from "../app/util/exitCodes";

/** Error returned by the Tauri commands; `code` is a sidecar exit code. */
export interface SidecarError {
  code: number;
  message: string;
}

const MESSAGES: Record<number, string> = {
  [EXIT.CLIENT_NOT_RUNNING]: "The League client is not running.",
  [EXIT.LOCKFILE_MISSING]: "The League client lockfile was not found. Start the League client.",
  [EXIT.LOCKFILE_MALFORMED]: "The League client lockfile is malformed.",
  [EXIT.CLIENT_UNREACHABLE]: "The League client is not reachable. Its lockfile may be stale. Restart the client.",
  [EXIT.AUTH_FAILED]: "Authentication failed. Restart the League client to refresh its password.",
};

export function messageFor(error: SidecarError): string {
  switch (error.code) {
    case EXIT.ACTION_REFUSED:
      return `Not changed: ${error.message}`;
    case EXIT.CLIENT_REFUSED:
      return `The client refused: ${error.message}`;
    default:
      return MESSAGES[error.code] ?? `Could not reach the client: ${error.message}`;
  }
}

/** Calls a Tauri command whose result is a JSON string. */
export function invokeJson<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<string>(cmd, args).then((text) => JSON.parse(text));
}
