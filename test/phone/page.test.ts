import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import PAGE from "../../app/util/phone-page.html" with { type: "text" };
import { handlePhone, resetChampionCache, resetModeCache } from "../../app/util/phone";
import { resetIconCache } from "../../app/util/phoneIcons";
import { resetRuneIconCache } from "../../app/util/phoneRunes";
import type { LcuClient } from "../../app/util/player";

// Runs the real phone page (app/util/phone-page.html) in happy-dom. Its requests go to the
// real phone server code (handlePhone), and that talks to a simulated League client. No
// network, browser or League client is used.

const NAMES = [
  { id: 1, name: "Annie", alias: "Annie", roles: ["mage"] },
  { id: 2, name: "Olaf", alias: "Olaf", roles: ["fighter"] },
  { id: 3, name: "Galio", alias: "Galio", roles: ["tank"] },
  { id: 136, name: "Aurelion Sol", alias: "AurelionSol", roles: ["mage"] },
  { id: 145, name: "Kai'Sa", alias: "Kaisa", roles: ["marksman"] },
];

// Data Dragon as the page's server sees it: spells for the spell sheet. Mark is ARAM only.
const SUMMONER_JSON = {
  data: {
    SummonerFlash: { key: "4", name: "Flash", image: { full: "SummonerFlash.png" }, modes: ["CLASSIC", "ARAM"] },
    SummonerDot: { key: "14", name: "Ignite", image: { full: "SummonerDot.png" }, modes: ["CLASSIC", "ARAM"] },
    SummonerHeal: { key: "7", name: "Heal", image: { full: "SummonerHeal.png" }, modes: ["CLASSIC", "ARAM"] },
    SummonerSnowball: { key: "32", name: "Mark", image: { full: "SummonerSnowball.png" }, modes: ["ARAM"] },
  },
};
const dataDragon = async (url: string) => {
  if (url.endsWith("/api/versions.json")) return Response.json(["16.1.1"]);
  if (url.endsWith("/summoner.json")) return Response.json(SUMMONER_JSON);
  return new Response("not here", { status: 404 });
};

// Rune trees as the client lists them: a keystone slot, three rune rows, then three shard rows.
const SHARDS = [[5005, 5008, 5007], [5008, 5002, 5003], [5001, 5002, 5003]];
const TREE_IDS = [8000, 8100, 8200, 8300, 8400];
const style = (id: number, name: string, keystones: number[], rows: number[][]) => ({
  id,
  name,
  iconPath: `/lol-game-data/assets/v1/perk-images/styles/${id}.png`,
  allowedSubStyles: TREE_IDS.filter((x) => x !== id),
  defaultSubStyle: TREE_IDS.find((x) => x !== id),
  slots: [
    { type: "kKeyStone", perks: keystones },
    ...rows.map((perks) => ({ type: "kMixedRegularSplashable", perks })),
    ...SHARDS.map((perks) => ({ type: "kStatMod", perks })),
  ],
});
const STYLES = [
  style(8000, "Precision", [8005, 8008], [[9101, 9111, 8009], [9104, 9105, 9103], [8014, 8017, 8299]]),
  style(8100, "Domination", [8128], [[8126, 8139, 8135], [8105, 8106, 8138], [8134, 8120, 8143]]),
  style(8200, "Sorcery", [8214, 8229, 8230], [[8224, 8226, 8210], [8237, 8233, 8236], [8242, 8234, 8232]]),
  style(8300, "Inspiration", [8351, 8360, 8369], [[8306, 8304, 8313], [8321, 8316, 8345], [8347, 8410, 8352]]),
  style(8400, "Resolve", [8437, 8439, 8465], [[8446, 8429, 8451], [8444, 8473, 8453], [8463, 8401, 8475]]),
];
const PERKS = [...new Set(STYLES.flatMap((x) => x.slots.flatMap((sl) => sl.perks)))].map((id) => ({ id, name: `Rune ${id}`, iconPath: "" }));
// Precision (Press the Attack) with Domination: keystone, 3 primary runes, 2 secondary, 3 shards.
const RUNES = [8005, 9101, 9104, 8014, 8126, 8105, 5007, 5002, 5001];
const QUEUES = [
  { id: 420, description: "Ranked Solo/Duo", queueAvailability: "Available", category: "PvP", gameSelectModeGroup: "kSummonersRift" },
  { id: 430, description: "Normal Blind", queueAvailability: "Available", category: "PvP", gameSelectModeGroup: "kSummonersRift" },
  { id: 450, description: "ARAM", queueAvailability: "Available", category: "PvP", gameSelectModeGroup: "kARAM" },
];

/** A League client the test changes as it goes. In champ select you are cell 2; teammates 3 to 6. */
function champSelect() {
  const sim = {
    phase: "ChampSelect",
    queueId: 420,
    readyResponse: "None",
    spells: [4, 14],
    pages: [
      { id: 11, name: "Fixed", current: false, isEditable: false, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: RUNES },
      { id: 13, name: "Ekko", current: true, isEditable: true, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: RUNES },
    ],
    orderSwaps: [] as any[],
    /** Teammates' completed picks (cells 3 to 6). */
    teamPicks: [] as any[],
    myPick: { id: 7, actorCellId: 2, type: "pick", isInProgress: false, completed: false, championId: 0 },
    otherTurn: { id: 5, actorCellId: 3, type: "ban", isInProgress: true, completed: false, championId: 0 } as any,
    enemyPicks: [] as any[],
    swaps: [] as any[],
    bans: [] as number[],
    stage: "BAN_PICK",
    /** When set, the next game-phase request is never answered (a phone that slept mid-request). */
    hangNext: false,
    writes: [] as { method: string; path: string; body: unknown }[],
  };
  const client: LcuClient = {
    get: async (p: string) => {
      if (p === "/lol-gameflow/v1/gameflow-phase") {
        if (sim.hangNext) {
          sim.hangNext = false;
          return new Promise(() => {});
        }
        return sim.phase;
      }
      if (p === "/lol-lobby/v2/lobby") return { gameConfig: { queueId: sim.queueId } };
      if (p === "/lol-game-queues/v1/queues") return QUEUES;
      if (p === "/lol-matchmaking/v1/search") return { searchState: "Searching", timeInQueue: 12, estimatedQueueTime: 90 };
      if (p === "/lol-matchmaking/v1/ready-check") return { state: "InProgress", playerResponse: sim.readyResponse, timer: 8 };
      if (p === "/lol-champ-select/v1/session/my-selection") return { spell1Id: sim.spells[0], spell2Id: sim.spells[1] };
      if (p === "/lol-champ-select/v1/session/pick-order-swaps") return sim.orderSwaps;
      if (p === "/lol-perks/v1/pages") return sim.pages;
      if (p === "/lol-perks/v1/perks") return PERKS;
      if (p === "/lol-perks/v1/styles") return STYLES;
      if (p === "/lol-champ-select/v1/session")
        return {
          localPlayerCellId: 2,
          actions: [[sim.otherTurn, ...sim.enemyPicks, ...sim.teamPicks].filter(Boolean), [sim.myPick]],
          myTeam: [2, 3, 4, 5, 6].map((cellId) => ({
            cellId,
            championId:
              cellId === 2 ? (sim.myPick.completed ? sim.myPick.championId : 0) : (sim.teamPicks.find((a) => a.actorCellId === cellId)?.championId ?? 0),
            championPickIntent: cellId === 2 ? sim.myPick.championId : cellId === 4 ? 3 : 0,
            assignedPosition: "",
          })),
          // The client can leave an enemy's championId at 0 after they lock in.
          theirTeam: [{ cellId: 7, championId: 0 }, { cellId: 8, championId: 0 }],
          bans: { myTeamBans: sim.bans, theirTeamBans: [] },
          timer: { adjustedTimeLeftInPhase: 25000, phase: sim.stage },
        };
      if (p === "/lol-game-data/assets/v1/champion-summary.json") return NAMES;
      if (p === "/lol-champ-select/v1/pickable-champion-ids") return NAMES.map((c) => c.id);
      if (p === "/lol-champ-select/v1/bannable-champion-ids") return NAMES.map((c) => c.id);
      if (p === "/lol-champ-select/v1/session/champion-swaps") return sim.swaps;
      throw { response: { status: 404, data: { message: `no ${p}` } } };
    },
    patch: async (path, body: any) => {
      sim.writes.push({ method: "PATCH", path, body });
      if (path === "/lol-champ-select/v1/session/actions/7") sim.myPick = { ...sim.myPick, ...body };
      if (path === "/lol-champ-select/v1/session/my-selection" && body.spell1Id) sim.spells = [body.spell1Id, body.spell2Id];
    },
    post: async (path, body) => void sim.writes.push({ method: "POST", path, body }),
    put: async (path, body) => void sim.writes.push({ method: "PUT", path, body }),
    delete: async (path) => void sim.writes.push({ method: "DELETE", path, body: undefined }),
    getBytes: async () => new Uint8Array(),
  };
  /** Everyone on your team has locked in (the final phase): you Olaf, then Annie, Galio, Aurelion Sol, Kai'Sa. */
  const allLocked = () => {
    sim.otherTurn = null;
    sim.stage = "FINALIZATION";
    sim.myPick = { ...sim.myPick, completed: true, championId: 2 };
    sim.teamPicks = [[3, 1], [4, 3], [5, 136], [6, 145]].map(([cell, champ]) => ({
      id: 20 + cell, actorCellId: cell, type: "pick", isInProgress: false, completed: true, championId: champ,
    }));
  };
  return { sim, client, allLocked };
}

// phone.ts keeps champion names for 10 minutes; other test files fill it with their own list.
beforeEach(() => {
  resetChampionCache();
  resetModeCache();
  resetIconCache();
  resetRuneIconCache();
});

let open: Window[] = [];
afterEach(async () => {
  await Promise.all(open.map((w) => w.happyDOM.close()));
  open = [];
});

/** Opens the phone page against `client` and waits for its first update. */
async function openPage(client: LcuClient) {
  const w = new Window({ url: "http://phone.test/", settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } as any });
  open.push(w);
  (w as any).fetch = (input: string, init: any = {}) =>
    new Promise((resolve, reject) => {
      // The page gives up on a request with its AbortController; a stuck request must honor it.
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      const req = new Request(new URL(input, "http://phone.test/"), { method: init.method, headers: init.headers, body: init.body });
      handlePhone(req, { client, fetch: dataDragon as any }).then(resolve, reject);
    });
  w.document.write(PAGE as unknown as string);
  const doc = w.document;
  const page = {
    w,
    $: (id: string) => doc.getElementById(id) as any,
    texts: (sel: string) => [...doc.querySelectorAll(sel)].map((n) => n.textContent),
    type(text: string) {
      const box = page.$("search");
      box.value = text;
      box.dispatchEvent(new w.Event("input"));
    },
    /** Waits until `check` is true, or fails after `ms`. */
    async until(check: () => boolean, ms = 3000) {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) throw new Error("timed out waiting for the page");
        await Bun.sleep(25);
      }
    },
  };
  const connected = () => !["", "Connecting...", "Not connected"].includes(page.$("phase").textContent);
  await page.until(() => connected() && (page.$("zones").hidden || page.texts("#team .nm").length === 5));
  return page;
}

test("before your turn the champions are listed, and search ignores case, accents and marks", async () => {
  const page = await openPage(champSelect().client);
  // Galio is left out: a teammate is hovering it.
  expect(page.texts("#tiles .tname")).toEqual(["Annie", "Olaf", "Aurelion Sol", "Kai'Sa"]);
  expect(page.$("hint").textContent).toContain("pre-pick");

  const search = (q: string) => {
    page.type(q);
    return page.texts("#tiles .tname");
  };
  expect(search("kaisa")).toEqual(["Kai'Sa"]);
  expect(search("KAI'SA")).toEqual(["Kai'Sa"]);
  expect(search("  sol ")).toEqual(["Aurelion Sol"]);
  expect(search("aurelionsol")).toEqual(["Aurelion Sol"]);
  expect(search("xyz")).toEqual([]);
  expect(page.$("tiles").textContent).toBe("No champion matches.");
  expect(search("")).toHaveLength(4);
});

test("search keeps its filter when the page updates", async () => {
  const page = await openPage(champSelect().client);
  page.type("olaf");
  await Bun.sleep(2300); // one update round
  expect(page.texts("#tiles .tname")).toEqual(["Olaf"]);
});

test("tapping a champion before your turn pre-picks it on your coming pick; Lock In waits", async () => {
  const { sim, client } = champSelect();
  const page = await openPage(client);
  page.type("kai");
  page.$("tiles").querySelector(".tile").click();
  await page.until(() => sim.writes.length > 0);
  expect(sim.writes).toEqual([{ method: "PATCH", path: "/lol-champ-select/v1/session/actions/7", body: { championId: 145 } }]);
  await page.until(() => page.texts("#tiles .tile.on .tname").join() === "Kai'Sa");
  expect(page.$("msg").textContent).toBe("Pre-picked Kai'Sa.");
  expect(page.$("lock").disabled).toBe(true);
  // Your row shows the pre-pick to you as your team sees it.
  expect(page.texts("#team .row.mine .nm")).toEqual(["Kai'Sa"]);
});

test("a teammate's or banned champion is not offered", async () => {
  const { sim, client } = champSelect();
  sim.bans = [1]; // Annie banned; cell 4 is hovering Galio
  const page = await openPage(client);
  expect(page.texts("#tiles .tname")).toEqual(["Olaf", "Aurelion Sol", "Kai'Sa"]);
  page.type("galio");
  expect(page.$("tiles").textContent).toBe("No champion matches.");
});

test("on your turn a tap hovers, and Lock In locks the hovered champion", async () => {
  const { sim, client } = champSelect();
  sim.otherTurn = null;
  sim.myPick.isInProgress = true;
  const page = await openPage(client);
  expect(page.$("hint").textContent).toContain("Your turn");
  page.type("olaf");
  page.$("tiles").querySelector(".tile").click();
  await page.until(() => !page.$("lock").disabled);
  page.$("lock").click();
  await page.until(() => sim.writes.length === 2);
  expect(sim.writes.map((x) => x.body)).toEqual([{ championId: 2, completed: false }, { championId: 2, completed: true }]);
});

test("of four swap entries the client lists, only the request sent to you pops up", async () => {
  const { sim, client, allLocked } = champSelect();
  allLocked(); // champions are swapped once everyone has locked in
  sim.swaps = [
    { id: 21, cellId: 3, state: "AVAILABLE" },
    { id: 22, cellId: 4, state: "RECEIVED" },
    { id: 23, cellId: 5, state: "AVAILABLE" },
    { id: 24, cellId: 6, state: "BUSY" },
  ];
  const page = await openPage(client);
  await page.until(() => !page.$("swaps").hidden);
  expect(page.texts("#swap-items .swap-text")).toEqual(["Swap for Galio?"]);
  // A Swap button only where the client allows a swap: cells 3 and 5.
  expect(page.$("team").querySelectorAll("button.swap").length).toBe(2);

  page.$("swap-items").querySelector(".accept").click();
  await page.until(() => sim.writes.length === 1);
  expect(sim.writes[0]).toEqual({ method: "POST", path: "/lol-champ-select/v1/session/champion-swaps/22/accept", body: {} });
});

test("asking a teammate for a swap uses the client's swap id, and a sent request can be cancelled", async () => {
  const { sim, client, allLocked } = champSelect();
  allLocked(); // champions are swapped once everyone has locked in
  sim.swaps = [{ id: 21, cellId: 3, state: "AVAILABLE" }];
  const page = await openPage(client);
  await page.until(() => page.$("team").querySelector("button.swap") !== null);
  page.$("team").querySelector("button.swap").click();
  await page.until(() => sim.writes.length === 1);
  // Swap 21 with the teammate in cell 3: the request goes to the swap's id.
  expect(sim.writes[0]).toEqual({ method: "POST", path: "/lol-champ-select/v1/session/champion-swaps/21/request", body: {} });

  sim.swaps = [{ id: 21, cellId: 3, state: "SENT" }];
  await page.until(() => page.texts("#team .tag").includes("Champion swap asked"), 3000);
  const cancel = page.$("team").querySelector("button.swap");
  expect(cancel.textContent).toBe("Cancel");
  cancel.click();
  await page.until(() => sim.writes.length === 2);
  expect(sim.writes[1].path).toBe("/lol-champ-select/v1/session/champion-swaps/21/cancel");
});

test("the header names the client's phase between turns", async () => {
  const { sim, client } = champSelect();
  sim.otherTurn = null;
  sim.stage = "PLANNING";
  const page = await openPage(client);
  expect(page.$("phase").textContent).toBe("Declare your pick");
  sim.stage = "FINALIZATION";
  sim.myPick = { ...sim.myPick, completed: true, championId: 2 };
  await page.until(() => page.$("phase").textContent === "Final phase", 3000);
});

test("a swap request can be declined, and the pop-up goes when the request does", async () => {
  const { sim, client, allLocked } = champSelect();
  allLocked(); // champions are swapped once everyone has locked in
  sim.swaps = [{ id: 22, cellId: 4, state: "RECEIVED" }];
  const page = await openPage(client);
  await page.until(() => !page.$("swaps").hidden);
  [...page.$("swap-items").querySelectorAll("button")].find((b: any) => b.textContent === "Decline").click();
  await page.until(() => sim.writes.length === 1);
  expect(sim.writes[0].path).toBe("/lol-champ-select/v1/session/champion-swaps/22/decline");
  sim.swaps = [{ id: 22, cellId: 4, state: "AVAILABLE" }];
  await page.until(() => page.$("swaps").hidden, 3000);
});

test("an enemy's pick appears without a reload once they lock in", async () => {
  const { sim, client } = champSelect();
  const page = await openPage(client);
  expect(page.texts("#enemies .nm")).toEqual(["picking...", "picking..."]);
  sim.enemyPicks = [{ id: 9, actorCellId: 8, type: "pick", isInProgress: false, completed: true, championId: 1 }];
  await page.until(() => page.texts("#enemies .nm")[1] === "Annie", 3000);
  expect(page.texts("#enemies .nm")).toEqual(["picking...", "Annie"]);
});

test("updates keep coming after a request that is never answered", async () => {
  const { sim, client } = champSelect();
  const page = await openPage(client);
  sim.hangNext = true;
  await Bun.sleep(2300); // the next round hangs
  sim.enemyPicks = [{ id: 9, actorCellId: 7, type: "pick", isInProgress: false, completed: true, championId: 2 }];
  // The page gives up on the stuck request after 8 s, then updates again.
  await page.until(() => page.texts("#enemies .nm")[0] === "Olaf", 13000);
}, 20000);

// ---- The features asked for, one by one, through the phone page. ----

/** The first button under `root` whose text is `text`. */
const button = (root: any, text: string) => [...root.querySelectorAll("button")].find((b: any) => b.textContent === text) as any;

test("pick order: ask a teammate to swap by the client's swap id, and answer a request sent to you", async () => {
  const { sim, client } = champSelect();
  sim.orderSwaps = [
    { id: 41, cellId: 3, state: "AVAILABLE" },
    { id: 42, cellId: 4, state: "RECEIVED" },
    { id: 43, cellId: 5, state: "BUSY" },
  ];
  const page = await openPage(client);
  await page.until(() => !page.$("swaps").hidden);
  // Cell 4 is hovering Galio: the one request names them.
  expect(page.texts("#swap-items .swap-text")).toEqual(["Swap pick order with Galio?"]);
  // One "Swap order" button, on cell 3's row.
  const rows = [...page.$("team").querySelectorAll("li")];
  expect(rows.map((r: any) => (button(r, "Swap order") ? 1 : 0))).toEqual([0, 1, 0, 0, 0]);

  button(rows[1], "Swap order").click();
  await page.until(() => sim.writes.length === 1);
  expect(sim.writes[0]).toEqual({ method: "POST", path: "/lol-champ-select/v1/session/pick-order-swaps/41/request", body: {} });

  button(page.$("swap-items"), "Accept").click();
  await page.until(() => sim.writes.length === 2);
  expect(sim.writes[1].path).toBe("/lol-champ-select/v1/session/pick-order-swaps/42/accept");
});

test("summoner spells: the sheet lists Summoner's Rift spells, and a tap saves the pair", async () => {
  const { sim, client } = champSelect();
  const page = await openPage(client);
  await page.until(() => !page.$("spell1").disabled);
  page.$("spell1").click();
  await page.until(() => page.texts("#spell-list .opt-name").length > 0);
  expect(page.texts("#spell-list .opt-name")).toEqual(["Flash", "Ignite", "Heal"]);
  // A spell button holds its icon and its name.
  const heal = [...page.$("spell-list").querySelectorAll("button")].find((b: any) => b.querySelector(".opt-name").textContent === "Heal") as any;
  heal.click();
  await page.until(() => page.$("spell-msg").textContent === "Spells saved.");
  expect(sim.writes).toEqual([{ method: "PATCH", path: "/lol-champ-select/v1/session/my-selection", body: { spell1Id: 7, spell2Id: 14 } }]);
  // The bar shows the new pair after the next update.
  await page.until(() => page.$("spell1").getAttribute("aria-label") === "Spell: Heal", 3000);
});

test("runes: open a page, change the keystone, save; a locked page cannot be edited", async () => {
  const { sim, client } = champSelect();
  const page = await openPage(client);
  page.$("runes").click();
  await page.until(() => page.texts("#rune-list .opt-name").length === 2);
  expect(page.texts("#rune-list .opt-name")).toEqual(["Fixed", "Ekko"]);
  const [fixed, ekko] = [...page.$("rune-list").querySelectorAll(".rune-row")] as any[];
  expect(button(fixed, "Locked").disabled).toBe(true);

  button(ekko, "Edit").click();
  expect(page.$("rune-edit-view").hidden).toBe(false);
  // The keystone row holds Press the Attack (8005) and Lethal Tempo (8008); pick Lethal Tempo.
  const keystones = page.$("rune-body").querySelector(".rune-grid.wide");
  [...keystones.querySelectorAll("button")][1].click();
  page.$("rune-name").value = "Ekko AP";
  page.$("rune-save").click();
  await page.until(() => sim.writes.length === 1);
  expect(sim.writes[0]).toEqual({
    method: "PUT",
    path: "/lol-perks/v1/pages/13",
    body: { name: "Ekko AP", primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: [8008, ...RUNES.slice(1)], current: true },
  });
  await page.until(() => page.$("rune-edit-msg").textContent === "Saved.");
});

test("runes: a page missing a choice is not sent, and the missing choice is named", async () => {
  const { sim, client } = champSelect();
  const page = await openPage(client);
  page.$("runes").click();
  await page.until(() => page.texts("#rune-list .opt-name").length === 2);
  button(page.$("rune-list").querySelectorAll(".rune-row")[1], "Edit").click();
  // Switching the primary tree clears its keystone and rows.
  const sorcery = [...page.$("rune-body").querySelectorAll(".rtree")].find((b: any) => b.textContent === "Sorcery") as any;
  sorcery.click();
  page.$("rune-save").click();
  expect(page.$("rune-edit-msg").textContent).toBe("Pick a keystone.");
  await Bun.sleep(100);
  expect(sim.writes).toEqual([]);
});

test("lobby: switch the mode, queue up, then cancel the search", async () => {
  const { sim, client } = champSelect();
  sim.phase = "Lobby";
  const page = await openPage(client);
  await page.until(() => !page.$("modes").hidden);
  expect(page.$("phase").textContent).toBe("In a lobby");
  expect(page.texts("#modes .chip")).toEqual(["Ranked Solo/Duo", "Normal Blind", "ARAM"]);
  expect(page.texts("#modes .chip.on")).toEqual(["Ranked Solo/Duo"]);

  button(page.$("modes"), "ARAM").click();
  await page.until(() => sim.writes.length === 1);
  expect(sim.writes[0]).toEqual({ method: "POST", path: "/lol-lobby/v2/lobby", body: { queueId: 450 } });

  page.$("queue").click();
  await page.until(() => sim.writes.length === 2);
  expect(sim.writes[1]).toEqual({ method: "POST", path: "/lol-lobby/v2/lobby/matchmaking/search", body: {} });

  sim.phase = "Matchmaking";
  await page.until(() => !page.$("cancel").hidden, 3000);
  expect(page.$("queue").hidden).toBe(true);
  page.$("cancel").click();
  await page.until(() => sim.writes.length === 3);
  expect(sim.writes[2]).toEqual({ method: "DELETE", path: "/lol-lobby/v2/lobby/matchmaking/search", body: undefined });
});

test("match found: accept it", async () => {
  const { sim, client } = champSelect();
  sim.phase = "ReadyCheck";
  const page = await openPage(client);
  expect(page.$("phase").textContent).toBe("Match found");
  page.$("accept").click();
  await page.until(() => sim.writes.length === 1);
  expect(sim.writes[0]).toEqual({ method: "POST", path: "/lol-matchmaking/v1/ready-check/accept", body: {} });
  // Once answered, the buttons are turned off.
  sim.readyResponse = "Accepted";
  await page.until(() => page.$("accept").disabled, 3000);
  expect(page.$("decline").disabled).toBe(true);
});

test("match found: decline it", async () => {
  const { sim, client } = champSelect();
  sim.phase = "ReadyCheck";
  const page = await openPage(client);
  page.$("decline").click();
  await page.until(() => sim.writes.length === 1);
  expect(sim.writes[0]).toEqual({ method: "POST", path: "/lol-matchmaking/v1/ready-check/decline", body: {} });
});

test("dodge: one tap only warns, a second tap leaves champion select", async () => {
  const { sim, client } = champSelect();
  const page = await openPage(client);
  page.$("dodge").click();
  expect(page.$("dodge").textContent).toBe("Tap again to dodge (LP loss and a queue wait)");
  await Bun.sleep(100);
  expect(sim.writes).toEqual([]);
  page.$("dodge").click();
  await page.until(() => sim.writes.length === 1);
  const url = new URL(sim.writes[0].path, "https://127.0.0.1");
  expect(url.pathname).toBe("/lol-login/v1/session/invoke");
  expect(JSON.parse(url.searchParams.get("args")!)).toEqual(["", "teambuilder-draft", "quitV2", ""]);
  expect(page.$("dodge").textContent).toBe("Dodge");
});

test("dodge: a single tap wears off after 4 s", async () => {
  const { sim, client } = champSelect();
  const page = await openPage(client);
  page.$("dodge").click();
  await page.until(() => page.$("dodge").textContent === "Dodge", 5000);
  page.$("dodge").click();
  await Bun.sleep(100);
  expect(sim.writes).toEqual([]);
}, 10000);

test("leave the lobby: two taps", async () => {
  const { sim, client } = champSelect();
  sim.phase = "Lobby";
  const page = await openPage(client);
  await page.until(() => !page.$("leave").hidden);
  page.$("leave").click();
  await Bun.sleep(100);
  expect(sim.writes).toEqual([]);
  page.$("leave").click();
  await page.until(() => sim.writes.length === 1);
  expect(sim.writes[0]).toEqual({ method: "DELETE", path: "/lol-lobby/v2/lobby", body: undefined });
});

test("summoner spells: picking the spell in your other slot swaps the two, as in the client", async () => {
  const { sim, client } = champSelect(); // Flash and Ignite
  const page = await openPage(client);
  await page.until(() => !page.$("spell2").disabled);
  page.$("spell2").click();
  await page.until(() => page.texts("#spell-list .opt-name").length > 0);
  const flash = [...page.$("spell-list").querySelectorAll("button")].find((b: any) => b.querySelector(".opt-name").textContent === "Flash") as any;
  flash.click();
  await page.until(() => page.$("spell-msg").textContent === "Spells saved.");
  expect(sim.writes).toEqual([{ method: "PATCH", path: "/lol-champ-select/v1/session/my-selection", body: { spell1Id: 14, spell2Id: 4 } }]);
});

test("after you lock in, the hint says so and no swap of pick order is offered", async () => {
  const { sim, client } = champSelect();
  sim.myPick = { ...sim.myPick, completed: true, championId: 2 };
  sim.orderSwaps = [{ id: 41, cellId: 3, state: "AVAILABLE" }, { id: 42, cellId: 4, state: "RECEIVED" }];
  const page = await openPage(client);
  expect(page.$("hint").textContent).toBe("You are locked in.");
  expect(button(page.$("team"), "Swap order")).toBeUndefined();
  expect(page.$("swaps").hidden).toBe(true);
});

test("when the client cannot be reached, the waiting screen says why", async () => {
  const { sim, client } = champSelect();
  sim.phase = "Lobby";
  const page = await openPage(client);
  client.get = async () => {
    throw { code: "ECONNREFUSED" };
  };
  await page.until(() => page.$("phase").textContent === "Not connected", 3000);
  expect(page.$("idle").hidden).toBe(false);
  expect(page.$("idle-text").textContent).toBe("League client not running. Retrying...");
});
