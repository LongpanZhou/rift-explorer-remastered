import { describe, expect, test } from "bun:test";
import { buildCatalogPaths } from "./catalogPaths";
import { LCU_ENDPOINTS, LcuEndpoint } from "./endpointCatalog";

const sample: LcuEndpoint[] = [
  {
    path: "/lol-summoner/v1/summoners",
    methods: ["GET", "POST"],
    status: "needs-params",
    summary: "Look up a summoner",
    query: [{ name: "name", required: true, array: false }],
  },
  {
    path: "/lol-lobby/v2/lobby",
    methods: ["GET"],
    status: "state-dependent",
    summary: "Current lobby",
    query: [],
  },
];

describe("buildCatalogPaths", () => {
  test("keys paths by route and lowercases methods", () => {
    const paths = buildCatalogPaths(sample);
    expect(Object.keys(paths).sort()).toEqual([
      "/lol-lobby/v2/lobby",
      "/lol-summoner/v1/summoners",
    ]);
    expect(Object.keys(paths["/lol-summoner/v1/summoners"]).sort()).toEqual([
      "get",
      "post",
    ]);
  });

  test("prefixes the summary with the route status", () => {
    const paths = buildCatalogPaths(sample);
    expect(paths["/lol-lobby/v2/lobby"].get.summary).toBe(
      "[state-dependent] Current lobby"
    );
  });

  test("maps query parameters to required query params", () => {
    const paths = buildCatalogPaths(sample);
    expect(paths["/lol-summoner/v1/summoners"].get.parameters).toEqual([
      {
        in: "query",
        name: "name",
        required: true,
        type: "string",
        description: undefined,
      },
    ]);
  });

  test("tags each operation with the first path segment", () => {
    const paths = buildCatalogPaths(sample);
    expect(paths["/lol-lobby/v2/lobby"].get.tags).toEqual(["lol-lobby"]);
  });
});

describe("LCU_ENDPOINTS", () => {
  test("every catalog entry has at least one HTTP method", () => {
    // Routes with an empty Allow header were RPC-only and are not listed.
    const empty = LCU_ENDPOINTS.filter((e) => e.methods.length === 0);
    expect(empty.map((e) => e.path)).toEqual([]);
  });

  test("every catalog entry has a known status", () => {
    const known = new Set([
      "ok",
      "needs-params",
      "state-dependent",
      "conflict",
      "server-error",
      "unreachable",
      "other",
      "exists-not-invoked",
    ]);
    expect(LCU_ENDPOINTS.filter((e) => !known.has(e.status))).toEqual([]);
  });
});
