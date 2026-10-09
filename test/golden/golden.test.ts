import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "bun";
import createSpec from "../../app/util/createSpec";

// Golden tests: the spec is built from fixtures recorded from a real client
// (/help?format=Console, /help?format=Full, /system/v1/builds). The fixtures
// hold API metadata only; see the check in the review record (D9).

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const SNAPSHOT = join(import.meta.dir, "snapshot.json");
const SIDECAR = join(import.meta.dir, "..", "..", "app", "util", "sidecar-main.ts");
const PASSWORD = "test-password";
const EXPECTED_AUTH = `Basic ${btoa(`riot:${PASSWORD}`)}`;
const EXPECTED_ROUTES = 769;
const BUILD_VERSION = "16.20.824.8524";

let server: Server;
let dir: string;

function fixtureResponse(name: string): Response {
  return new Response(readFileSync(join(FIXTURES, name), "utf8"), {
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "golden-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: readFileSync(key), cert: readFileSync(cert) },
    fetch(req) {
      if (req.headers.get("authorization") !== EXPECTED_AUTH) {
        return new Response("unauthorized", { status: 401 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/help") {
        const format = url.searchParams.get("format");
        if (format === "Console") return fixtureResponse("help-console.json");
        if (format === "Full") return fixtureResponse("help-full.json");
      }
      if (url.pathname === "/system/v1/builds") {
        return fixtureResponse("system-builds.json");
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

function lockfile(contents: string): string {
  const file = join(dir, `lockfile-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, contents);
  return file;
}

async function runSidecar(args: string[]) {
  const proc = Bun.spawn(["bun", SIDECAR, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("golden spec", () => {
  test("builds the catalog spec from recorded client responses", async () => {
    const spec = await createSpec({
      address: "127.0.0.1",
      port: server.port,
      protocol: "https",
      username: "riot",
      password: PASSWORD,
    });

    expect(spec.swagger).toBe("2.0");
    expect(spec.info.version).toBe(BUILD_VERSION);
    expect(Object.keys(spec.paths).length).toBe(EXPECTED_ROUTES);
    expect(Object.keys(spec.definitions).length).toBeGreaterThan(0);

    // Summaries and methods must match the committed snapshot.
    const summaries = Object.entries(spec.paths)
      .flatMap(([path, ops]) =>
        Object.entries(ops as Record<string, { summary?: string }>).map(
          ([method, op]) => [path, method, op.summary ?? ""]
        )
      )
      .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));

    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(SNAPSHOT)) {
      writeFileSync(SNAPSHOT, JSON.stringify(summaries, null, 2) + "\n");
    }
    expect(summaries).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
  });
});

describe("sidecar CLI contract", () => {
  test("prints only the spec JSON on stdout and exits 0", async () => {
    const file = lockfile(`LeagueClient:1:${server.port}:${PASSWORD}:https`);
    const { code, stdout, stderr } = await runSidecar(["--lockfile", file]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const spec = JSON.parse(stdout);
    expect(spec.swagger).toBe("2.0");
    expect(Object.keys(spec.paths).length).toBe(EXPECTED_ROUTES);
  });

  test("exits 3 when the lockfile is missing", async () => {
    const { code, stdout, stderr } = await runSidecar([
      "--lockfile",
      join(dir, "does-not-exist"),
    ]);
    expect(code).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).toContain("lockfile not found");
  });

  test("exits 4 when the lockfile is malformed", async () => {
    const file = lockfile("LeagueClient:1:not-a-port");
    const { code, stdout, stderr } = await runSidecar(["--lockfile", file]);
    expect(code).toBe(4);
    expect(stdout).toBe("");
    expect(stderr).toContain("malformed lockfile");
  });

  test("exits 5 when the client port refuses connections", async () => {
    // Start a server to get a free port, then stop it so the port refuses.
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    const file = lockfile(`LeagueClient:1:${port}:${PASSWORD}:https`);
    const { code, stdout, stderr } = await runSidecar(["--lockfile", file]);
    expect(code).toBe(5);
    expect(stdout).toBe("");
    expect(stderr).toContain("connection refused");
  });

  test("exits 6 when the password is rejected", async () => {
    const file = lockfile(`LeagueClient:1:${server.port}:wrong-password:https`);
    const { code, stdout, stderr } = await runSidecar(["--lockfile", file]);
    expect(code).toBe(6);
    expect(stdout).toBe("");
    expect(stderr).toContain("authentication failed");
  });
});
