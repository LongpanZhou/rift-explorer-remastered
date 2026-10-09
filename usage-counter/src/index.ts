/**
 * Anonymous install counter. Each app install sends one random ID (a UUID) at most once a
 * day. The Worker counts each new ID once. No name, account or other data is stored.
 *
 * Storage: Workers KV. A new ID costs two KV writes, and the free plan allows 1,000 writes
 * a day, so this counts roughly 500 new installs a day. Past that, move to D1 or Durable
 * Objects.
 */
export interface Env {
  USERS: KVNamespace;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function readCount(kv: KVNamespace): Promise<number> {
  return Number((await kv.get("count")) ?? 0);
}

export async function handle(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return json(null, 204);
  const { pathname } = new URL(req.url);

  if (pathname === "/count" && req.method === "GET") {
    return json({ users: await readCount(env.USERS) });
  }

  if (pathname === "/ping" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
    const id = typeof body?.id === "string" ? body.id : "";
    if (!UUID.test(id)) return json({ error: "id must be a UUID" }, 400);
    const key = `seen:${id}`;
    if ((await env.USERS.get(key)) === null) {
      await env.USERS.put(key, "1");
      await env.USERS.put("count", String((await readCount(env.USERS)) + 1));
    }
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>;
