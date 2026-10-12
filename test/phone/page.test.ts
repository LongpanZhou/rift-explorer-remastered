import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import PAGE from "../../app/util/phone-page.html" with { type: "text" };
import { handlePhone, resetChampionCache } from "../../app/util/phone";
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

/** A champ select the test changes as it goes. You are cell 2; teammates 3 to 6. */
function champSelect() {
  const sim = {
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
        return "ChampSelect";
      }
      if (p === "/lol-champ-select/v1/session")
        return {
          localPlayerCellId: 2,
          actions: [[sim.otherTurn, ...sim.enemyPicks].filter(Boolean), [sim.myPick]],
          myTeam: [2, 3, 4, 5, 6].map((cellId) => ({
            cellId,
            championId: 0,
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
    },
    post: async (path, body) => void sim.writes.push({ method: "POST", path, body }),
    put: async (path, body) => void sim.writes.push({ method: "PUT", path, body }),
    delete: async (path) => void sim.writes.push({ method: "DELETE", path, body: undefined }),
    getBytes: async () => new Uint8Array(),
  };
  return { sim, client };
}

// phone.ts keeps champion names for 10 minutes; other test files fill it with their own list.
beforeEach(() => resetChampionCache());

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
      // Data Dragon is not reached: icons are not part of these checks.
      handlePhone(req, { client, fetch: (async () => new Response("[]", { status: 500 })) as any }).then(resolve, reject);
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
  await page.until(() => page.$("phase").textContent !== "" && page.$("phase").textContent !== "Not connected");
  await page.until(() => page.texts("#team .nm").length === 5);
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
  const { sim, client } = champSelect();
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
  const { sim, client } = champSelect();
  sim.swaps = [{ id: 21, cellId: 3, state: "AVAILABLE" }];
  const page = await openPage(client);
  await page.until(() => page.$("team").querySelector("button.swap") !== null);
  page.$("team").querySelector("button.swap").click();
  await page.until(() => sim.writes.length === 1);
  // Swap 21 with the teammate in cell 3: the request goes to the swap's id.
  expect(sim.writes[0]).toEqual({ method: "POST", path: "/lol-champ-select/v1/session/champion-swaps/21/request", body: {} });

  sim.swaps = [{ id: 21, cellId: 3, state: "SENT" }];
  await page.until(() => page.texts("#team .tag").includes("Swap asked"), 3000);
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
  const { sim, client } = champSelect();
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
  // The page gives up on the stuck request after 4 s, then updates again.
  await page.until(() => page.texts("#enemies .nm")[0] === "Olaf", 9000);
}, 15000);
