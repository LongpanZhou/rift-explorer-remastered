/**
 * Champion and spell icons for the phone page. The Mac fetches them from Data Dragon and keeps
 * them in memory, so the phone never needs the internet. Only names that pass the checks here
 * are fetched, so the Mac never proxies an arbitrary URL.
 */

/** Fetches one URL. The default uses the network; tests pass a stub. */
export type Fetcher = (url: string) => Promise<Response>;

interface SummonerSpell {
  /** The id the client uses for the spell. */
  id: number;
  name: string;
  /** Data Dragon image file, for example "SummonerFlash.png". */
  file: string;
}

const DATA_DRAGON = "https://ddragon.leagueoflegends.com";
const DAY_MS = 24 * 60 * 60_000;
/** The network fetch. A stalled Data Dragon gives up after ten seconds, so the phone poll is not held up. */
export const liveFetch: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) });

let version: { at: number; value: string } | null = null;
let spellCache: { at: number; list: SummonerSpell[] } | null = null;
const icons = new Map<string, ArrayBuffer>();

/** Forgets the cached version, spells and icons (used by tests). */
export function resetIconCache() {
  version = null;
  spellCache = null;
  icons.clear();
}

async function getJson(url: string, fetchFn: Fetcher): Promise<any> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** The newest Data Dragon version, cached for a day. */
async function latestVersion(fetchFn: Fetcher): Promise<string> {
  if (version && Date.now() - version.at < DAY_MS) return version.value;
  const list = await getJson(`${DATA_DRAGON}/api/versions.json`, fetchFn);
  const value: unknown = list[0];
  if (typeof value !== "string") throw new Error("Data Dragon sent no version");
  version = { at: Date.now(), value };
  return value;
}

/** The bytes of one upstream icon. Each icon is fetched once and then kept. */
export async function iconBytes(url: string, fetchFn: Fetcher): Promise<ArrayBuffer> {
  const kept = icons.get(url);
  if (kept) return kept;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const bytes = await res.arrayBuffer();
  icons.set(url, bytes);
  return bytes;
}

/** A champion's square icon by alias, for example "MonkeyKing". Null when the alias is not a plain name. */
export async function championIcon(alias: string, fetchFn: Fetcher = liveFetch): Promise<ArrayBuffer | null> {
  if (!/^[A-Za-z0-9]+$/.test(alias)) return null;
  const v = await latestVersion(fetchFn);
  return iconBytes(`${DATA_DRAGON}/cdn/${v}/img/champion/${alias}.png`, fetchFn);
}

/** A summoner spell's icon by its image file. Null when the name is not a plain spell file. Underscores are allowed (some spell files use them). */
export async function spellIcon(file: string, fetchFn: Fetcher = liveFetch): Promise<ArrayBuffer | null> {
  if (!/^Summoner[A-Za-z0-9_]+\.png$/.test(file)) return null;
  const v = await latestVersion(fetchFn);
  return iconBytes(`${DATA_DRAGON}/cdn/${v}/img/spell/${file}`, fetchFn);
}

/** The Summoner's Rift spells (the classic queue), cached for a day. ARAM, URF and other modes' spells are left out. */
export async function summonerSpells(fetchFn: Fetcher = liveFetch): Promise<SummonerSpell[]> {
  if (spellCache && Date.now() - spellCache.at < DAY_MS) return spellCache.list;
  const v = await latestVersion(fetchFn);
  const body = await getJson(`${DATA_DRAGON}/cdn/${v}/data/en_US/summoner.json`, fetchFn);
  // The client's spell id is the entry's key, which Data Dragon stores as a string. Its id field is the name.
  // Each entry lists the game modes it works in; "CLASSIC" is Summoner's Rift.
  const list = Object.values(body.data as Record<string, any>)
    .filter((s) => s.modes.includes("CLASSIC"))
    .map((s) => ({
      id: Number(s.key),
      name: s.name as string,
      file: s.image.full as string,
    }));
  spellCache = { at: Date.now(), list };
  return list;
}
