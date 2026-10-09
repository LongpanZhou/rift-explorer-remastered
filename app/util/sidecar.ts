import { existsSync } from "fs";
import { join } from "path";
import { EXIT } from "./exitCodes";
import { ActionRefused } from "./player";
import RiotConnector from "./RiotConnector";

export { EXIT };

/** How long to look for the Riot client process before giving up. */
const DISCOVERY_TIMEOUT_MS = 8000;

/** Default install paths; checking these skips the ~0.5 s process lookup. */
const DEFAULT_LOCKFILES =
  process.platform === "win32"
    ? ["C:\\Riot Games\\League of Legends\\lockfile"]
    : ["/Applications/League of Legends.app/Contents/LoL/lockfile"];

/**
 * Maps any sidecar error to an exit code and a message for the user. This is
 * the only place that decides the kind of error; the UI maps codes to text.
 */
export function classify(err: any): { code: number; message: string } {
  if (err instanceof ActionRefused) {
    return { code: EXIT.ACTION_REFUSED, message: err.message };
  }
  if (err?.code === "ECONNREFUSED") {
    return {
      code: EXIT.CLIENT_UNREACHABLE,
      message: "client not reachable (connection refused). The lockfile may be stale.",
    };
  }
  const status = err?.response?.status;
  if (status === 401) {
    return {
      code: EXIT.AUTH_FAILED,
      message: "authentication failed. The lockfile password is stale; restart the client.",
    };
  }
  if (status) {
    // The client answered; its own reason (e.g. `Invalid preferredCrestType`).
    return {
      code: EXIT.CLIENT_REFUSED,
      message: `${err.response.data?.message ?? err.message} (HTTP ${status})`,
    };
  }
  return { code: EXIT.REQUEST_FAILED, message: String(err?.message ?? err) };
}

/**
 * Resolves the lockfile path: the explicit path if given, then the default
 * install path, then the running Riot client process. Rejects with an exit
 * code and message when none is found.
 */
export async function findLockfile(explicit?: string): Promise<string> {
  const path = explicit ?? DEFAULT_LOCKFILES.find((p) => existsSync(p)) ?? (await discoverLockfile());
  if (!existsSync(path)) {
    throw { code: EXIT.LOCKFILE_MISSING, message: `lockfile not found at ${path}` };
  }
  return path;
}

function discoverLockfile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const connector = new RiotConnector();
    const timer = setTimeout(() => {
      reject({
        code: EXIT.CLIENT_NOT_RUNNING,
        message: "League client not running: no Riot client process found.",
      });
    }, DISCOVERY_TIMEOUT_MS);

    connector.once("riotclient", (leaguePath: string) => {
      clearTimeout(timer);
      resolve(join(leaguePath, "lockfile"));
    });

    // Looks up the Riot client process once. The connector emits "riotclient"
    // only when it finds the process, and it starts no watchers here.
    connector._checkRiotClient();
  });
}
