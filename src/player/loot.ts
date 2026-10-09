export interface LootItem {
  id: string;
  name: string;
  kind: "champion" | "skin" | "ward" | "material";
  count: number;
  disenchant: number;
  currency: "BE" | "OE";
  upgrade: number;
  owned: boolean;
  tile: string;
}

/** Copies you can disenchant without losing anything: all of them when you
 * own what the item unlocks, otherwise every copy past the first. */
export const safeCount = (i: LootItem) => (i.owned ? i.count : Math.max(0, i.count - 1));

export interface LootSummary {
  /** BE from disenchanting every champion item. */
  championBE: number;
  /** OE from disenchanting every skin and ward shard. */
  shardOE: number;
  /** Champions and skin/ward shards safe to disenchant, most valuable first. */
  safe: LootItem[];
  safeBE: number;
  safeOE: number;
}

/** Essence from disenchanting `count` copies of an item. */
export const worth = (item: LootItem, count = item.count) => item.disenchant * count;

/** Essence from disenchanting the copies you can safely give up. */
export const safeWorth = (item: LootItem) => worth(item, safeCount(item));

export function summarizeLoot(items: LootItem[]): LootSummary {
  const total = (list: LootItem[], per: (i: LootItem) => number) =>
    list.reduce((sum, i) => sum + per(i), 0);
  const champions = items.filter((i) => i.kind === "champion");
  const shards = items.filter((i) => i.kind === "skin" || i.kind === "ward");
  const safe = [...champions, ...shards]
    .filter((i) => i.disenchant > 0 && safeCount(i) > 0)
    .sort((a, b) => b.disenchant * safeCount(b) - a.disenchant * safeCount(a));
  const safeValue = (currency: "BE" | "OE") =>
    total(
      safe.filter((i) => i.currency === currency),
      (i) => worth(i, safeCount(i))
    );

  return {
    championBE: total(champions, (i) => worth(i)),
    shardOE: total(shards, (i) => worth(i)),
    safe,
    safeBE: safeValue("BE"),
    safeOE: safeValue("OE"),
  };
}
