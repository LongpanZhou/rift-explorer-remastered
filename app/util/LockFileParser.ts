import { readFile } from "fs-extra";

export interface LockFile {
  username: string;
  password: string;
  port: number;
  protocol: string;
  PID: number;
  processName: string;
  address: string;
}

/**
 * Reads from the path provided and parses it.
 * The lockfile format is name:pid:port:password:protocol. Throws when the
 * line does not have five fields or the pid or port is not a number.
 * @param path {string}
 * @since 7.0.0
 */
export async function parse(path: string): Promise<LockFile> {
  const data = await readFile(path, "utf8");
  const parts = data.trim().split(":");

  if (parts.length !== 5) {
    throw new Error(
      `malformed lockfile: expected 5 fields, found ${parts.length}`
    );
  }

  const PID = Number(parts[1]);
  const port = Number(parts[2]);
  if (!Number.isInteger(PID) || !Number.isInteger(port)) {
    throw new Error("malformed lockfile: pid or port is not a number");
  }

  return {
    username: "riot",
    processName: parts[0],
    PID,
    port,
    password: parts[3],
    protocol: parts[4],
    address: "127.0.0.1",
  };
}
