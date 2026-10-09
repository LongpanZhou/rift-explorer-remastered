import { describe, expect, test } from "bun:test";
import {
  ActionRefused,
  LcuClient,
  loadProfile,
  maxPrestigeCrest,
  setBackground,
  setIcon,
  setRegalia,
  setTitle,
  setTokens,
  downloadAsset,
  claimReward,
  claimAllRewards,
  loadRewards,
  buyRunePage,
  editRunePage,
  runePageProblem,
  autoTick,
  setStatus,
  setStatusMessage,
  loadLive,
  parseAutoArgs,
  decodeName,
} from "./player";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { encodeText } from "./text";

// A fake client that serves canned GETs and records every write.
function fakeClient(gets: Record<string, any>) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const client: LcuClient = {
    get: async (p) => {
      if (!(p in gets)) throw new Error(`unexpected GET ${p}`);
      return gets[p];
    },
    put: async (path, body) => void writes.push({ method: "PUT", path, body }),
    post: async (path, body) => void writes.push({ method: "POST", path, body }),
    patch: async (path, body) => void writes.push({ method: "PATCH", path, body }),
    getBytes: async (p) => {
      if (!(p in gets)) throw new Error(`unexpected GET ${p}`);
      return new TextEncoder().encode(gets[p]);
    },
  };
  return { client, writes };
}

const ICONS = "/lol-inventory/v2/inventory/SUMMONER_ICON";
const SKINS = "/lol-inventory/v2/inventory/CHAMPION_SKIN";
const ME = "/lol-summoner/v1/current-summoner";

describe("player actions refuse before writing", () => {
  test("an unowned icon is refused and nothing is sent", async () => {
    const { client, writes } = fakeClient({
      [ICONS]: [{ itemId: 1, owned: true }, { itemId: 2, owned: false }],
    });
    await expect(setIcon(client, 2)).rejects.toBeInstanceOf(ActionRefused);
    expect(writes).toHaveLength(0);
  });

  test("an icon granted by the inventory counts even when owned is false", async () => {
    const { client, writes } = fakeClient({
      [ICONS]: [
        { itemId: 3, owned: false, ownershipType: "OWNED" },
        { itemId: 4, owned: false, ownershipType: "NONE" },
      ],
    });
    await setIcon(client, 3);
    expect(writes).toHaveLength(1);
    await expect(setIcon(client, 4)).rejects.toBeInstanceOf(ActionRefused);
    await expect(setIcon(client, 99)).rejects.toBeInstanceOf(ActionRefused);
    expect(writes).toHaveLength(1);
  });

  test("an owned icon is set by id", async () => {
    const { client, writes } = fakeClient({ [ICONS]: [{ itemId: 1, owned: true }] });
    await setIcon(client, 1);
    expect(writes).toEqual([
      {
        method: "PUT",
        path: "/lol-summoner/v1/current-summoner/icon",
        body: { profileIconId: 1 },
      },
    ]);
  });

  test("a prestige crest above the level limit is refused", async () => {
    const { client, writes } = fakeClient({ [ME]: { summonerLevel: 60 } });
    await expect(setRegalia(client, "prestige", "blank", 3)).rejects.toBeInstanceOf(
      ActionRefused
    );
    await expect(setRegalia(client, "gold", "blank", 1)).rejects.toBeInstanceOf(
      ActionRefused
    );
    expect(writes).toHaveLength(0);
    await setRegalia(client, "prestige", "lastSeasonHighestRank", 2);
    expect(writes[0].body).toEqual({
      preferredCrestType: "prestige",
      preferredBannerType: "lastSeasonHighestRank",
      selectedPrestigeCrest: 2,
    });
  });

  test("any known skin can be the background; unknown ids are refused", async () => {
    const { client, writes } = fakeClient({
      "/lol-game-data/assets/v1/champions/103.json": { skins: [{ id: 103001 }] },
    });
    await expect(setBackground(client, 103002)).rejects.toBeInstanceOf(ActionRefused);
    // No champion file for 999 (the fake GET throws): refused, not crashed.
    await expect(setBackground(client, 999001)).rejects.toBeInstanceOf(ActionRefused);
    expect(writes).toHaveLength(0);
    await setBackground(client, 103001);
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/lol-summoner/v1/current-summoner/summoner-profile",
        body: { key: "backgroundSkinId", value: 103001 },
      },
    ]);
  });

  test("tokens must be earned and at most three; titles must be owned", async () => {
    const { client, writes } = fakeClient({
      "/lol-challenges/v1/challenges/local-player": {
        "1": { id: 1, name: "A", currentLevel: "GOLD" },
        "2": { id: 2, name: "B", currentLevel: "NONE" },
      },
      "/lol-challenges/v2/titles/local-player": [{ itemId: 50, name: "Owned title" }],
      "/lol-challenges/v1/summary-player-data/local-player": { topChallenges: [{ id: 1 }] },
    });
    await expect(setTokens(client, [2])).rejects.toBeInstanceOf(ActionRefused);
    await expect(setTokens(client, [1, 1, 1, 1])).rejects.toBeInstanceOf(ActionRefused);
    await expect(setTitle(client, 51)).rejects.toBeInstanceOf(ActionRefused);
    expect(writes).toHaveLength(0);
    await setTokens(client, [1]);
    await setTitle(client, 50);
    await setTitle(client, -1);
    expect(writes.map((w) => w.body)).toEqual([
      { challengeIds: [1] },
      { challengeIds: [1], title: "50" },
      { challengeIds: [1], title: "" },
    ]);
  });

  test("prestige crests unlock every 25 levels", () => {
    expect(maxPrestigeCrest(24)).toBe(0);
    expect(maxPrestigeCrest(541)).toBe(21);
  });
});

test("loadProfile keeps the local player's entry and drops identifiers", async () => {
  const { client } = fakeClient({
    [ME]: { puuid: "me", gameName: "A", tagLine: "NA1", summonerLevel: 30, profileIconId: 7 },
    "/lol-ranked/v1/current-ranked-stats": { queueMap: {} },
    "/lol-match-history/v1/products/lol/current-summoner/matches": {
      games: {
        games: [
          {
            queueId: 420,
            gameMode: "CLASSIC",
            gameCreation: 1,
            gameDuration: 1800,
            participantIdentities: [
              { participantId: 1, player: { puuid: "other" } },
              { participantId: 2, player: { puuid: "me" } },
            ],
            participants: [
              { participantId: 1, championId: 10, stats: { win: false } },
              { participantId: 2, championId: 20, stats: { win: true } },
            ],
          },
        ],
      },
    },
    "/lol-game-data/assets/v1/champion-summary.json": [{ id: 20, name: "B", alias: "B" }],
    "/lol-game-data/assets/v1/skins.json": {
      "20000": { id: 20000, name: "B" },
      "20001": { id: 20001, name: "Cool B" },
    },
    "/lol-game-data/assets/v1/summoner-icons.json": [{ id: 7, title: "Seven" }, { id: 8, title: "Eight" }],
    "/lol-regalia/v2/current-summoner/regalia": {},
    "/lol-summoner/v1/current-summoner/summoner-profile": { backgroundSkinId: 0 },
    [ICONS]: [{ itemId: 7, owned: true }],
    [SKINS]: [{ itemId: 20001, owned: true }],
  });
  const p = await loadProfile(client);
  expect(p.icons).toEqual([
    { id: 8, title: "Eight", owned: false },
    { id: 7, title: "Seven", owned: true },
  ]);
  expect(p.skins.find((s) => s.id === 20001)?.owned).toBe(true);
  expect(p.skins.find((s) => s.id === 20000)?.owned).toBe(false);
  expect(p.games[0]).toMatchObject({ championId: 20, win: true });
  expect(JSON.stringify(p)).not.toContain("puuid");
  expect(p.ranked[0]).toMatchObject({ queueType: "RANKED_SOLO_5x5", tier: "" });
});

test("downloads save the client's full image and refuse unknown items", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rift-dl-"));
  const { client, writes } = fakeClient({
    "/lol-game-data/assets/v1/profile-icons/7.jpg": "icon-bytes",
    "/lol-game-data/assets/v1/champions/103.json": {
      skins: [{ id: 103001, name: "Dynasty Ahri", uncenteredSplashPath: "/splash/full.jpg" }],
    },
    "/splash/full.jpg": "splash-bytes",
  });
  const icon = await downloadAsset(client, "icon", 7, dir);
  expect(readFileSync(icon.path, "utf8")).toBe("icon-bytes");
  const skin = await downloadAsset(client, "skin", 103001, dir);
  expect(skin.path.endsWith("Dynasty Ahri (103001).jpg")).toBe(true);
  expect(readFileSync(skin.path, "utf8")).toBe("splash-bytes");
  await expect(downloadAsset(client, "skin", 103999, dir)).rejects.toBeInstanceOf(ActionRefused);
  await expect(downloadAsset(client, "ward", 1, dir)).rejects.toBeInstanceOf(ActionRefused);
  await expect(downloadAsset(client, "icon", 1.5, dir)).rejects.toBeInstanceOf(ActionRefused);
  expect(writes).toHaveLength(0);
});

test("rewards: only pending grants are listed; forced grants claim every item", async () => {
  const grant = (id: string, status: string, n: number, min = n) => ({
    info: { id, status, rewardGroupId: `group-${id}`, dateCreated: "2026-01-02T00:00:00Z" },
    rewardGroup: {
      localizations: { title: "Placeholder Name for Reward Group DO NOT TRANSLATE" },
      selectionStrategyConfig: { minSelectionsAllowed: min, maxSelectionsAllowed: min },
      rewards: Array.from({ length: n }, (_, k) => ({ id: `${id}-r${k}`, localizations: { title: `Item ${k}` } })),
    },
  });
  const { client, writes } = fakeClient({
    "/lol-rewards/v1/grants": [grant("a", "PENDING_SELECTION", 2), grant("b", "SELECTED", 1), grant("c", "PENDING_SELECTION", 3, 1)],
  });
  const list = await loadRewards(client);
  expect(list.map((r) => r.grantId)).toEqual(["a", "c"]);
  expect(list[0].title).toBe("Item 0 + Item 1");
  await expect(claimReward(client, "b")).rejects.toBeInstanceOf(ActionRefused);
  await expect(claimReward(client, "c")).rejects.toBeInstanceOf(ActionRefused);
  expect(writes).toHaveLength(0);
  await claimReward(client, "a");
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/lol-rewards/v1/grants/a/select",
      body: { grantId: "a", rewardGroupId: "group-a", selections: ["a-r0", "a-r1"] },
    },
  ]);
});

test("claim all takes every forced reward, skips choices and keeps going on failure", async () => {
  const grant = (id: string, n: number, min = n) => ({
    info: { id, status: "PENDING_SELECTION", rewardGroupId: `g-${id}`, dateCreated: id },
    rewardGroup: {
      selectionStrategyConfig: { minSelectionsAllowed: min, maxSelectionsAllowed: min },
      rewards: Array.from({ length: n }, (_, k) => ({ id: `${id}${k}`, localizations: { title: "x" } })),
    },
  });
  const posts: string[] = [];
  const client: LcuClient = {
    get: async () => [grant("a", 1), grant("b", 3, 1), grant("c", 1), grant("d", 2)],
    put: async () => {},
    patch: async () => {},
    post: async (path) => {
      posts.push(path);
      if (path.includes("/c/")) throw { response: { data: { message: "boom" } } };
    },
    getBytes: async () => new Uint8Array(),
  };
  expect(await claimAllRewards(client)).toEqual({
    claimed: ["a", "d"],
    skipped: ["b"],
    failed: [{ grantId: "c", error: "boom" }],
  });
  expect(posts).toHaveLength(3);
});

test("buying a rune page uses the client's own price, and is refused when none is offered", async () => {
  const W = "/lol-purchase-widget/v1/purchasable-item?inventoryType=SPELL_BOOK_PAGE&itemId=1";
  const refused = fakeClient({ [W]: { purchaseOptions: [], validationErrors: [{ id: "validation.item.owned" }] } });
  await expect(buyRunePage(refused.client, "IP")).rejects.toThrow("validation.item.owned");
  expect(refused.writes).toHaveLength(0);

  const key = { itemId: 1, inventoryType: "SPELL_BOOK_PAGE" };
  const price = { currencyType: "IP", price: 6300, purchasable: true };
  const offered = fakeClient({ [W]: { purchaseOptions: [{ priceDetails: [{ itemKey: key, price }] }] } });
  await expect(buyRunePage(offered.client, "RP")).rejects.toBeInstanceOf(ActionRefused);
  await buyRunePage(offered.client, "IP");
  expect(offered.writes).toEqual([
    {
      method: "POST",
      path: "/lol-purchase-widget/v2/purchaseItems",
      body: { items: [{ itemKey: key, quantity: 1, source: "cdp", purchaseCurrencyInfo: price }] },
    },
  ]);
});

const STYLES = [
  {
    id: 8000, name: "Precision", iconPath: "", allowedSubStyles: [8300], defaultSubStyle: 8300,
    slots: [
      { type: "kKeyStone", perks: [8005, 8021] },
      { type: "kMixedRegularSplashable", perks: [9101, 9111] },
      { type: "kMixedRegularSplashable", perks: [9104, 9105] },
      { type: "kMixedRegularSplashable", perks: [8014, 8299] },
      { type: "kStatMod", perks: [5008, 5007] },
      { type: "kStatMod", perks: [5008, 5001] },
      { type: "kStatMod", perks: [5011, 5001] },
    ],
  },
  {
    id: 8300, name: "Inspiration", iconPath: "", allowedSubStyles: [8000], defaultSubStyle: 8000,
    slots: [
      { type: "kKeyStone", perks: [8351] },
      { type: "kMixedRegularSplashable", perks: [8306, 8304] },
      { type: "kMixedRegularSplashable", perks: [8313, 8321] },
      { type: "kMixedRegularSplashable", perks: [8347, 8410] },
      { type: "kStatMod", perks: [5008] }, { type: "kStatMod", perks: [5008] }, { type: "kStatMod", perks: [5011] },
    ],
  },
];
const VALID = [8021, 9101, 9105, 8299, 8304, 8410, 5007, 5001, 5011];

test("rune page rules match the client", async () => {
  const problem = (perks: number[], sub = 8300, primary = 8000) =>
    runePageProblem(
      Object.fromEntries(STYLES.map((s) => [s.id, {
        name: s.name, icon: "", allowedSubStyles: s.allowedSubStyles, defaultSubStyle: s.defaultSubStyle,
        keystones: s.slots[0].perks, rows: s.slots.slice(1, 4).map((x) => x.perks), shards: s.slots.slice(4).map((x) => x.perks),
      }])),
      primary, sub, perks
    );
  expect(problem(VALID)).toBeNull();
  expect(problem(VALID, 8000)).toContain("secondary tree");
  expect(problem([9101, ...VALID.slice(1)])).toContain("keystone");
  expect(problem([8021, 9104, ...VALID.slice(2)])).toContain("primary row");
  expect(problem([...VALID.slice(0, 4), 8306, 8304, ...VALID.slice(6)])).toContain("different rows");
  expect(problem([...VALID.slice(0, 6), 5001, 5001, 5011])).toContain("stat shard");
  expect(problem(VALID.slice(0, 8))).toContain("9 runes");
});

test("editing a page renames it and sets runes; bad pages are never sent", async () => {
  const { client, writes } = fakeClient({
    "/lol-perks/v1/styles": STYLES,
    "/lol-perks/v1/pages": [{ id: 1, isEditable: true, current: false }, { id: 2, isEditable: false }],
  });
  await expect(editRunePage(client, 2, encodeText("x"), 8000, 8300, VALID)).rejects.toBeInstanceOf(ActionRefused);
  await expect(editRunePage(client, 1, encodeText("x"), 8000, 8000, VALID)).rejects.toBeInstanceOf(ActionRefused);
  await expect(editRunePage(client, 1, "bad name", 8000, 8300, VALID)).rejects.toBeInstanceOf(ActionRefused);
  expect(writes).toHaveLength(0);
  await editRunePage(client, 1, encodeText("  Ekko mid ⚡ "), 8000, 8300, VALID);
  expect(writes[0]).toEqual({
    method: "PUT",
    path: "/lol-perks/v1/pages/1",
    body: { name: "Ekko mid ⚡", primaryStyleId: 8000, subStyleId: 8300, selectedPerkIds: VALID, current: false },
  });
  expect(decodeName("n")).toBe("");
});

const PHASE = "/lol-gameflow/v1/gameflow-phase";
const CHAT = "/lol-chat/v1/me";
const SESSION = "/lol-champ-select/v1/session";
const cfg = (p: Partial<import("./player").AutoConfig> = {}) => ({ accept: true, lock: true, bans: [], picks: [], ...p });

test("auto-accept accepts a pending ready check once, and only when enabled", async () => {
  const pending = { [PHASE]: "ReadyCheck", "/lol-matchmaking/v1/ready-check": { state: "InProgress", playerResponse: "None" } };
  const a = fakeClient(pending);
  expect((await autoTick(a.client, cfg())).did).toBe("accepted the match");
  expect(a.writes).toEqual([{ method: "POST", path: "/lol-matchmaking/v1/ready-check/accept", body: {} }]);
  const off = fakeClient(pending);
  await autoTick(off.client, cfg({ accept: false }));
  const done = fakeClient({ ...pending, "/lol-matchmaking/v1/ready-check": { state: "InProgress", playerResponse: "Accepted" } });
  await autoTick(done.client, cfg());
  expect([...off.writes, ...done.writes]).toHaveLength(0);
});

const session = (action: any, extra: any = {}) => ({
  [PHASE]: "ChampSelect",
  [SESSION]: {
    localPlayerCellId: 2,
    actions: [[{ id: 7, actorCellId: 2, isInProgress: true, completed: false, championId: 0, ...action }]],
    bans: { myTeamBans: [], theirTeamBans: [] },
    myTeam: [{ cellId: 2, championId: 0, championPickIntent: 0 }],
    ...extra,
  },
  "/lol-champ-select/v1/bannable-champion-ids": [1, 2, 3],
  "/lol-champ-select/v1/pickable-champion-ids": [1, 2, 3],
});

test("auto-pick skips banned, teammate and unowned champions, then locks", async () => {
  const { client, writes } = fakeClient(
    session({ type: "pick" }, {
      bans: { myTeamBans: [1], theirTeamBans: [] },
      myTeam: [{ cellId: 2 }, { cellId: 3, championId: 0, championPickIntent: 2 }],
    })
  );
  const r = await autoTick(client, cfg({ picks: [99, 1, 2, 3] }));
  expect(r.did).toBe("locked in 3");
  expect(writes).toEqual([
    { method: "PATCH", path: "/lol-champ-select/v1/session/actions/7", body: { championId: 3, completed: true } },
  ]);
});

test("auto-ban hovers without lock, and never overrides your own hover", async () => {
  const hover = fakeClient(session({ type: "ban" }));
  expect((await autoTick(hover.client, cfg({ lock: false, bans: [2] }))).did).toBe("hovered ban 2");
  expect(hover.writes[0].body).toEqual({ championId: 2, completed: false });

  const mine = fakeClient(session({ type: "ban", championId: 3 }));
  await autoTick(mine.client, cfg({ bans: [2] }));
  const notMyTurn = fakeClient(session({ type: "pick", actorCellId: 4 }));
  await autoTick(notMyTurn.client, cfg({ picks: [1] }));
  expect([...mine.writes, ...notMyTurn.writes]).toHaveLength(0);
});

test("auto-tick arguments are checked", () => {
  expect(parseAutoArgs(["1", "0", "none", "245-103"])).toEqual({ accept: true, lock: false, bans: [], picks: [245, 103] });
  expect(() => parseAutoArgs(["yes", "0", "none", "none"])).toThrow(ActionRefused);
  expect(() => parseAutoArgs(["1", "0", "1,2", "none"])).toThrow(ActionRefused);
});

test("status: only the client's own statuses are sent", async () => {
  const { client, writes } = fakeClient({});
  await setStatus(client, "away");
  await expect(setStatus(client, "invisible")).rejects.toBeInstanceOf(ActionRefused);
  expect(writes).toEqual([{ method: "PUT", path: "/lol-chat/v1/me", body: { availability: "away" } }]);
});


test("status message: decoded, kept as typed, length-capped at 50,000, cleared with an empty value", async () => {
  const { client, writes } = fakeClient({ [CHAT]: { availability: "chat" } });
  await setStatusMessage(client, encodeText("gl hf ⚡ "));
  await setStatusMessage(client, "n");
  await setStatusMessage(client, encodeText("x".repeat(400)));
  await setStatusMessage(client, encodeText("y".repeat(60000)));
  await expect(setStatusMessage(client, "hello")).rejects.toBeInstanceOf(ActionRefused);
  expect(writes.every((w) => (w.body as any).availability === "chat")).toBe(true);
  await setStatusMessage(client, encodeText("\u3000\u3000a\u3000"));
  expect(writes.map((w) => (w.body as any).statusMessage)).toEqual([
    "gl hf ⚡ ",
    "",
    "x".repeat(400),
    "y".repeat(50000),
    "\u3000\u3000a\u3000",
  ]);
});

test("live: reads icon, status, crest, banner, background, title and tokens", async () => {
  const { client } = fakeClient({
    "/lol-summoner/v1/current-summoner": { gameName: "Ekko", tagLine: "EUW", summonerLevel: 541, profileIconId: 1117 },
    "/lol-regalia/v2/current-summoner/regalia": {
      preferredCrestType: "prestige", preferredBannerType: "blank", selectedPrestigeCrest: 3,
    },
    "/lol-summoner/v1/current-summoner/summoner-profile": { backgroundSkinId: 4001 },
    [CHAT]: { availability: "away", statusMessage: "brb" },
    "/lol-challenges/v1/summary-player-data/local-player": {
      title: { itemId: 9001 }, topChallenges: [{ id: 101101 }, { id: 101200 }],
    },
  });
  expect(await loadLive(client)).toEqual({
    summoner: { gameName: "Ekko", tagLine: "EUW", summonerLevel: 541, profileIconId: 1117, availability: "away", statusMessage: "brb" },
    regalia: { preferredCrestType: "prestige", preferredBannerType: "blank", selectedPrestigeCrest: 3, maxPrestigeCrest: 21 },
    backgroundSkinId: 4001,
    currentTitle: 9001,
    currentTokens: [101101, 101200],
  });
});
