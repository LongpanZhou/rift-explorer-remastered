import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findLockfile, REMEMBERED_LOCKFILE } from "../../app/util/sidecar";

// Looking up the client process starts PowerShell on Windows, which takes seconds; a found
// lockfile path is remembered so the next start (of the phone page, of any command) skips it.

const before = existsSync(REMEMBERED_LOCKFILE) ? readFileSync(REMEMBERED_LOCKFILE, "utf8") : null;
afterAll(() => (before === null ? rmSync(REMEMBERED_LOCKFILE, { force: true }) : writeFileSync(REMEMBERED_LOCKFILE, before)));

test("a remembered lockfile is used without looking the client up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "league-"));
  const lockfile = join(dir, "lockfile");
  writeFileSync(lockfile, "LeagueClient:1:2:pw:https");
  writeFileSync(REMEMBERED_LOCKFILE, lockfile);
  const t = Date.now();
  expect(await findLockfile()).toBe(lockfile);
  expect(Date.now() - t).toBeLessThan(200);
});

test("an explicit lockfile still wins over the remembered one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "league-"));
  const lockfile = join(dir, "lockfile");
  writeFileSync(lockfile, "LeagueClient:1:2:pw:https");
  expect(await findLockfile(lockfile)).toBe(lockfile);
});
