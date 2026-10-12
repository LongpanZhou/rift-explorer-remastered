import { beforeEach, expect, test } from "bun:test";
import { ActionRefused, type LcuClient } from "./player";
import { handlePhone, phoneDodge, phoneSwap, phoneCancelQueue, phoneChoose, phoneLeaveLobby, phoneMode, phoneQueue, phoneReadyCheck, phoneSkin, phoneSpells, phoneState, resetModeCache, type PhoneDeps } from "./phone";
import { resetIconCache } from "./phoneIcons";
import { resetRuneIconCache } from "./phoneRunes";
import { fakeClient } from "./fakeClient";

beforeEach(() => {
  resetIconCache();
  resetRuneIconCache();
  resetModeCache();
});

// A Data Dragon stub. It answers like the site and records every URL it is asked for.
// With `down`, every request fails with a 500.
function ddragon(down = false) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    if (down) return new Response("down", { status: 500 });
    if (url.endsWith("/api/versions.json")) return Response.json(["16.1.1", "16.0.1"]);
    if (url.endsWith("/summoner.json")) return Response.json(SUMMONER_JSON);
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  };
  return { fetch, urls };
}

const MAC = "http://mac.local:8787";
const PHASE = "/lol-gameflow/v1/gameflow-phase";
const SESSION = "/lol-champ-select/v1/session";
const PICKABLE = "/lol-champ-select/v1/pickable-champion-ids";
const BANNABLE = "/lol-champ-select/v1/bannable-champion-ids";
const NAMES = "/lol-game-data/assets/v1/champion-summary.json";
const SELECTION = "/lol-champ-select/v1/session/my-selection";
const SWAPS = "/lol-champ-select/v1/session/champion-swaps";
const ORDER_SWAPS = "/lol-champ-select/v1/session/pick-order-swaps";
const PAGES = "/lol-perks/v1/pages";
const DISALLOWED = "/lol-gameflow/v1/session/per-position-summoner-spells/disallowed";
const ACTION = "/lol-champ-select/v1/session/actions/7";

// Mark is an ARAM-only spell, so the spell list must leave it out.
const SUMMONER_JSON = {
  data: {
    SummonerFlash: { id: "SummonerFlash", key: "4", name: "Flash", image: { full: "SummonerFlash.png" }, modes: ["CLASSIC", "ARAM"] },
    SummonerDot: { id: "SummonerDot", key: "14", name: "Ignite", image: { full: "SummonerDot.png" }, modes: ["CLASSIC", "ARAM"] },
    SummonerSnowball: { id: "SummonerSnowball", key: "32", name: "Mark", image: { full: "SummonerSnowball.png" }, modes: ["KIWI", "ARAM"] },
  },
};

const turnPick = { id: 7, actorCellId: 2, type: "pick", isInProgress: true, completed: false, championId: 0 };
const team = [
  { cellId: 2, championId: 0, championPickIntent: 0, assignedPosition: "middle", spell1Id: 4, spell2Id: 14 },
  { cellId: 3, championId: 0, championPickIntent: 3, assignedPosition: "jungle" },
];
const session = (actions: any[][], extra: any = {}) => ({
  localPlayerCellId: 2,
  actions,
  myTeam: team,
  theirTeam: [
    { cellId: 6, championId: 9 },
    { cellId: 7, championId: 0 },
  ],
  bans: { myTeamBans: [], theirTeamBans: [] },
  timer: { adjustedTimeLeftInPhase: 25000 },
  ...extra,
});
const PAGES_LIST = [
  { id: 11, name: "Mage", current: false, isEditable: true, primaryStyleId: 8100, subStyleId: 8200, selectedPerkIds: [8112] },
  { id: 12, name: "Fixed", current: true, isEditable: false, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: [8005] },
];
const world = (actions: any[][], extra: any = {}) => ({
  [PHASE]: "ChampSelect",
  [SESSION]: session(actions, extra),
  [PICKABLE]: [1, 2, 3],
  [BANNABLE]: [1, 2, 3],
  [NAMES]: [
    { id: 1, name: "Annie", alias: "Annie", roles: ["mage"] },
    { id: 2, name: "Olaf", alias: "Olaf", roles: ["fighter"] },
    { id: 3, name: "Galio", alias: "Galio", roles: ["tank", "mage"] },
    { id: 9, name: "Ahri", alias: "Ahri" },
  ],
  [SELECTION]: { spell1Id: 4, spell2Id: 14 },
  [SWAPS]: [],
  [ORDER_SWAPS]: [],
  [PAGES]: PAGES_LIST,
  [DISALLOWED]: [14],
});

/** A request to the Mac. */
function req(path: string, init: { body?: unknown } = {}) {
  return new Request(`${MAC}${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Deps for the handler over a fake client, with a Data Dragon stub. */
function setup(gets: Record<string, any>, dragon = ddragon()) {
  const { client, writes } = fakeClient(gets);
  const deps: PhoneDeps = { client, fetch: dragon.fetch };
  return { writes, dragon, deps };
}

test("state shows names, your turn and options; outside champ select it says so", async () => {
  const { client } = fakeClient(world([[turnPick]]));
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.inChampSelect).toBe(true);
  expect(state.turn).toEqual({ championId: 0, type: "pick" });
  expect(state.plan).toBeNull();
  expect(state.timer).toEqual({ leftMs: 25000, phase: "pick", stage: "" });
  expect(state.hasPicks).toBe(true);
  // Galio (3) is a teammate's pick intent, so it is not offered.
  expect(state.options).toEqual([
    { id: 1, name: "Annie", alias: "Annie", roles: ["mage"] },
    { id: 2, name: "Olaf", alias: "Olaf", roles: ["fighter"] },
  ]);
  expect(state.spells).toEqual({ spell1: 4, spell2: 14 });
  const outside = await phoneState(fakeClient({ [PHASE]: "Lobby" }).client);
  expect(outside).toEqual({ phase: "Lobby", inChampSelect: false, search: null, readyCheck: null, lobby: null });
});

test("state includes the team, bans, enemies, spell list, runes and swaps", async () => {
  const annieLocked = { id: 8, actorCellId: 3, type: "pick", isInProgress: false, completed: true, championId: 1 };
  // The enemy in cell 7 locked Olaf, but the client still reports championId 0 for them.
  const enemyLocked = { id: 9, actorCellId: 7, type: "pick", isInProgress: false, completed: true, championId: 2 };
  // The client lists a swap for every teammate; only the one in state RECEIVED is a request to you.
  const swapList = [
    { id: 31, cellId: 3, state: "AVAILABLE" },
    { id: 32, cellId: 4, state: "RECEIVED" },
  ];
  const { client } = fakeClient({
    ...world([[turnPick], [annieLocked, enemyLocked]], {
      myTeam: [
        team[0],
        { cellId: 3, championId: 1, championPickIntent: 0, assignedPosition: "jungle" },
        { cellId: 4, championId: 0, championPickIntent: 3, assignedPosition: "utility" },
      ],
      bans: { myTeamBans: [0, 2], theirTeamBans: [9] },
    }),
    [SWAPS]: swapList,
  });
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.team).toEqual([
    { cellId: 2, mine: true, championId: 0, name: "", alias: "", position: "MID", spells: { spell1: 4, spell2: 14 }, locked: false, hovering: false, swap: null, orderSwap: null },
    // You have not locked in yet, so no champion swap is offered, whatever the client lists.
    { cellId: 3, mine: false, championId: 1, name: "Annie", alias: "Annie", position: "JGL", spells: null, locked: true, hovering: false, swap: null, orderSwap: null },
    { cellId: 4, mine: false, championId: 3, name: "Galio", alias: "Galio", position: "SUP", spells: null, locked: false, hovering: true, swap: null, orderSwap: null },
  ]);
  expect(state.bans).toEqual({ mine: [{ id: 2, name: "Olaf", alias: "Olaf" }], theirs: [{ id: 9, name: "Ahri", alias: "Ahri" }] });
  expect(state.enemies).toEqual([
    { cellId: 6, championId: 9, name: "Ahri", alias: "Ahri" },
    { cellId: 7, championId: 2, name: "Olaf", alias: "Olaf" },
  ]);
  expect(state.spellList).toEqual([
    { id: 4, name: "Flash", file: "SummonerFlash.png", disallowed: false },
    { id: 14, name: "Ignite", file: "SummonerDot.png", disallowed: true },
  ]);
  expect(state.runes).toEqual({ current: { id: 12, name: "Fixed" } });
  // Cell 4's champion swap request waits until both of you have locked in.
  expect(state.swaps).toEqual([]);
});

test("swaps follow the game's rules: pick order only before either of you picks, champions only after both lock in", async () => {
  const lists = {
    [SWAPS]: [{ id: 31, cellId: 3, state: "AVAILABLE" }],
    [ORDER_SWAPS]: [{ id: 41, cellId: 3, state: "AVAILABLE" }],
  };
  const swapsFor = async (actions: any[]) => {
    const state: any = await phoneState(fakeClient({ ...world([actions]), ...lists }).client, ddragon().fetch);
    return { swap: state.team[1].swap, orderSwap: state.team[1].orderSwap };
  };
  const mine = (completed: boolean) => ({ id: 7, actorCellId: 2, type: "pick", isInProgress: !completed, completed, championId: completed ? 2 : 0 });
  const theirs = (completed: boolean) => ({ id: 8, actorCellId: 3, type: "pick", isInProgress: false, completed, championId: completed ? 1 : 0 });
  // Neither picked: only pick order.
  expect(await swapsFor([mine(false), theirs(false)])).toEqual({ swap: null, orderSwap: { id: 41, state: "AVAILABLE" } });
  // You already picked: no pick order swap any more (the reported bug), and no champion swap until they lock too.
  expect(await swapsFor([mine(true), theirs(false)])).toEqual({ swap: null, orderSwap: null });
  // They picked, you did not: neither.
  expect(await swapsFor([mine(false), theirs(true)])).toEqual({ swap: null, orderSwap: null });
  // Both locked in: only champions.
  expect(await swapsFor([mine(true), theirs(true)])).toEqual({ swap: { id: 31, state: "AVAILABLE" }, orderSwap: null });
});

test("a pick order request that came in before you locked in no longer pops up after", async () => {
  const lists = { [ORDER_SWAPS]: [{ id: 41, cellId: 3, state: "RECEIVED" }] };
  const state: any = await phoneState(fakeClient({ ...world([bothLocked]), ...lists }).client, ddragon().fetch);
  expect(state.swaps).toEqual([]);
});

// Your pick has not started: someone else is banning or picking.
const laterPick = { id: 7, actorCellId: 2, type: "pick", isInProgress: false, completed: false, championId: 0 };
const otherTurn = { id: 5, actorCellId: 3, type: "ban", isInProgress: true, completed: false, championId: 0 };

test("before your turn, the state offers the pickable champions to pre-pick", async () => {
  const { client } = fakeClient(world([[otherTurn], [{ ...laterPick, championId: 2 }]]));
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.turn).toBeNull();
  expect(state.plan).toEqual({ championId: 2 });
  // Galio (3) is a teammate's pick intent.
  expect(state.options.map((o: any) => o.id)).toEqual([1, 2]);
});

test("the client's placeholder champion (-1, None) is never offered", async () => {
  const { client } = fakeClient({ ...world([[turnPick]]), [PICKABLE]: [-1, 1, 2] });
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.options.map((o: any) => o.id)).toEqual([1, 2]);
  await expect(phoneChoose(client, -1, false)).rejects.toBeInstanceOf(ActionRefused);
});

test("when the pickable list holds only the placeholder, the client's champion grid is offered", async () => {
  const GRID = "/lol-champ-select/v1/all-grid-champions";
  const grid = [
    { id: -1, name: "None", owned: true },
    { id: 1, name: "Annie", owned: true },
    { id: 2, name: "Olaf", owned: false, freeToPlay: true },
    { id: 9, name: "Ahri", owned: false, freeToPlay: false },
    { id: 136, name: "Aurelion Sol", owned: true, disabled: true },
  ];
  const { client, writes } = fakeClient({ ...world([[turnPick]]), [PICKABLE]: [-1], [GRID]: grid });
  const state: any = await phoneState(client, ddragon().fetch);
  // Owned or free, not disabled, not the placeholder.
  expect(state.options.map((o: any) => o.id)).toEqual([1, 2]);
  await phoneChoose(client, 2, false);
  await expect(phoneChoose(client, 9, false)).rejects.toThrow("that champion is not available to you");
  expect(writes).toEqual([{ method: "PATCH", path: ACTION, body: { championId: 2, completed: false } }]);
});

test("banned and locked champions are not offered", async () => {
  const enemyLocked = { id: 9, actorCellId: 7, type: "pick", isInProgress: false, completed: true, championId: 1 };
  const { client } = fakeClient(world([[turnPick, enemyLocked]], { bans: { myTeamBans: [2], theirTeamBans: [] } }));
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.options).toEqual([]);
  await expect(phoneChoose(client, 2, false)).rejects.toThrow("that champion is banned or taken");
});

test("on your turn, a pre-pick the client did not carry over is the hover, and Lock In locks it", async () => {
  const mineIntent = [{ ...team[0], championPickIntent: 2 }, team[1]];
  const { client, writes } = fakeClient(world([[turnPick]], { myTeam: mineIntent }));
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.turn).toEqual({ championId: 2, type: "pick" });
  await phoneChoose(client, undefined, true);
  expect(writes).toEqual([{ method: "PATCH", path: ACTION, body: { championId: 2, completed: true } }]);
});

// You (cell 2) and the jungler (cell 3) have both locked in.
const bothLocked = [
  { id: 7, actorCellId: 2, type: "pick", isInProgress: false, completed: true, championId: 2 },
  { id: 8, actorCellId: 3, type: "pick", isInProgress: false, completed: true, championId: 1 },
];

test("a swap you asked for shows as sent and can be cancelled", async () => {
  const { client, writes } = fakeClient({ ...world([bothLocked]), [SWAPS]: [{ id: 31, cellId: 3, state: "SENT" }] });
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.team[1].swap).toEqual({ id: 31, state: "SENT" });
  await phoneSwap(client, "champion", "cancel", 31);
  expect(writes).toEqual([{ method: "POST", path: `${SWAPS}/31/cancel`, body: {} }]);
});

test("the client's phase is passed on, and a mode with no pick for you says so", async () => {
  const planning = fakeClient(world([[laterPick]], { timer: { adjustedTimeLeftInPhase: 9000, phase: "PLANNING" } }));
  const state: any = await phoneState(planning.client, ddragon().fetch);
  expect(state.timer).toEqual({ leftMs: 9000, phase: "", stage: "PLANNING" });
  const aram = fakeClient(world([]));
  expect(((await phoneState(aram.client, ddragon().fetch)) as any).hasPicks).toBe(false);
});

test("before your turn, a hover pre-picks on your coming pick, and a lock is refused", async () => {
  const pre = fakeClient(world([[otherTurn], [laterPick]]));
  await phoneChoose(pre.client, 1, false);
  expect(pre.writes).toEqual([{ method: "PATCH", path: ACTION, body: { championId: 1 } }]);

  const lock = fakeClient(world([[otherTurn], [{ ...laterPick, championId: 1 }]]));
  await expect(phoneChoose(lock.client, 1, true)).rejects.toBeInstanceOf(ActionRefused);
  expect(lock.writes).toEqual([]);

  // Galio (3) is a teammate's pick intent: refused before your turn too.
  const taken = fakeClient(world([[otherTurn], [laterPick]]));
  await expect(phoneChoose(taken.client, 3, false)).rejects.toBeInstanceOf(ActionRefused);
  expect(taken.writes).toEqual([]);
});

test("with no pick left, there is nothing to pre-pick", async () => {
  const done = { ...laterPick, completed: true, championId: 1 };
  const { client, writes } = fakeClient(world([[otherTurn], [done]]));
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.plan).toBeNull();
  expect(state.options).toEqual([]);
  await expect(phoneChoose(client, 2, false)).rejects.toBeInstanceOf(ActionRefused);
  expect(writes).toEqual([]);
});

test("a swap request can be declined", async () => {
  const s = fakeClient(world([[turnPick]]));
  await phoneSwap(s.client, "champion", "decline", 32);
  expect(s.writes).toEqual([{ method: "POST", path: `${SWAPS}/32/decline`, body: {} }]);
});

test("pick order swaps: offered per teammate by swap id, requests pop up, and every action goes to the pick order list", async () => {
  const support = { cellId: 4, championId: 0, championPickIntent: 3, assignedPosition: "utility" };
  const { client, writes } = fakeClient({
    ...world([[turnPick]], { myTeam: [...team, support] }),
    [ORDER_SWAPS]: [
      { id: 41, cellId: 3, state: "AVAILABLE" },
      { id: 42, cellId: 4, state: "RECEIVED" },
    ],
  });
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.team[1].orderSwap).toEqual({ id: 41, state: "AVAILABLE" });
  expect(state.team[1].swap).toBeNull();
  expect(state.swaps).toEqual([{ kind: "pick-order", id: 42, cellId: 4, name: "Galio", alias: "Galio", position: "SUP" }]);
  for (const action of ["request", "cancel", "accept", "decline"]) await phoneSwap(client, "pick-order", action, 41);
  expect(writes.map((w) => w.path)).toEqual(["request", "cancel", "accept", "decline"].map((a) => `${ORDER_SWAPS}/41/${a}`));
});

test("a swap of an unknown kind or action is refused, and nothing is sent", async () => {
  const { client, writes } = fakeClient(world([[turnPick]]));
  for (const [kind, action] of [["position", "request"], ["champion", "delete"], ["../x", "request"]]) {
    await expect(phoneSwap(client, kind, action, 41)).rejects.toBeInstanceOf(ActionRefused);
  }
  expect(writes).toEqual([]);
});

test("dodge leaves champion select through the client's quit call, and only from champ select", async () => {
  const { client, writes } = fakeClient(world([[turnPick]]));
  expect(await phoneDodge(client)).toEqual({ ok: true });
  expect(writes).toHaveLength(1);
  const url = new URL(writes[0].path, "https://127.0.0.1");
  expect(url.pathname).toBe("/lol-login/v1/session/invoke");
  expect(url.searchParams.get("destination")).toBe("lcdsServiceProxy");
  expect(url.searchParams.get("method")).toBe("call");
  expect(JSON.parse(url.searchParams.get("args")!)).toEqual(["", "teambuilder-draft", "quitV2", ""]);

  const lobby = fakeClient({ [PHASE]: "Lobby" });
  await expect(phoneDodge(lobby.client)).rejects.toBeInstanceOf(ActionRefused);
  expect(lobby.writes).toEqual([]);
});

test("choose hovers, locks, and refuses a champion a teammate has or is not allowed", async () => {
  const hover = fakeClient(world([[turnPick]]));
  await phoneChoose(hover.client, 2, false);
  expect(hover.writes[0]).toEqual({ method: "PATCH", path: ACTION, body: { championId: 2, completed: false } });

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

test("a lock with no champion locks the one already hovered, and refuses when nothing is hovered", async () => {
  const hovering = setup(world([[{ ...turnPick, championId: 2 }]]));
  const locked = await handlePhone(req("/api/choose", { body: { lock: true } }), hovering.deps);
  expect(locked.status).toBe(200);
  expect(hovering.writes[0]).toEqual({ method: "PATCH", path: ACTION, body: { championId: 2, completed: true } });

  const none = setup(world([[turnPick]]));
  const refused = await handlePhone(req("/api/choose", { body: { lock: true } }), none.deps);
  expect(refused.status).toBe(422);
  expect((await refused.json()).error).toBe("hover a champion first");
  expect(none.writes).toHaveLength(0);
});

test("spells must be two different ids and are sent as the client expects", async () => {
  const { client, writes } = fakeClient({});
  await expect(phoneSpells(client, 4, 4)).rejects.toBeInstanceOf(ActionRefused);
  await phoneSpells(client, 4, 14);
  expect(writes[0]).toEqual({ method: "PATCH", path: SELECTION, body: { spell1Id: 4, spell2Id: 14 } });
});

test("a spell the position may not use is refused with 422, and nothing is sent", async () => {
  // List form (the default world): Ignite (14) is refused.
  const list = setup(world([[turnPick]]));
  const refused = await handlePhone(req("/api/spells", { body: { spell1: 4, spell2: 14 } }), list.deps);
  expect(refused.status).toBe(422);
  expect((await refused.json()).error).toBe("that spell is not allowed for your position");
  expect(list.writes).toHaveLength(0);

  // By-position form: this player is MID, so Flash (4) is refused.
  const byPosition = setup({ ...world([[turnPick]]), [DISALLOWED]: { top: [14], middle: [4] } });
  const refusedByPosition = await handlePhone(req("/api/spells", { body: { spell1: 4, spell2: 14 } }), byPosition.deps);
  expect(refusedByPosition.status).toBe(422);
  expect(byPosition.writes).toHaveLength(0);
});

test("a request with no passcode is served: the page and the API", async () => {
  const s = setup(world([[turnPick]]));
  const page = await handlePhone(new Request(`${MAC}/`), s.deps);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>Champ select</title>");
  const state = await handlePhone(req("/api/state"), s.deps);
  expect(state.status).toBe(200);
  expect((await state.json()).inChampSelect).toBe(true);
});

test("a client that is not running is reported as such, not as a connection error", async () => {
  const deps = {
    client: { ...fakeClient({}).client, get: async () => { throw { code: "ECONNREFUSED" }; } } as LcuClient,
  };
  const res = await handlePhone(req("/api/state"), deps);
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("League client not running");
});

test("switching rune pages uses the client's current-page call, for locked pages too, and refuses a missing page", async () => {
  const s = setup(world([[turnPick]]));
  const switched = await handlePhone(req("/api/rune", { body: { id: 11 } }), s.deps);
  expect(switched.status).toBe(200);
  expect(s.writes[0]).toEqual({ method: "PUT", path: "/lol-perks/v1/currentpage", body: 11 });

  // Page 12 is locked (not editable), but can still be the current page.
  const locked = await handlePhone(req("/api/rune", { body: { id: 12 } }), s.deps);
  expect(locked.status).toBe(200);
  expect(s.writes[1]).toEqual({ method: "PUT", path: "/lol-perks/v1/currentpage", body: 12 });

  const missing = await handlePhone(req("/api/rune", { body: { id: 99 } }), s.deps);
  expect(missing.status).toBe(422);
  expect(s.writes).toHaveLength(2);
});

test("a skipped ban or empty pick (the client's -1) never shows as a champion", async () => {
  const skipped = { id: 9, actorCellId: 7, type: "pick", isInProgress: false, completed: true, championId: -1 };
  const { client } = fakeClient(world([[turnPick, skipped]], { bans: { myTeamBans: [-1, 2], theirTeamBans: [-1] } }));
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.bans).toEqual({ mine: [{ id: 2, name: "Olaf", alias: "Olaf" }], theirs: [] });
  expect(state.enemies[1]).toEqual({ cellId: 7, championId: 0, name: "", alias: "" });
});

test("after you lock in, the state says so; an endless timer has no countdown", async () => {
  const done = { id: 7, actorCellId: 2, type: "pick", isInProgress: false, completed: true, championId: 2 };
  const { client } = fakeClient(world([[done]], { timer: { adjustedTimeLeftInPhase: 9000, isInfinite: true, phase: "FINALIZATION" } }));
  const state: any = await phoneState(client, ddragon().fetch);
  expect(state.lockedIn).toBe(true);
  expect(state.timer.leftMs).toBeNull();
});

test("champion and spell icons are served with no passcode", async () => {
  const s = setup(world([[turnPick]]));
  const champion = await handlePhone(req("/icon/champion/Annie.png"), s.deps);
  expect(champion.status).toBe(200);
  expect(champion.headers.get("content-type")).toBe("image/png");
  expect(champion.headers.get("cache-control")).toBe("private, max-age=86400");

  const spell = await handlePhone(req("/icon/spell/SummonerFlash.png"), s.deps);
  expect(spell.status).toBe(200);
});

test("an icon name that is not a plain alias or spell file is 404, and Data Dragon is never asked", async () => {
  const s = setup(world([[turnPick]]));
  // The URL parser folds "../" away, so "../x" lands on a path that names no icon.
  for (const path of ["/icon/champion/..%2Fx.png", "/icon/champion/../x.png", "/icon/spell/../x", "/icon/spell/SummonerFlash.exe", "/icon/spell/Summoner-Flash.png"]) {
    const res = await handlePhone(req(path), s.deps);
    expect(res.status).toBe(404);
  }
  expect(s.dragon.urls).toHaveLength(0);
});

test("spell files with underscores are served", async () => {
  const s = setup(world([[turnPick]]));
  const res = await handlePhone(req("/icon/spell/Summoner_UltBookPlaceholder.png"), s.deps);
  expect(res.status).toBe(200);
  expect(s.dragon.urls.some((u: string) => u.endsWith("/img/spell/Summoner_UltBookPlaceholder.png"))).toBe(true);
});

test("an icon is fetched once and then kept in memory", async () => {
  const s = setup(world([[turnPick]]));
  expect((await handlePhone(req("/icon/champion/Annie.png"), s.deps)).status).toBe(200);
  // The version list, then the icon.
  expect(s.dragon.urls).toHaveLength(2);
  expect((await handlePhone(req("/icon/champion/Annie.png"), s.deps)).status).toBe(200);
  expect(s.dragon.urls).toHaveLength(2);
});

test("an icon Data Dragon cannot give is a 502 with a JSON error", async () => {
  const s = setup(world([[turnPick]]), ddragon(true));
  const res = await handlePhone(req("/icon/champion/Annie.png"), s.deps);
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("icon unavailable");
});

// Rune fixtures, as the client lists them: five trees, each with a keystone slot, three rune rows
// and the stat shard rows. Precision with Domination is a legal page.
const RUNE_TREES: [number, string, number[], number[][]][] = [
  [8000, "Precision", [8005, 8008], [[9101, 9111, 8009], [9104, 9105, 9103], [8014, 8017, 8299]]],
  [8100, "Domination", [8128], [[8126, 8139, 8135], [8105, 8106, 8138], [8134, 8120, 8143]]],
  [8200, "Sorcery", [8214, 8229, 8230], [[8224, 8226, 8210], [8237, 8233, 8236], [8242, 8234, 8232]]],
  [8300, "Inspiration", [8351, 8360, 8369], [[8306, 8304, 8313], [8321, 8316, 8345], [8347, 8410, 8352]]],
  [8400, "Resolve", [8437, 8439, 8465], [[8446, 8429, 8451], [8444, 8473, 8453], [8463, 8401, 8475]]],
];
const RUNE_SHARDS = [
  [5005, 5008, 5007],
  [5008, 5002, 5003],
  [5001, 5002, 5003],
];
const RUNE_STYLES = RUNE_TREES.map(([id, name, keystones, rows]) => ({
  id,
  name,
  iconPath: `/lol-game-data/assets/v1/perk-images/styles/${name.toLowerCase()}/${name.toLowerCase()}.png`,
  allowedSubStyles: RUNE_TREES.map(([x]) => x).filter((x) => x !== id),
  defaultSubStyle: RUNE_TREES.find(([x]) => x !== id)?.[0],
  slots: [
    { type: "kKeyStone", perks: keystones },
    ...rows.map((perks) => ({ type: "kMixedRegularSplashable", perks })),
    ...RUNE_SHARDS.map((perks) => ({ type: "kStatMod", perks })),
  ],
}));
const RUNE_PERKS = [...new Set(RUNE_STYLES.flatMap((s) => s.slots.flatMap((x) => x.perks)))].map((id) => ({
  id,
  name: `Rune ${id}`,
  iconPath: `/lol-game-data/assets/v1/Perk-Images/${id}.png`,
}));
const RUNE_VALID = [8005, 9101, 9104, 8014, 8126, 8105, 5007, 5002, 5001];
const RUNE_PAGES = [
  { id: 12, name: "Fixed", current: true, isEditable: false, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: RUNE_VALID },
  { id: 13, name: "Ekko", current: false, isEditable: true, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: RUNE_VALID },
];

/** Deps over a fake client that has the rune fixtures. */
function runeSetup() {
  return setup({ [PAGES]: RUNE_PAGES, "/lol-perks/v1/perks": RUNE_PERKS, "/lol-perks/v1/styles": RUNE_STYLES });
}

test("the queue and a found match show outside champ select", async () => {
  const searching = await phoneState(
    fakeClient({
      [PHASE]: "Matchmaking",
      "/lol-matchmaking/v1/search": { searchState: "Searching", timeInQueue: 12.4, estimatedQueueTime: 45 },
    }).client
  );
  expect(searching).toMatchObject({ phase: "Matchmaking", search: { searching: true, timeInQueue: 12.4, estimatedQueueTime: 45 }, readyCheck: null });
  const found = await phoneState(
    fakeClient({ [PHASE]: "ReadyCheck", "/lol-matchmaking/v1/ready-check": { playerResponse: "None", timer: 9.5 } }).client
  );
  expect(found).toMatchObject({ phase: "ReadyCheck", search: null, readyCheck: { response: "None", secondsLeft: 9.5 } });
});

test("accept and decline answer a found match once, and are refused when none is waiting", async () => {
  const found = fakeClient({ [PHASE]: "ReadyCheck", "/lol-matchmaking/v1/ready-check": { state: "InProgress", playerResponse: "None" } });
  await phoneReadyCheck(found.client, "accept");
  expect(found.writes).toEqual([{ method: "POST", path: "/lol-matchmaking/v1/ready-check/accept", body: {} }]);
  const answered = fakeClient({ [PHASE]: "ReadyCheck", "/lol-matchmaking/v1/ready-check": { state: "InProgress", playerResponse: "Accepted" } });
  await expect(phoneReadyCheck(answered.client, "accept")).rejects.toBeInstanceOf(ActionRefused);
  expect(answered.writes).toHaveLength(0);
  const lobby = fakeClient({ [PHASE]: "Lobby" });
  await expect(phoneReadyCheck(lobby.client, "decline")).rejects.toBeInstanceOf(ActionRefused);
  expect(lobby.writes).toHaveLength(0);
});

test("queue up starts the search from a lobby, and cancel ends it from a queue", async () => {
  const lobby = fakeClient({ [PHASE]: "Lobby" });
  await phoneQueue(lobby.client);
  expect(lobby.writes).toEqual([{ method: "POST", path: "/lol-lobby/v2/lobby/matchmaking/search", body: {} }]);
  await expect(phoneQueue(fakeClient({ [PHASE]: "ChampSelect" }).client)).rejects.toBeInstanceOf(ActionRefused);
  const queue = fakeClient({ [PHASE]: "Matchmaking" });
  await phoneCancelQueue(queue.client);
  expect(queue.writes).toEqual([{ method: "DELETE", path: "/lol-lobby/v2/lobby/matchmaking/search", body: undefined }]);
  await expect(phoneCancelQueue(fakeClient({ [PHASE]: "Lobby" }).client)).rejects.toBeInstanceOf(ActionRefused);
});

// Queues as the client lists them: one available Summoner's Rift mode, one ARAM, and one turned off.
const QUEUES = [
  { id: 400, description: "Draft Pick", category: "PvP", gameSelectModeGroup: "kSummonersRift", queueAvailability: "Available" },
  { id: 450, description: "ARAM", category: "PvP", gameSelectModeGroup: "kARAM", queueAvailability: "Available" },
  { id: 490, description: "Quickplay", category: "PvP", gameSelectModeGroup: "kSummonersRift", queueAvailability: "PlatformDisabled" },
];
const LOBBY = "/lol-lobby/v2/lobby";

test("the lobby shows its mode and the modes you can switch to", async () => {
  const state: any = await phoneState(fakeClient({ [PHASE]: "Lobby", [LOBBY]: { gameConfig: { queueId: 400 } }, "/lol-game-queues/v1/queues": QUEUES }).client);
  expect(state.lobby).toEqual({ queueId: 400, modes: [{ id: 400, name: "Draft Pick" }, { id: 450, name: "ARAM" }] });
});

test("switching mode posts the new queue from the lobby, and refuses a mode that is not offered", async () => {
  const lobby = fakeClient({ [PHASE]: "Lobby", "/lol-game-queues/v1/queues": QUEUES });
  await phoneMode(lobby.client, 450);
  expect(lobby.writes).toEqual([{ method: "POST", path: LOBBY, body: { queueId: 450 } }]);
  await expect(phoneMode(fakeClient({ [PHASE]: "Lobby", "/lol-game-queues/v1/queues": QUEUES }).client, 490)).rejects.toBeInstanceOf(ActionRefused);
  const queue = fakeClient({ [PHASE]: "Matchmaking", "/lol-game-queues/v1/queues": QUEUES });
  await expect(phoneMode(queue.client, 450)).rejects.toBeInstanceOf(ActionRefused);
  expect(queue.writes).toHaveLength(0);
});

test("leaving the lobby deletes it, and is refused during a search", async () => {
  const lobby = fakeClient({ [PHASE]: "Lobby" });
  await phoneLeaveLobby(lobby.client);
  expect(lobby.writes).toEqual([{ method: "DELETE", path: LOBBY, body: undefined }]);
  const queue = fakeClient({ [PHASE]: "Matchmaking" });
  await expect(phoneLeaveLobby(queue.client)).rejects.toBeInstanceOf(ActionRefused);
  expect(queue.writes).toHaveLength(0);
});

const SKIN_INFO = "/lol-champ-select/v1/skin-selector-info";
const SKIN_CAROUSEL = "/lol-champ-select/v1/skin-carousel-skins";
const SKINS = [
  { id: 103, name: "Base", disabled: false, ownership: { owned: true } },
  { id: 104, name: "Sakura", disabled: false, ownership: { owned: true } },
  { id: 105, name: "Locked skin", disabled: false, ownership: { owned: false } },
  { id: 106, name: "Hidden", disabled: true, ownership: { owned: true } },
];
const skinInfo = (extra: object = {}) => ({ showSkinSelector: true, skinSelectionDisabled: false, selectedSkinId: 103, ...extra });
const withSkins = (info: object = skinInfo()) => ({ ...world([[turnPick]]), [SKIN_INFO]: info, [SKIN_CAROUSEL]: SKINS });

test("the skins you can wear show in the state, with the one you wear and whether you may change it", async () => {
  const s = setup(withSkins());
  const state: any = await phoneState(s.deps.client, s.deps.fetch);
  expect(state.skins).toEqual({
    available: true,
    selected: 103,
    options: [
      { id: 103, name: "Base", owned: true },
      { id: 104, name: "Sakura", owned: true },
      { id: 105, name: "Locked skin", owned: false },
    ],
  });
  const locked = setup(withSkins(skinInfo({ skinSelectionDisabled: true })));
  expect(((await phoneState(locked.deps.client, locked.deps.fetch)) as any).skins.available).toBe(false);
});

test("choosing a skin you own sets it; a skin you do not own, one that is hidden, or any skin while locked is refused", async () => {
  const s = setup(withSkins());
  await phoneSkin(s.deps.client, 104);
  expect(s.writes).toEqual([{ method: "PATCH", path: SELECTION, body: { selectedSkinId: 104 } }]);

  await phoneSkin(s.deps.client, 103); // already worn: nothing is sent
  expect(s.writes).toHaveLength(1);

  const refused = setup(withSkins());
  await expect(phoneSkin(refused.deps.client, 105)).rejects.toBeInstanceOf(ActionRefused);
  await expect(phoneSkin(refused.deps.client, 106)).rejects.toBeInstanceOf(ActionRefused);
  await expect(phoneSkin(refused.deps.client, 999)).rejects.toBeInstanceOf(ActionRefused);
  expect(refused.writes).toHaveLength(0);

  const locked = setup(withSkins(skinInfo({ skinSelectionDisabled: true })));
  await expect(phoneSkin(locked.deps.client, 104)).rejects.toBeInstanceOf(ActionRefused);
  expect(locked.writes).toHaveLength(0);

  const lobby = setup({ [PHASE]: "Lobby", [SKIN_INFO]: skinInfo(), [SKIN_CAROUSEL]: SKINS });
  await expect(phoneSkin(lobby.deps.client, 104)).rejects.toBeInstanceOf(ActionRefused);
  expect(lobby.writes).toHaveLength(0);
});

test("a skin's splash art is the champion's art for that skin number, and an unknown champion is 404", async () => {
  const s = setup(world([[turnPick]]));
  // Skin 9001 is champion 9 (Ahri in the fixture), skin number 1.
  const res = await handlePhone(req("/icon/splash/9001.jpg"), s.deps);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/jpeg");
  expect(s.dragon.urls.some((u) => u.endsWith("/cdn/img/champion/tiles/Ahri_1.jpg"))).toBe(true);
  expect((await handlePhone(req("/icon/splash/99001.jpg"), s.deps)).status).toBe(404);
});

test("a swap whose action is not request or accept is refused, and nothing is sent", async () => {
  const s = setup(world([[turnPick]]));
  const res = await handlePhone(req("/api/swap", { body: { action: "accept/../../lol-x", id: 3 } }), s.deps);
  expect(res.status).toBe(422);
  expect(s.writes).toHaveLength(0);
});

test("the rune data for the phone lists the pages, five trees, the shards and the names", async () => {
  const s = runeSetup();
  const res = await handlePhone(req("/api/runes"), s.deps);
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.pages).toHaveLength(2);
  expect(data.trees).toHaveLength(5);
  expect(data.trees[0]).toEqual({ id: 8000, name: "Precision", keystones: [8005, 8008], rows: RUNE_TREES[0][3] });
  expect(data.shards).toEqual(RUNE_SHARDS);
  expect(data.names["8000"]).toEqual({ name: "Precision", icon: "/icon/rune/8000.png" });
  expect(data.names["8005"]).toEqual({ name: "Rune 8005", icon: "/icon/rune/8005.png" });
});

test("a rune save that breaks the rules is 422 with the reason, and nothing is sent", async () => {
  const s = runeSetup();
  // Two secondary runes from the same Domination row.
  const twoFromOneRow = [8005, 9101, 9104, 8014, 8126, 8139, 5007, 5002, 5001];
  const res = await handlePhone(req("/api/rune-save", { body: { id: 13, name: "Ekko", primaryStyleId: 8000, subStyleId: 8100, perks: twoFromOneRow } }), s.deps);
  expect(res.status).toBe(422);
  expect((await res.json()).error).toBe("pick two secondary runes from different rows");
  expect(s.writes).toHaveLength(0);
});

test("a legal rune save is 200 with ok, and sends one PUT to that page", async () => {
  const s = runeSetup();
  const res = await handlePhone(req("/api/rune-save", { body: { id: 13, name: "Ekko", primaryStyleId: 8000, subStyleId: 8100, perks: RUNE_VALID } }), s.deps);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(s.writes).toEqual([
    {
      method: "PUT",
      path: "/lol-perks/v1/pages/13",
      body: { name: "Ekko", primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: RUNE_VALID, current: false },
    },
  ]);
});

test("a rune icon with no known id is 404, and nothing is fetched for it", async () => {
  const s = runeSetup();
  const res = await handlePhone(req("/icon/rune/99999.png"), s.deps);
  expect(res.status).toBe(404);
  expect(s.dragon.urls).toHaveLength(0);
});

test("a known rune icon is served as a PNG, fetched from CommunityDragon", async () => {
  const s = runeSetup();
  const res = await handlePhone(req("/icon/rune/8005.png"), s.deps);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(s.dragon.urls).toContain("https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perk-images/8005.png");
});
