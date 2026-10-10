/**
 * A fake League client for the tests. `gets` answers reads by path, and every write is recorded
 * in `writes`. A read of a path that is not in `gets` fails, as a missing path does in the client.
 */
import type { LcuClient } from "./player";

export function fakeClient(gets: Record<string, any>) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const missing = (p: string) => ({ response: { status: 404, data: { message: `no ${p}` } } });
  const client: LcuClient = {
    get: async (p) => {
      if (!(p in gets)) throw missing(p);
      return gets[p];
    },
    put: async (path, body) => void writes.push({ method: "PUT", path, body }),
    post: async (path, body) => void writes.push({ method: "POST", path, body }),
    patch: async (path, body) => void writes.push({ method: "PATCH", path, body }),
    delete: async (path) => void writes.push({ method: "DELETE", path, body: undefined }),
    getBytes: async (p) => {
      if (!(p in gets)) throw missing(p);
      return new TextEncoder().encode(String(gets[p]));
    },
  };
  return { client, writes };
}
