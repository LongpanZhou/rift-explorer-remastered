import { expect, test } from "bun:test";
import { handle, type Env } from "./index";

// An in-memory stand-in for the KV namespace, enough for the counter's reads and writes.
function fakeKv() {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => void map.set(k, v),
  } as unknown as KVNamespace & { map: Map<string, string> };
}

const ID = "3f2c9a10-7b1e-4d2a-9c3e-0a1b2c3d4e5f";
const post = (body: unknown) =>
  new Request("https://counter.test/ping", { method: "POST", body: JSON.stringify(body) });

test("a new install is counted once; repeat pings do not count again", async () => {
  const env = { USERS: fakeKv() } as Env;
  await handle(post({ id: ID }), env);
  await handle(post({ id: ID }), env);
  const count = await handle(new Request("https://counter.test/count"), env);
  expect(await count.json()).toEqual({ users: 1 });
  await handle(post({ id: "00000000-0000-4000-8000-000000000000" }), env);
  expect(await (await handle(new Request("https://counter.test/count"), env)).json()).toEqual({ users: 2 });
});

test("ids that are not UUIDs are refused and not counted", async () => {
  const env = { USERS: fakeKv() } as Env;
  const res = await handle(post({ id: "robert'); drop table" }), env);
  expect(res.status).toBe(400);
  expect(env.USERS.map.size).toBe(0);
});

test("unknown routes return 404 and OPTIONS answers CORS", async () => {
  const env = { USERS: fakeKv() } as Env;
  expect((await handle(new Request("https://counter.test/nope"), env)).status).toBe(404);
  const pre = await handle(new Request("https://counter.test/ping", { method: "OPTIONS" }), env);
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe("*");
});
