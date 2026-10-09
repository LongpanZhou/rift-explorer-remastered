/**
 * Sidecar exit codes. Shared by the sidecar and the UI (src/errors.ts); this
 * module has no imports so the webview bundle can use it.
 */
export const EXIT = {
  OK: 0,
  REQUEST_FAILED: 1,
  CLIENT_NOT_RUNNING: 2,
  LOCKFILE_MISSING: 3,
  LOCKFILE_MALFORMED: 4,
  CLIENT_UNREACHABLE: 5,
  AUTH_FAILED: 6,
  /** Refused by the sidecar before anything was sent. */
  ACTION_REFUSED: 7,
  /** The client answered with an HTTP error; the message is its reason. */
  CLIENT_REFUSED: 8,
} as const;
