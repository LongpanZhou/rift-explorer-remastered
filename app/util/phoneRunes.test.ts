import { beforeEach, expect, test } from "bun:test";
import { ActionRefused } from "./player";
import { resetRuneIconCache, runeData, runeIcon, saveRunePage } from "./phoneRunes";
import { resetIconCache } from "./phoneIcons";
import { fakeClient } from "./fakeClient";

beforeEach(() => {
  resetIconCache();
  resetRuneIconCache();
});

const PAGES = "/lol-perks/v1/pages";
const PERKS = "/lol-perks/v1/perks";
const STYLES = "/lol-perks/v1/styles";
const CDRAGON = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/";

/** The message of the refusal a call throws. Fails the test if the call does not throw an ActionRefused. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ActionRefused);
  return (err as Error).message;
}

const SHARDS = [
  [5005, 5008, 5007],
  [5008, 5002, 5003],
  [5001, 5002, 5003],
];
const TREE_IDS = [8000, 8100, 8200, 8300, 8400];
// A style as the client lists it: a keystone slot, three rune rows, then three stat shard rows.
const style = (id: number, name: string, keystones: number[], rows: number[][]) => {
  const allowed = TREE_IDS.filter((x) => x !== id);
  return {
    id,
    name,
    iconPath: `/lol-game-data/assets/v1/perk-images/styles/${name.toLowerCase()}/${name.toLowerCase()}.png`,
    allowedSubStyles: allowed,
    defaultSubStyle: allowed[0],
    slots: [
      { type: "kKeyStone", perks: keystones },
      ...rows.map((perks) => ({ type: "kMixedRegularSplashable", perks })),
      ...SHARDS.map((perks) => ({ type: "kStatMod", perks })),
    ],
  };
};
const STYLE_LIST = [
  style(8000, "Precision", [8005, 8008], [[9101, 9111, 8009], [9104, 9105, 9103], [8014, 8017, 8299]]),
  style(8100, "Domination", [8128], [[8126, 8139, 8135], [8105, 8106, 8138], [8134, 8120, 8143]]),
  style(8200, "Sorcery", [8214, 8229, 8230], [[8224, 8226, 8210], [8237, 8233, 8236], [8242, 8234, 8232]]),
  style(8300, "Inspiration", [8351, 8360, 8369], [[8306, 8304, 8313], [8321, 8316, 8345], [8347, 8410, 8352]]),
  style(8400, "Resolve", [8437, 8439, 8465], [[8446, 8429, 8451], [8444, 8473, 8453], [8463, 8401, 8475]]),
];
// Every rune and shard in the styles, named "Rune <id>". The icon path has capitals, which the
// icon route must lower case.
const PERK_LIST = [...new Set(STYLE_LIST.flatMap((s) => s.slots.flatMap((x) => x.perks)))].map((id) => ({
  id,
  name: `Rune ${id}`,
  iconPath: `/lol-game-data/assets/v1/Perk-Images/${id}.png`,
}));
// Precision primary with Domination secondary: keystone, one rune per primary row, two secondary
// runes from different rows, then one shard per row.
const VALID = [8005, 9101, 9104, 8014, 8126, 8105, 5007, 5002, 5001];
const PAGE_LIST = [
  { id: 11, name: "Mage", current: true, isEditable: true, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: VALID },
  { id: 12, name: "Fixed", current: false, isEditable: false, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: VALID },
  { id: 13, name: "Ekko", current: false, isEditable: true, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: VALID },
];
const GETS = { [PAGES]: PAGE_LIST, [PERKS]: PERK_LIST, [STYLES]: STYLE_LIST };
const PAGE = { id: 13, name: "Ekko", primaryStyleId: 8000, subStyleId: 8100, perks: VALID };

test("runeData gives pages with nine runes, five trees, the shards, and a name and icon for every id used", async () => {
  const data = await runeData(fakeClient(GETS).client);
  expect(data.pages[0]).toEqual({ id: 11, name: "Mage", current: true, editable: true, primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: VALID });
  expect(data.pages.every((p) => p.selectedPerkIds.length === 9)).toBe(true);
  expect(data.trees.map((t) => t.name)).toEqual(["Precision", "Domination", "Sorcery", "Inspiration", "Resolve"]);
  expect(data.trees[0]).toEqual({
    id: 8000,
    name: "Precision",
    keystones: [8005, 8008],
    rows: [[9101, 9111, 8009], [9104, 9105, 9103], [8014, 8017, 8299]],
  });
  expect(data.shards).toEqual(SHARDS);

  const used = [
    ...data.pages.flatMap((p) => p.selectedPerkIds),
    ...data.trees.flatMap((t) => [t.id, ...t.keystones, ...t.rows.flat()]),
    ...data.shards.flat(),
  ];
  for (const id of used) expect(data.names[id]).toEqual({ name: expect.any(String), icon: `/icon/rune/${id}.png` });
  expect(data.names[8000].name).toBe("Precision");
  expect(data.names[8005].name).toBe("Rune 8005");
});

test("saveRunePage sets the name, trees and runes, and keeps each page's current flag", async () => {
  const { client, writes } = fakeClient(GETS);
  expect(await saveRunePage(client, { ...PAGE, name: "  Ekko ⚡ " })).toEqual({ ok: true });
  expect(await saveRunePage(client, { ...PAGE, id: 11, name: "Mage" })).toEqual({ ok: true });
  expect(writes).toEqual([
    {
      method: "PUT",
      path: `${PAGES}/13`,
      body: { name: "Ekko ⚡", primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: VALID, current: false },
    },
    {
      method: "PUT",
      path: `${PAGES}/11`,
      body: { name: "Mage", primaryStyleId: 8000, subStyleId: 8100, selectedPerkIds: VALID, current: true },
    },
  ]);
});

test("saveRunePage refuses an illegal page, a page that cannot be edited, and a wrong number of runes; nothing is sent", async () => {
  const { client, writes } = fakeClient(GETS);
  const twoFromOneRow = [8005, 9101, 9104, 8014, 8126, 8139, 5007, 5002, 5001];
  expect(await refusal(saveRunePage(client, { ...PAGE, perks: twoFromOneRow }))).toBe(
    "pick two secondary runes from different rows"
  );
  expect(await refusal(saveRunePage(client, { ...PAGE, id: 12 }))).toBe("page 12 is not one of your editable pages");
  expect(await refusal(saveRunePage(client, { ...PAGE, id: 99 }))).toBe("page 99 is not one of your editable pages");
  expect(await refusal(saveRunePage(client, { ...PAGE, perks: VALID.slice(0, 8) }))).toBe("a page needs exactly 9 runes");
  expect(await refusal(saveRunePage(client, { ...PAGE, perks: undefined }))).toBe("a page needs exactly 9 runes");
  expect(await refusal(saveRunePage(client, { ...PAGE, name: undefined }))).toBe("a rune page needs a name");
  expect(writes).toEqual([]);
});

test("a rune icon is fetched from CommunityDragon in lower case, once, and a tree's icon comes from its style", async () => {
  const { client } = fakeClient(GETS);
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    return new Response(new Uint8Array([137, 80, 78, 71]));
  };
  const rune = await runeIcon(client, 8005, fetchFn);
  expect(rune).toBeInstanceOf(ArrayBuffer);
  expect(new Uint8Array(rune as ArrayBuffer)).toEqual(new Uint8Array([137, 80, 78, 71]));
  expect(urls).toEqual([`${CDRAGON}v1/perk-images/8005.png`]);

  expect(await runeIcon(client, 8005, fetchFn)).toBe(rune);
  expect(urls).toHaveLength(1);

  expect(await runeIcon(client, 8000, fetchFn)).toBeInstanceOf(ArrayBuffer);
  expect(urls[1]).toBe(`${CDRAGON}v1/perk-images/styles/precision/precision.png`);
});

test("a rune icon is null for a path with .., a path outside the game data, a non-png, or an unknown id; nothing is fetched", async () => {
  const { client } = fakeClient({
    [PERKS]: [
      { id: 1, name: "Dots", iconPath: "/lol-game-data/assets/../secret.png" },
      { id: 2, name: "Loot", iconPath: "/fe/lol-loot/token.png" },
      { id: 3, name: "Remote", iconPath: "https://evil.example/x.png" },
      { id: 4, name: "Jpg", iconPath: "/lol-game-data/assets/v1/x.jpg" },
    ],
    [STYLES]: [],
  });
  const fetched: string[] = [];
  const fetchFn = async (url: string) => {
    fetched.push(url);
    return new Response("x");
  };
  for (const id of [1, 2, 3, 4, 99]) expect(await runeIcon(client, id, fetchFn)).toBeNull();
  expect(fetched).toEqual([]);
});

test("a rune icon the CDN cannot give throws, and is not kept", async () => {
  const { client } = fakeClient(GETS);
  let calls = 0;
  const down = async () => {
    calls++;
    return new Response("down", { status: 500 });
  };
  const offline = async () => {
    calls++;
    throw new TypeError("offline");
  };
  await expect(runeIcon(client, 8005, down)).rejects.toThrow();
  await expect(runeIcon(client, 8005, offline)).rejects.toThrow();
  expect(calls).toBe(2);
});
