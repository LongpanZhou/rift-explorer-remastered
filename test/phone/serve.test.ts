import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The phone server must not outlive the app. The app keeps a pipe on the sidecar's stdin; when
// the app exits (even killed by the system), the pipe closes and the sidecar exits, so the next
// run finds port 8787 free instead of moving to the next one. This runs the real sidecar.

test("the phone server exits when its stdin closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rift-phone-serve-"));
  const lock = join(dir, "lockfile");
  writeFileSync(lock, "LeagueClient:1:1:password:https");
  const port = 20500 + Math.floor(Math.random() * 1500);
  const token = "0123456789abcdef0123456789abcdef";
  const proc = Bun.spawn(
    ["bun", "app/util/sidecar-main.ts", "--lockfile", lock, "serve", String(port), token],
    { cwd: process.cwd(), stdin: "pipe", stdout: "ignore", stderr: "pipe", env: { ...process.env, RIFT_PHONE_STDIN: "1" } }
  );

  try {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    let out = "";
    const limit = Date.now() + 12000;
    while (Date.now() < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value);
      if (out.includes("phone page on port")) break;
    }
    expect(out).toContain("phone page on port");

    // The app exits: its end of the pipe closes.
    proc.stdin?.end();
    const code = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("timeout"), 4000))]);
    expect(code).not.toBe("timeout");
    expect(proc.exitCode).toBe(0);
  } finally {
    if (proc.exitCode === null) proc.kill();
  }
}, 20000);
