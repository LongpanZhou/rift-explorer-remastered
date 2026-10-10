/**
 * Rune pages for the phone. The phone reads and edits the same pages as the desktop rune
 * editor, under the same rules (player.ts). Rune icons come from CommunityDragon, the same
 * mirror the desktop uses for client art, and only for Riot's game-data paths.
 */
import { ActionRefused, editRunePage, PAGES, PERKS, runePage, STYLES, styleInfo, type LcuClient } from "./player";
import { iconBytes, liveFetch, type Fetcher } from "./phoneIcons";
import { encodeText } from "./text";

/** The rune pages, the five trees, the stat shards, and a name and icon for every rune id used. */
export async function runeData(client: LcuClient) {
  const [pages, perks, styles] = await Promise.all([
    client.get(PAGES) as Promise<any[]>,
    client.get(PERKS) as Promise<any[]>,
    client.get(STYLES) as Promise<any[]>,
  ]);
  const perkNames = new Map<number, string>(perks.map((p): [number, string] => [p.id, p.name]));
  const names: Record<string, { name: string; icon: string }> = {};
  const label = (id: number, name?: string) => {
    names[id] = { name: name ?? perkNames.get(id) ?? `#${id}`, icon: `/icon/rune/${id}.png` };
  };

  const infos = styles.map((s) => ({ id: s.id as number, info: styleInfo(s) }));
  const trees = infos.map(({ id, info }) => {
    label(id, info.name);
    [...info.keystones, ...info.rows.flat()].forEach((x) => label(x));
    return { id, name: info.name, keystones: info.keystones, rows: info.rows };
  });
  // The desktop checks each page's shards against its primary tree. This takes the shards of the
  // first tree that lists them, so it assumes every tree offers the same ones.
  const shards = infos.map((x) => x.info.shards).find((rows) => rows.length > 0) ?? [];
  shards.flat().forEach((x) => label(x));

  const pageList = pages.map(runePage);
  pageList.flatMap((p) => p.selectedPerkIds).forEach((x) => label(x));
  return { pages: pageList, trees, shards, names };
}

/**
 * Saves a rune page sent by the phone. The page must be one of your editable pages, and the
 * trees and runes are checked as the desktop editor checks them. The current flag is kept.
 */
export async function saveRunePage(client: LcuClient, body: any) {
  const { id, name, primaryStyleId, subStyleId, perks } = body;
  if (typeof name !== "string") throw new ActionRefused("a rune page needs a name");
  if (!Array.isArray(perks)) throw new ActionRefused("a page needs exactly 9 runes");
  await editRunePage(client, id, encodeText(name), primaryStyleId, subStyleId, perks);
  return { ok: true };
}

const ASSETS = "/lol-game-data/assets/";
const COMMUNITY_DRAGON = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/";
const PATHS_MS = 10 * 60_000;
let paths: { at: number; byId: Map<number, string> } | null = null;

/** Forgets the cached icon paths (used by tests). */
export function resetRuneIconCache() {
  paths = null;
}

/** The client's icon path for each perk and style id, cached for ten minutes. */
async function iconPaths(client: LcuClient): Promise<Map<number, string>> {
  if (paths && Date.now() - paths.at < PATHS_MS) return paths.byId;
  const [perks, styles] = await Promise.all([client.get(PERKS) as Promise<any[]>, client.get(STYLES) as Promise<any[]>]);
  const byId = new Map<number, string>();
  for (const x of [...perks, ...styles]) byId.set(x.id, x.iconPath);
  paths = { at: Date.now(), byId };
  return byId;
}

/** The CommunityDragon URL for a client asset path, or null unless it is a plain .png under the game data. */
function iconUrl(clientPath: unknown): string | null {
  if (typeof clientPath !== "string") return null;
  const lower = clientPath.toLowerCase();
  if (!lower.startsWith(ASSETS) || !lower.endsWith(".png") || lower.includes("..")) return null;
  if (!/^[a-z0-9_./-]+$/.test(lower)) return null;
  return COMMUNITY_DRAGON + lower.slice(ASSETS.length);
}

/**
 * The PNG for a rune, shard or tree id, or null when the id has no icon or its path is not one
 * this maps. A failing client call or CDN request is thrown.
 */
export async function runeIcon(client: LcuClient, id: number, fetchFn: Fetcher = liveFetch): Promise<ArrayBuffer | null> {
  const url = iconUrl((await iconPaths(client)).get(id));
  return url ? iconBytes(url, fetchFn) : null;
}
