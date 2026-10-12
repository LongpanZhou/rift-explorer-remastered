import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { lcuClient } from "../../app/util/player";
import { phoneRune } from "../../app/util/phone";

// The real lcuClient (the project's own axios) against a local HTTPS server with a self-signed
// certificate, as the League client runs. Other tests replace the client, so they cannot see
// what axios actually sends.

let server: ReturnType<typeof Bun.serve> | undefined;
const seen: { method: string; path: string; type: string | null; body: string }[] = [];

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "lcu-tls-"));
  const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")]);
  if (made.exitCode !== 0) return; // no openssl: the tests below are skipped
  server = Bun.serve({
    port: 0,
    tls: { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname, type: req.headers.get("content-type"), body: await req.text() });
      if (url.pathname === "/lol-perks/v1/pages") return Response.json([{ id: 11, name: "Mage", isEditable: true }]);
      return Response.json({});
    },
  });
});
afterAll(() => server?.stop());

const client = () => lcuClient({ address: "127.0.0.1", port: server!.port, password: "pw" });

test("switching the current rune page sends the id as a JSON body", async () => {
  if (!server) return;
  seen.length = 0;
  await phoneRune(client(), 11);
  expect(seen.at(-1)).toEqual({ method: "PUT", path: "/lol-perks/v1/currentpage", type: "application/json", body: "11" });
});

test("object bodies are sent as JSON too", async () => {
  if (!server) return;
  seen.length = 0;
  await client().patch("/lol-champ-select/v1/session/actions/7", { championId: 2, completed: true });
  expect(seen[0]).toEqual({ method: "PATCH", path: "/lol-champ-select/v1/session/actions/7", type: expect.stringMatching(/^application\/json/), body: '{"championId":2,"completed":true}' });
});
