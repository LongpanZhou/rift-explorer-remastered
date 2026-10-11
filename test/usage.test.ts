import { afterEach, describe, expect, test } from "bun:test";
import { fetchDownloadCount } from "../src/usage";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const answer = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
};

describe("fetchDownloadCount", () => {
  test("adds up the downloads of every file in every release", async () => {
    answer([{ assets: [{ download_count: 2 }, { download_count: 5 }] }, { assets: [{ download_count: 1 }] }, {}]);
    expect(await fetchDownloadCount()).toBe(8);
  });

  test("is 0 when there are no releases", async () => {
    answer([]);
    expect(await fetchDownloadCount()).toBe(0);
  });

  test("is null when GitHub refuses, e.g. over its rate limit", async () => {
    answer({ message: "API rate limit exceeded" }, 403);
    expect(await fetchDownloadCount()).toBeNull();
  });
});
