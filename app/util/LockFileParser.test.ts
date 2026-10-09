import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse } from "./LockFileParser";

function lockfileWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lockfile-test-"));
  const file = join(dir, "lockfile");
  writeFileSync(file, contents);
  return file;
}

describe("LockFileParser.parse", () => {
  test("reads name, pid, port, password and protocol from a valid lockfile", async () => {
    const lock = await parse(
      lockfileWith("LeagueClient:1234:55555:dummy-password:https")
    );
    expect(lock).toEqual({
      username: "riot",
      processName: "LeagueClient",
      PID: 1234,
      port: 55555,
      password: "dummy-password",
      protocol: "https",
      address: "127.0.0.1",
    });
  });

  test("accepts a trailing newline", async () => {
    const lock = await parse(
      lockfileWith("LeagueClient:1234:55555:dummy-password:https\n")
    );
    expect(lock.port).toBe(55555);
  });

  test("rejects a line with too few fields", async () => {
    await expect(
      parse(lockfileWith("LeagueClient:1234:55555:dummy-password"))
    ).rejects.toThrow("expected 5 fields, found 4");
  });

  test("rejects a non-numeric port", async () => {
    await expect(
      parse(lockfileWith("LeagueClient:1234:not-a-port:dummy-password:https"))
    ).rejects.toThrow("pid or port is not a number");
  });
});
