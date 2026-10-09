import { expect, test } from "bun:test";
import { ActionRefused, type LcuClient } from "./player";
import { handlePhone, phoneChoose, phoneSpells, phoneState, resetPasscodeFailures } from "./phone";

// A fake client: reads come from `gets`, writes are recorded in `writes`.
function fakeClient(gets: Record<string, any>) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const client: LcuClient = {
    get: async (p) => {
      if (!(p in gets)) throw { response: { status: 404, data: { message: `no ${p}` } } };
      return gets[p];
    },
    put: async (path, body) => void writes.push({ method: "PUT", path, body }),
    post: async (path, body) => void writes.push({ method: "POST", path, body }),
    patch: async (path, body) => void writes.push({ method: "PATCH", path, body }),
    getBytes: async () => new Uint8Array(),
  };
  return { client, writes };
}

const PHASE = "/lol-gameflow/v1/gameflow-phase";
const SESSION = "/lol-champ-select/v1/session";
const PICKABLE = "/lol-champ-select/v1/pickable-champion-ids";
const BANNABLE = "/lol-champ-select/v1/bannable-champion-ids";
const NAMES = "/lol-game-data/assets/v1/champion-summary.json";
const SELECTION = "/lol-champ-select/v1/session/my-selection";
const SWAPS = "/lol-champ-select/v1/session/champion-swaps";

const turnPick = { id: 7, actorCellId: 2, type: "pick", isInProgress: true, completed: false, championId: 0 };
const team = [
  { cellId: 2, championId: 0, championPickIntent: 0 },
  { cellId: 3, championId: 0, championPickIntent: 3 },
];
const session = (actions: any[][], extra: any = {}) => ({
  localPlayerCellId: 2,
  actions,
  myTeam: team,
  theirTeam: [{ championId: 9 }],
  bans: { myTeamBans: [], theirTeamBans: [] },
  ...extra,
});
const world = (actions: any[][], extra: any = {}) => ({
  [PHASE]: "ChampSelect",
  [SESSION]: session(actions, extra),
  [PICKABLE]: [1, 2, 3],
  [BANNABLE]: [1, 2, 3],
  [NAMES]: [
    { id: 1, name: "Annie" },
    { id: 2, name: "Olaf" },
    { id: 3, name: "Galio" },
    { id: 9, name: "Ahri" },
  ],
  [SELECTION]: { spell1Id: 4, spell2Id: 14 },
  [SWAPS]: [],
});

test("state shows names, your turn and options; outside champ select it says so", async () => {
  const { client } = fakeClient(world([[turnPick]]));
  const state: any = await phoneState(client);
  expect(state.inChampSelect).toBe(true);
  expect(state.turn).toEqual({ id: 7, type: "pick", championId: 0, name: "" });
  expect(state.options).toEqual([
    { id: 1, name: "Annie" },
    { id: 2, name: "Olaf" },
    { id: 3, name: "Galio" },
  ]);
  expect(state.enemies).toEqual(["Ahri"]);
  expect(state.spells).toEqual({ spell1: 4, spell2: 14 });
  const outside = await phoneState(fakeClient({ [PHASE]: "Lobby" }).client);
  expect(outside).toEqual({ phase: "Lobby", inChampSelect: false });
});

test("choose hovers, locks, and refuses a champion a teammate has or is not allowed", async () => {
  const hover = fakeClient(world([[turnPick]]));
  await phoneChoose(hover.client, 2, false);
  expect(hover.writes[0]).toEqual({ method: "PATCH", path: "/lol-champ-select/v1/session/actions/7", body: { championId: 2, completed: false } });

  const lock = fakeClient(world([[turnPick]]));
  await phoneChoose(lock.client, 2, true);
  expect((lock.writes[0].body as any).completed).toBe(true);

  // Galio (3) is hovered by a teammate (their intent): refused, nothing sent.
  const taken = fakeClient(world([[turnPick]]));
  await expect(phoneChoose(taken.client, 3, true)).rejects.toBeInstanceOf(ActionRefused);
  expect(taken.writes).toHaveLength(0);

  // A champion not in the pickable list is refused.
  await expect(phoneChoose(fakeClient(world([[turnPick]])).client, 99, true)).rejects.toBeInstanceOf(ActionRefused);
});

test("spells must be two different ids and are sent as the client expects", async () => {
  const { client, writes } = fakeClient({});
  await expect(phoneSpells(client, 4, 4)).rejects.toBeInstanceOf(ActionRefused);
  await phoneSpells(client, 4, 14);
  expect(writes[0]).toEqual({ method: "PATCH", path: SELECTION, body: { spell1Id: 4, spell2Id: 14 } });
});

test("requests without the right passcode are refused, and the page is served without it", async () => {
  const deps = { client: fakeClient(world([[turnPick]])).client, passcode: "482913" };
  const page = await handlePhone(new Request("http://mac.local:8787/"), deps);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Champion select");
  const bad = await handlePhone(new Request("http://mac.local:8787/api/state", { headers: { "x-passcode": "000000" } }), deps);
  expect(bad.status).toBe(401);
  const good = await handlePhone(new Request("http://mac.local:8787/api/state", { headers: { "x-passcode": "482913" } }), deps);
  expect(good.status).toBe(200);
  expect((await good.json()).inChampSelect).toBe(true);
});

test("after 20 wrong passcodes the server refuses for a minute, even the right one", async () => {
  const deps = { client: fakeClient({}).client, passcode: "111111" };
  for (let i = 0; i < 20; i++) {
    await handlePhone(new Request("http://mac.local:8787/api/state", { headers: { "x-passcode": "wrong" } }), deps);
  }
  const blocked = await handlePhone(new Request("http://mac.local:8787/api/state", { headers: { "x-passcode": "111111" } }), deps);
  expect(blocked.status).toBe(429);
});

test("a client that is not running is reported as such, not as a connection error", async () => {
  resetPasscodeFailures();
  const deps = {
    client: { ...fakeClient({}).client, get: async () => { throw { code: "ECONNREFUSED" }; } } as LcuClient,
    passcode: "482913",
  };
  const res = await handlePhone(new Request("http://mac.local:8787/api/state", { headers: { "x-passcode": "482913" } }), deps);
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("League client not running");
});
