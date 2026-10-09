import axios from "axios";
import { mkdir, writeFile } from "fs/promises";
import { Agent } from "https";
import { homedir } from "os";
import { join } from "path";
import type { LockFile } from "./LockFileParser";
import { LEVELS_PER_CREST, TOKEN_LIMIT } from "./rules";

/**
 * Player-side features: one read that builds the profile view, and a small set
 * of cosmetic actions. Every action changes only what the client's own profile
 * screen can change, and only to an item the account owns.
 */

export interface LcuClient {
  get(path: string): Promise<any>;
  put(path: string, body: unknown): Promise<any>;
  post(path: string, body: unknown): Promise<any>;
  patch(path: string, body: unknown): Promise<any>;
  /** Raw bytes, for image assets. */
  getBytes(path: string): Promise<Uint8Array>;
}

export function lcuClient(lock: Pick<LockFile, "address" | "port" | "password">): LcuClient {
  const http = axios.create({
    baseURL: `https://${lock.address}:${lock.port}`,
    auth: { username: "riot", password: lock.password },
    // The client uses a self-signed certificate on 127.0.0.1 only.
    httpsAgent:
      lock.address === "127.0.0.1"
        ? new Agent({ rejectUnauthorized: false })
        : undefined,
  });
  // HTTP errors keep axios's `response`; classify() in sidecar.ts reads it.
  return {
    get: (p) => http.get(p).then((r) => r.data),
    put: (p, b) => http.put(p, b).then((r) => r.data),
    post: (p, b) => http.post(p, b).then((r) => r.data),
    patch: (p, b) => http.patch(p, b).then((r) => r.data),
    getBytes: (p) =>
      http.get(p, { responseType: "arraybuffer" }).then((r) => new Uint8Array(r.data)),
  };
}

// The schema also lists "none", but the client answers 400
// `Invalid preferredCrestType "none"`, so it is not offered.
const CREST_TYPES = ["prestige", "ranked"];
const BANNER_TYPES = ["blank", "lastSeasonHighestRank"];
const SHOWN_QUEUES = ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"];
const byName = new Intl.Collator().compare;

/** Prestige crests unlock every 25 levels (level 541 allows crest 21). */
export function maxPrestigeCrest(level: number): number {
  return Math.floor(level / LEVELS_PER_CREST);
}

/** Thrown when an action is refused before any write is sent. */
export class ActionRefused extends Error {}

/**
 * Items the account may use: the inventory grants them. Some entries report
 * `owned: false` but `ownershipType: "OWNED"` (30 icons on the test account);
 * rentals, loyalty and free-to-play grants also count. Items missing from the
 * inventory are never usable.
 */
export function usable(item: any): boolean {
  return Boolean(
    item.owned || item.ownershipType === "OWNED" || item.rental || item.loyalty || item.f2p
  );
}

async function ownedIds(client: LcuClient, type: string): Promise<Set<number>> {
  const items: any[] = await client.get(`/lol-inventory/v2/inventory/${type}`);
  return new Set(items.filter(usable).map((i) => i.itemId));
}

const CHAT_ME = "/lol-chat/v1/me";
/** Statuses you can choose in the client: online, away, mobile, offline (appear offline). */
export const STATUSES = ["chat", "away", "mobile", "offline"];

/** Sets the custom message friends see under your name; empty clears it. The client accepted 50,000 characters in testing. */
export async function setStatusMessage(client: LcuClient, textArg: string) {
  const statusMessage = decodeName(textArg, 50000, false);
  // The client resets availability when it is left out, so send the current one back.
  const me = await client.get(CHAT_ME);
  return client.put(CHAT_ME, { availability: me.availability, statusMessage });
}

/** The skin with this id, from its champion's game-data file (undefined if unknown). */
async function findSkin(client: LcuClient, skinId: number): Promise<any> {
  const champ = await client
    .get(`/lol-game-data/assets/v1/champions/${Math.floor(skinId / 1000)}.json`)
    .catch(() => null);
  return champ?.skins?.find((s: any) => s.id === skinId);
}

/** The summoner fields the profile shows and the client can change. */
function summonerOf(me: any, chat: any) {
  return {
    gameName: me.gameName as string,
    tagLine: me.tagLine as string,
    summonerLevel: me.summonerLevel as number,
    profileIconId: me.profileIconId as number,
    availability: (chat?.availability ?? "") as string,
    statusMessage: (chat?.statusMessage ?? "") as string,
  };
}

/** Crest and banner, with the highest prestige crest the level allows. */
function regaliaOf(regalia: any, level: number) {
  return {
    preferredCrestType: regalia.preferredCrestType as string,
    preferredBannerType: regalia.preferredBannerType as string,
    selectedPrestigeCrest: regalia.selectedPrestigeCrest as number,
    maxPrestigeCrest: maxPrestigeCrest(level),
  };
}

/**
 * The parts of the profile the client can change while the app is open: icon,
 * level, status, crest and banner, background, title and tokens. Read on a timer; the big
 * catalogs and match history are loaded once with loadProfile.
 */
export async function loadLive(client: LcuClient) {
  const [me, regalia, profile, chat, summary] = await Promise.all([
    client.get("/lol-summoner/v1/current-summoner"),
    client.get("/lol-regalia/v2/current-summoner/regalia"),
    client.get("/lol-summoner/v1/current-summoner/summoner-profile"),
    client.get(CHAT_ME).catch(() => null),
    client.get(CHALLENGE_SUMMARY).catch(() => null),
  ]);
  return {
    summoner: summonerOf(me, chat),
    regalia: regaliaOf(regalia, me.summonerLevel),
    backgroundSkinId: profile.backgroundSkinId as number,
    currentTitle: (summary?.title?.itemId ?? -1) as number,
    currentTokens: (summary?.topChallenges ?? []).map((c: any) => c.id as number),
  };
}

/** Sets your chat status, as shown to friends. */
export async function setStatus(client: LcuClient, availability: string) {
  if (!STATUSES.includes(availability)) throw new ActionRefused(`unknown status ${availability}`);
  return client.put(CHAT_ME, { availability });
}

export async function loadProfile(client: LcuClient) {
  const [me, ranked, history, champs, skins, iconCatalog, regalia, profile, icons, ownedSkins, chat] =
    await Promise.all([
      client.get("/lol-summoner/v1/current-summoner"),
      client.get("/lol-ranked/v1/current-ranked-stats"),
      client.get("/lol-match-history/v1/products/lol/current-summoner/matches"),
      client.get("/lol-game-data/assets/v1/champion-summary.json"),
      client.get("/lol-game-data/assets/v1/skins.json"),
      client.get("/lol-game-data/assets/v1/summoner-icons.json"),
      client.get("/lol-regalia/v2/current-summoner/regalia"),
      client.get("/lol-summoner/v1/current-summoner/summoner-profile"),
      ownedIds(client, "SUMMONER_ICON"),
      ownedIds(client, "CHAMPION_SKIN"),
      // Chat can be down while the rest of the client works; the status is optional.
      client.get(CHAT_ME).catch(() => null),
    ]);

  const champions: Record<number, { name: string; alias: string }> = {};
  for (const c of champs) champions[c.id] = { name: c.name, alias: c.alias };

  const games = (history?.games?.games ?? []).map((g: any) => {
    // Pick the local player's entry; the client lists only that player today.
    const ident = g.participantIdentities?.find(
      (i: any) => i.player?.puuid === me.puuid
    );
    const p =
      g.participants.find((x: any) => x.participantId === ident?.participantId) ??
      g.participants[0];
    return {
      queueId: g.queueId,
      gameMode: g.gameMode,
      gameCreation: g.gameCreation,
      gameDuration: g.gameDuration,
      championId: p?.championId,
      win: p?.stats?.win,
      kills: p?.stats?.kills,
      deaths: p?.stats?.deaths,
      assists: p?.stats?.assists,
    };
  });

  return {
    summoner: summonerOf(me, chat),
    ranked: SHOWN_QUEUES.map((q) => {
      const e = ranked?.queueMap?.[q] ?? {};
      return {
        queueType: q,
        tier: e.tier || "",
        division: e.division || "",
        leaguePoints: e.leaguePoints ?? 0,
        wins: e.wins ?? 0,
        losses: e.losses ?? 0,
      };
    }),
    games,
    champions,
    regalia: regaliaOf(regalia, me.summonerLevel),
    backgroundSkinId: profile.backgroundSkinId,
    // Full catalogs. Unowned items are listed for browsing; the set-* actions
    // still refuse them.
    icons: (iconCatalog as any[])
      .map((i) => ({ id: i.id, title: i.title ?? "", owned: icons.has(i.id) }))
      .sort((a, b) => b.id - a.id),
    skins: Object.values(skins as Record<string, any>)
      .map((s) => ({ id: s.id, name: s.name, owned: ownedSkins.has(s.id) }))
      .sort((a, b) => byName(a.name, b.name)),
  };
}

export async function setIcon(client: LcuClient, iconId: number) {
  if (!(await ownedIds(client, "SUMMONER_ICON")).has(iconId)) {
    throw new ActionRefused(`icon ${iconId} is not owned by this account`);
  }
  // The signed inventory token is over 200 KB and the client rejects it with
  // 413; the id alone is accepted (201), and the client checks ownership too.
  return client.put("/lol-summoner/v1/current-summoner/icon", {
    profileIconId: iconId,
  });
}

export async function setRegalia(
  client: LcuClient,
  crestType: string,
  bannerType: string,
  prestigeCrest: number
) {
  if (!CREST_TYPES.includes(crestType)) {
    throw new ActionRefused(`unknown crest type ${crestType}`);
  }
  if (!BANNER_TYPES.includes(bannerType)) {
    throw new ActionRefused(`unknown banner type ${bannerType}`);
  }
  const me = await client.get("/lol-summoner/v1/current-summoner");
  const max = maxPrestigeCrest(me.summonerLevel);
  if (!Number.isInteger(prestigeCrest) || prestigeCrest < 1 || prestigeCrest > max) {
    throw new ActionRefused(`prestige crest must be 1 to ${max} at level ${me.summonerLevel}`);
  }
  return client.put("/lol-regalia/v2/current-summoner/regalia", {
    preferredCrestType: crestType,
    preferredBannerType: bannerType,
    selectedPrestigeCrest: prestigeCrest,
  });
}

const CHALLENGES = "/lol-challenges/v1/challenges/local-player";
const TITLES = "/lol-challenges/v2/titles/local-player";
const CHALLENGE_SUMMARY = "/lol-challenges/v1/summary-player-data/local-player";
const UPDATE_PREFS = "/lol-challenges/v1/update-player-preferences/";

/** Challenges with any earned level; only these can be shown as tokens. */
async function earnedChallenges(client: LcuClient): Promise<any[]> {
  const all: Record<string, any> = await client.get(CHALLENGES);
  return Object.values(all).filter((c) => c.currentLevel && c.currentLevel !== "NONE");
}

export async function loadChallenges(client: LcuClient) {
  const [earned, titles, summary] = await Promise.all([
    earnedChallenges(client),
    client.get(TITLES),
    client.get(CHALLENGE_SUMMARY),
  ]);
  return {
    earned: earned
      .map((c) => ({
        id: c.id as number,
        name: c.name as string,
        level: c.currentLevel as string,
        description: (c.descriptionShort || c.description || "") as string,
        // Client asset path of the token for the earned level.
        icon: (c.levelToIconPath?.[c.currentLevel] ?? "") as string,
      }))
      .sort((a, b) => byName(a.name, b.name)),
    titles: (titles as any[])
      .map((t) => ({ itemId: t.itemId as number, name: t.name as string }))
      .sort((a, b) => byName(a.name, b.name)),
    currentTitle: summary?.title?.itemId ?? -1,
    currentTokens: (summary?.topChallenges ?? []).map((c: any) => c.id as number),
  };
}

/** Shows up to three earned challenges as tokens on the profile. */
export async function setTokens(client: LcuClient, ids: number[]) {
  if (ids.length > TOKEN_LIMIT) throw new ActionRefused(`at most ${TOKEN_LIMIT} tokens`);
  const earned = new Set((await earnedChallenges(client)).map((c) => c.id));
  const bad = ids.filter((id) => !earned.has(id));
  if (bad.length) throw new ActionRefused(`challenge ${bad.join(", ")} has no earned level`);
  return client.post(UPDATE_PREFS, { challengeIds: ids });
}

/**
 * Sets an owned title. The server also checks ownership: an unowned title is
 * answered with "Player does not own ACHIEVEMENT_TITLE". The current tokens are
 * sent with it so they are kept.
 */
export async function setTitle(client: LcuClient, itemId: number) {
  const [titles, summary] = await Promise.all([client.get(TITLES), client.get(CHALLENGE_SUMMARY)]);
  // -1 clears the title; the client takes an empty string for that (204).
  if (itemId !== -1 && !(titles as any[]).some((t) => t.itemId === itemId)) {
    throw new ActionRefused(`title ${itemId} is not owned by this account`);
  }
  return client.post(UPDATE_PREFS, {
    challengeIds: (summary?.topChallenges ?? []).map((c: any) => c.id),
    title: itemId === -1 ? "" : String(itemId),
  });
}

/**
 * The client accepts any skin as the profile background, owned or not (tested
 * live: an unowned skin returned 200 and read back). So this checks only that
 * the skin exists, in its champion's file (tens of KB) rather than the 6 MB
 * skin catalog.
 */
export async function setBackground(client: LcuClient, skinId: number) {
  const skin = Number.isInteger(skinId) ? await findSkin(client, skinId) : undefined;
  if (!skin) {
    throw new ActionRefused(`skin ${skinId} is not a known skin`);
  }
  return client.post("/lol-summoner/v1/current-summoner/summoner-profile", {
    key: "backgroundSkinId",
    value: skinId,
  });
}

/** Where downloads go: ~/Downloads/Rift Explorer. */
const DOWNLOAD_DIR = join(homedir(), "Downloads", "Rift Explorer");

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "").trim();

/**
 * Saves a full-quality image from the client: a profile icon, or a skin's
 * splash art. Returns the saved file path.
 */
export async function downloadAsset(
  client: LcuClient,
  kind: string,
  id: number,
  dir = DOWNLOAD_DIR
): Promise<{ path: string }> {
  if (!Number.isInteger(id) || id < 0) throw new ActionRefused(`invalid id ${id}`);
  let asset: string;
  let name: string;
  if (kind === "icon") {
    asset = `/lol-game-data/assets/v1/profile-icons/${id}.jpg`;
    name = `Icon ${id}.jpg`;
  } else if (kind === "skin") {
    const skin = await findSkin(client, id);
    if (!skin) throw new ActionRefused(`skin ${id} is not a known skin`);
    // The uncentered splash is the full artwork; the centered one is cropped.
    asset = skin.uncenteredSplashPath || skin.splashPath;
    name = `${safeName(skin.name)} (${id}).jpg`;
  } else {
    throw new ActionRefused(`unknown download kind ${kind}`);
  }
  const bytes = await client.getBytes(asset);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return { path };
}

const GRANTS = "/lol-rewards/v1/grants";

/** A group name the client has not localized yet; the item names say more. */
const isPlaceholder = (t?: string) => !t || /placeholder|do not translate/i.test(t);

/** Rewards granted to the account and waiting to be claimed. */
export async function loadRewards(client: LcuClient) {
  const grants: any[] = await client.get(GRANTS);
  return grants
    .filter((g) => g.info?.status === "PENDING_SELECTION")
    .map((g) => {
      const group = g.rewardGroup ?? {};
      const items = (group.rewards ?? []).map((r: any) => ({
        id: r.id as string,
        name: (r.localizations?.title || r.itemType || "Reward") as string,
        details: (r.localizations?.details ?? "") as string,
        quantity: (r.quantity ?? 1) as number,
        icon: (r.media?.iconUrl ?? "") as string,
      }));
      const title = group.localizations?.title;
      return {
        grantId: g.info.id as string,
        rewardGroupId: g.info.rewardGroupId as string,
        date: (g.info.dateCreated ?? "") as string,
        title: isPlaceholder(title) ? items.map((i: any) => i.name).join(" + ") : (title as string),
        items,
        min: group.selectionStrategyConfig?.minSelectionsAllowed ?? items.length,
        max: group.selectionStrategyConfig?.maxSelectionsAllowed ?? items.length,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** A reward waiting to be claimed, as loadRewards returns it. */
export interface PendingReward {
  grantId: string;
  rewardGroupId: string;
  date: string;
  title: string;
  items: { id: string; name: string; details: string; quantity: number; icon: string }[];
  min: number;
  max: number;
}

/** True when every item must be taken, so claiming makes no choice. */
const isForced = (g: PendingReward) => g.min === g.items.length && g.max === g.items.length;

function select(client: LcuClient, g: PendingReward) {
  return client.post(`${GRANTS}/${g.grantId}/select`, {
    grantId: g.grantId,
    rewardGroupId: g.rewardGroupId,
    selections: g.items.map((i) => i.id),
  });
}

/**
 * Claims a pending grant, like the client's own claim button. Only grants with
 * no real choice (every item must be taken) are claimed; a grant that asks the
 * player to choose is refused rather than choosing for them.
 */
export async function claimReward(client: LcuClient, grantId: string) {
  const grant = (await loadRewards(client)).find((g) => g.grantId === grantId);
  if (!grant) throw new ActionRefused(`no unclaimed reward ${grantId}`);
  if (!isForced(grant)) {
    throw new ActionRefused("this reward asks you to choose; claim it in the client");
  }
  return select(client, grant);
}

/** What claimAllRewards reports back. */
export interface ClaimAllResult {
  claimed: string[];
  skipped: string[];
  failed: { grantId: string; error: string }[];
}

/**
 * Claims every pending reward that needs no choice, one at a time, and keeps
 * going if one fails. Rewards that ask for a choice are skipped.
 */
export async function claimAllRewards(client: LcuClient): Promise<ClaimAllResult> {
  const claimed: string[] = [];
  const skipped: string[] = [];
  const failed: { grantId: string; error: string }[] = [];
  for (const g of await loadRewards(client)) {
    if (!isForced(g)) {
      skipped.push(g.grantId);
      continue;
    }
    try {
      await select(client, g);
      claimed.push(g.grantId);
    } catch (err: any) {
      failed.push({ grantId: g.grantId, error: err?.response?.data?.message ?? String(err?.message ?? err) });
    }
  }
  return { claimed, skipped, failed };
}

const MATERIAL_NAMES: Record<string, string> = {
  MATERIAL_key: "Hextech Key",
  MATERIAL_key_fragment: "Key Fragment",
  MATERIAL_clashtickets: "Clash Ticket",
};

const LOOT_KIND: Record<string, "champion" | "skin" | "ward"> = {
  CHAMPION: "champion",
  CHAMPION_RENTAL: "champion",
  SKIN_RENTAL: "skin",
  WARDSKIN_RENTAL: "ward",
};

/** Wallet balances and every loot item with what it is worth. Read-only. */
export async function loadLoot(client: LcuClient) {
  const [wallet, loot] = await Promise.all([
    client.get(
      "/lol-inventory/v1/wallet?currencyTypes=%5B%22RP%22%2C%22lol_blue_essence%22%2C%22lol_orange_essence%22%5D"
    ),
    client.get("/lol-loot/v1/player-loot") as Promise<any[]>,
  ]);
  return {
    wallet: {
      rp: wallet.RP ?? 0,
      be: wallet.lol_blue_essence ?? 0,
      oe: wallet.lol_orange_essence ?? 0,
    },
    items: loot
      .filter((l) => l.lootId && l.type !== "CURRENCY")
      .map((l) => ({
        id: l.lootId as string,
        name: (l.itemDesc || l.localizedName || MATERIAL_NAMES[l.lootId] || l.lootId) as string,
        kind: (LOOT_KIND[l.type] ?? "material") as "champion" | "skin" | "ward" | "material",
        count: l.count as number,
        /** Essence per item when disenchanted. */
        disenchant: (l.disenchantValue ?? 0) as number,
        currency: (l.disenchantLootName === "CURRENCY_champion" ? "BE" : "OE") as "BE" | "OE",
        /** Orange essence needed to unlock the item from the shard (0 if not upgradable). */
        upgrade: (l.upgradeEssenceValue ?? 0) as number,
        /** The account already owns what this shard unlocks. */
        owned: l.itemStatus === "OWNED",
        tile: (l.tilePath ?? "") as string,
      })),
  };
}

const PAGES = "/lol-perks/v1/pages";
const RUNE_PAGE_ITEM = "inventoryType=SPELL_BOOK_PAGE&itemId=1";

/** Rune pages with names for every rune, plus what buying one more page costs. */
export async function loadRunes(client: LcuClient) {
  const [pages, perks, styles, inventory, store, purchasable] = await Promise.all([
    client.get(PAGES) as Promise<any[]>,
    client.get("/lol-perks/v1/perks") as Promise<any[]>,
    client.get("/lol-perks/v1/styles") as Promise<any[]>,
    client.get("/lol-perks/v1/inventory"),
    client.get("/lol-store/v1/catalog?inventoryType=%5B%22SPELL_BOOK_PAGE%22%5D").catch(() => []),
    client.get(`/lol-purchase-widget/v1/purchasable-item?${RUNE_PAGE_ITEM}`).catch(() => null),
  ]);
  return {
    pages: pages.map((p) => ({
      id: p.id as number,
      name: p.name as string,
      current: Boolean(p.current),
      editable: Boolean(p.isEditable),
      primaryStyleId: p.primaryStyleId as number,
      subStyleId: p.subStyleId as number,
      selectedPerkIds: p.selectedPerkIds as number[],
    })),
    perks: Object.fromEntries(
      perks.map((p) => [p.id, { name: p.name as string, icon: p.iconPath as string, desc: (p.shortDesc ?? "") as string }])
    ),
    styles: stylesById(styles),
    ownedPages: inventory.ownedPageCount as number,
    canAddPage: Boolean(inventory.canAddCustomPage),
    buy: {
      /** Store list prices; IP is blue essence. */
      prices: ((store as any[])[0]?.prices ?? []).map((p: any) => ({ currency: p.currency as string, cost: p.cost as number })),
      /** Currencies the client will accept right now; empty when it refuses the purchase. */
      options: purchaseOptions(purchasable).map((o) => o.price.currencyType as string),
      blockedBy: ((purchasable?.validationErrors ?? []) as any[]).map((e) => e.id as string),
    },
  };
}

function purchaseOptions(purchasable: any): any[] {
  return ((purchasable?.purchaseOptions ?? []) as any[]).flatMap((o) => o.priceDetails ?? []);
}

/**
 * Buys one more rune page with the given currency ("IP" is blue essence, or
 * "RP"), using the exact price the client's purchase widget offers. Refused
 * when the client offers no purchase, for example when the page limit is reached.
 */
export async function buyRunePage(client: LcuClient, currency: string) {
  const purchasable = await client.get(`/lol-purchase-widget/v1/purchasable-item?${RUNE_PAGE_ITEM}`);
  const option = purchaseOptions(purchasable).find((o) => o.price?.currencyType === currency);
  if (!option) {
    const why = ((purchasable?.validationErrors ?? []) as any[]).map((e) => e.id).join(", ");
    throw new ActionRefused(`the store offers no rune page for ${currency}${why ? ` (${why})` : ""}`);
  }
  return client.post("/lol-purchase-widget/v2/purchaseItems", {
    items: [{ itemKey: option.itemKey, quantity: 1, source: "cdp", purchaseCurrencyInfo: option.price }],
  });
}

export interface StyleInfo {
  name: string;
  icon: string;
  allowedSubStyles: number[];
  defaultSubStyle: number;
  keystones: number[];
  /** The three regular rune rows. */
  rows: number[][];
  /** The three stat shard rows. */
  shards: number[][];
}

/** Style details keyed by id. */
function stylesById(styles: any[]) {
  return Object.fromEntries(styles.map((s) => [s.id, styleInfo(s)]));
}

function styleInfo(s: any): StyleInfo {
  const slots = (type: string) => (s.slots as any[]).filter((x) => x.type === type).map((x) => x.perks as number[]);
  return {
    name: s.name,
    icon: s.iconPath,
    allowedSubStyles: s.allowedSubStyles ?? [],
    defaultSubStyle: s.defaultSubStyle,
    keystones: slots("kKeyStone")[0] ?? [],
    rows: slots("kMixedRegularSplashable"),
    shards: slots("kStatMod"),
  };
}

/**
 * Checks a page against the client's rules. `perks` is in the client's order:
 * keystone, one rune per primary row (3), two runes from different secondary
 * rows, then one shard per stat row (3). Returns a reason, or null when valid.
 */
export function runePageProblem(
  styles: Record<number, StyleInfo>,
  primary: number,
  sub: number,
  perks: number[]
): string | null {
  const P = styles[primary];
  const S = styles[sub];
  if (!P) return `unknown primary tree ${primary}`;
  if (!S || sub === primary || !P.allowedSubStyles.includes(sub)) return `tree ${sub} cannot be the secondary tree`;
  if (perks.length !== 9 || perks.some((x) => !Number.isInteger(x))) return "a page needs exactly 9 runes";
  const [key, a, b, c, s1, s2, m1, m2, m3] = perks;
  if (!P.keystones.includes(key)) return "the keystone must come from the primary tree";
  if ([a, b, c].some((x, i) => !P.rows[i]?.includes(x))) return "pick one rune from each primary row";
  const rowOf = (x: number) => S.rows.findIndex((r) => r.includes(x));
  const r1 = rowOf(s1);
  const r2 = rowOf(s2);
  if (r1 < 0 || r2 < 0 || r1 === r2) return "pick two secondary runes from different rows";
  if ([m1, m2, m3].some((x, i) => !P.shards[i]?.includes(x))) return "pick one stat shard from each row";
  return null;
}

/** Decodes text sent as "n" + UTF-8 hex (keeps the command to plain words). */
export function decodeName(arg: string, max = 50, trim = true): string {
  if (!/^n([0-9a-f]{2})*$/.test(arg)) throw new ActionRefused("invalid text encoding");
  const bytes = arg.slice(1).match(/../g)?.map((h) => parseInt(h, 16)) ?? [];
  const text = new TextDecoder().decode(new Uint8Array(bytes));
  // Status text is kept exactly, so blank rows and spacing survive.
  return (trim ? text.trim() : text).slice(0, max);
}

/** Renames a page and sets its runes, after checking them against the client's rules. */
export async function editRunePage(
  client: LcuClient,
  pageId: number,
  nameArg: string,
  primary: number,
  sub: number,
  perks: number[]
) {
  const name = decodeName(nameArg);
  const [pages, styles] = await Promise.all([
    client.get(PAGES) as Promise<any[]>,
    client.get("/lol-perks/v1/styles") as Promise<any[]>,
  ]);
  const target = pages.find((p) => p.id === pageId);
  if (!target?.isEditable) throw new ActionRefused(`page ${pageId} is not one of your editable pages`);
  const problem = runePageProblem(stylesById(styles), primary, sub, perks);
  if (problem) throw new ActionRefused(problem);
  return client.put(`${PAGES}/${pageId}`, {
    name,
    primaryStyleId: primary,
    subStyleId: sub,
    selectedPerkIds: perks,
    current: target.current,
  });
}

export interface AutoConfig {
  accept: boolean;
  /** Lock in the chosen pick or ban instead of only hovering it. */
  lock: boolean;
  /** Champion ids to ban, in order of preference. */
  bans: number[];
  /** Champion ids to pick, in order of preference. */
  picks: number[];
}

/** Parses `<accept 0|1> <lock 0|1> <bans a-b-c|none> <picks a-b-c|none>`. */
export function parseAutoArgs(args: string[]): AutoConfig {
  const flag = (a?: string) => {
    if (a !== "0" && a !== "1") throw new ActionRefused("auto-tick flags must be 0 or 1");
    return a === "1";
  };
  const ids = (a?: string) => {
    if (a === "none") return [];
    if (!a || !/^[0-9]+(-[0-9]+)*$/.test(a)) throw new ActionRefused("champion lists look like 1-2-3 or none");
    return a.split("-").map(Number);
  };
  return { accept: flag(args[0]), lock: flag(args[1]), bans: ids(args[2]), picks: ids(args[3]) };
}

/** A tick that did nothing; it reports only the phase. */
const idle = (phase: string) => ({ phase, did: null });

/** What autoTick reports: the phase, and what it did (null when nothing). */
export interface AutoTickResult {
  phase: string;
  did: string | null;
  championId?: number;
}

/**
 * One step of auto-accept / auto-ban / auto-pick. The app calls this every
 * couple of seconds while auto mode is on; each call does at most one thing.
 * It never overrides a champion you hovered yourself.
 */
export async function autoTick(client: LcuClient, cfg: AutoConfig): Promise<AutoTickResult> {
  const phase: string = await client.get("/lol-gameflow/v1/gameflow-phase");

  if (phase === "ReadyCheck") {
    if (!cfg.accept) return idle(phase);
    const check = await client.get("/lol-matchmaking/v1/ready-check");
    if (check?.state !== "InProgress" || check?.playerResponse !== "None") return idle(phase);
    await client.post("/lol-matchmaking/v1/ready-check/accept", {});
    return { phase, did: "accepted the match" };
  }

  if (phase !== "ChampSelect") return idle(phase);
  const session = await client.get("/lol-champ-select/v1/session");
  const me = session.localPlayerCellId;
  const actions: any[] = (session.actions ?? []).flat();
  const mine = actions.find(
    (a) => a.actorCellId === me && a.isInProgress && !a.completed && (a.type === "ban" || a.type === "pick")
  );
  if (!mine) return idle(phase);

  const wanted = mine.type === "ban" ? cfg.bans : cfg.picks;
  if (!wanted.length) return idle(phase);
  // Something you hovered yourself is left alone.
  if (mine.championId && !wanted.includes(mine.championId)) return idle(phase);

  const taken = new Set<number>([
    ...actions.filter((a) => a.completed).map((a) => a.championId as number),
    ...(session.bans?.myTeamBans ?? []),
    ...(session.bans?.theirTeamBans ?? []),
    // Teammates' hovers, so you do not take a champion they plan to play.
    ...(session.myTeam ?? [])
      .filter((p: any) => p.cellId !== me)
      .flatMap((p: any) => [p.championId, p.championPickIntent]),
  ]);
  // The allowed list is only needed when nothing is hovered yet.
  const allowed = mine.championId
    ? new Set<number>()
    : new Set<number>(
        await client.get(
          mine.type === "ban" ? "/lol-champ-select/v1/bannable-champion-ids" : "/lol-champ-select/v1/pickable-champion-ids"
        )
      );
  const choice = mine.championId || wanted.find((id) => allowed.has(id) && !taken.has(id));
  if (!choice) return idle(phase);
  if (choice === mine.championId && !cfg.lock) return idle(phase);

  await client.patch(`/lol-champ-select/v1/session/actions/${mine.id}`, {
    championId: choice,
    completed: cfg.lock,
  });
  const verb = mine.type === "ban" ? (cfg.lock ? "banned" : "hovered ban") : cfg.lock ? "locked in" : "hovered";
  return { phase, did: `${verb} ${choice}`, championId: choice };
}
