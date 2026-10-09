import { expect, test } from "bun:test";
import { summarizeLoot, type LootItem } from "../../src/player/loot";

const item = (p: Partial<LootItem>): LootItem => ({
  id: "x", name: "x", kind: "skin", count: 1, disenchant: 0, currency: "OE",
  upgrade: 0, owned: false, tile: "", ...p,
});

test("loot summary totals essence and lists what is safe to disenchant", () => {
  const s = summarizeLoot([
    item({ id: "champ", kind: "champion", currency: "BE", disenchant: 3150, count: 2, owned: true }),
    item({ id: "unowned-champ", kind: "champion", currency: "BE", disenchant: 900 }),
    item({ id: "owned-skin", disenchant: 270, owned: true }),
    item({ id: "dupe", disenchant: 100, count: 3 }),
    item({ id: "single", disenchant: 50 }),
    item({ kind: "material" }),
  ]);
  expect(s.championBE).toBe(6300 + 900);
  expect(s.shardOE).toBe(270 + 300 + 50);
  expect(s.safe.map((i) => i.id)).toEqual(["champ", "owned-skin", "dupe"]);
  expect(s.safeBE).toBe(6300);
  expect(s.safeOE).toBe(270 + 200);
});
