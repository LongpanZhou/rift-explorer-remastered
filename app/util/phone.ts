/**
 * The phone champ select page. It runs on this computer, on the local network only: a phone on
 * the same Wi-Fi can open it, and nothing goes through the internet.
 */
import { ActionRefused, awaitingAnswer, lcuClient, openAction, PAGES, takenBy, type LcuClient } from "./player";
import type { LockFile } from "./LockFileParser";
import PHONE_HTML from "./phone-page.html" with { type: "text" };
import { championIcon, skinArt, spellIcon, summonerSpellsSoon, type Fetcher } from "./phoneIcons";
import { runeData, runeIcon, saveRunePage } from "./phoneRunes";

/** The page's text. Bun's own types read an .html import as a bundle; `type: "text"` makes it a string. */
const PHONE_PAGE = PHONE_HTML as unknown as string;

const GAMEFLOW = "/lol-gameflow/v1/gameflow-phase";
const READY_CHECK = "/lol-matchmaking/v1/ready-check";
const MY_SELECTION = "/lol-champ-select/v1/session/my-selection";
const SKIN_INFO = "/lol-champ-select/v1/skin-selector-info";
const SKIN_CAROUSEL = "/lol-champ-select/v1/skin-carousel-skins";
/** The two swaps a teammate can be asked for. Each list holds { id, cellId, state } per teammate. */
const SWAP_PATHS = {
  champion: "/lol-champ-select/v1/session/champion-swaps",
  "pick-order": "/lol-champ-select/v1/session/pick-order-swaps",
} as const;
type SwapKind = keyof typeof SWAP_PATHS;
// The client's quit call, which leaves champ select (a dodge). It is not in the client's REST
// list under champ select; tools use this login service call. Not yet tested in a live game.
const DODGE =
  "/lol-login/v1/session/invoke?destination=lcdsServiceProxy&method=call&args=" +
  encodeURIComponent(JSON.stringify(["", "teambuilder-draft", "quitV2", ""]));

/**
 * The champions you may choose for a pick or a ban, as ids. The client's pickable or bannable
 * list can hold only its placeholder (-1, "None"); then the champion grid the client draws is
 * used: champions that are not disabled and, for a pick, that you own or may play for free.
 */
async function choosable(client: LcuClient, type: string): Promise<number[]> {
  const path = type === "ban" ? "/lol-champ-select/v1/bannable-champion-ids" : "/lol-champ-select/v1/pickable-champion-ids";
  const ids = ((await client.get(path).catch(() => [])) as unknown[]).filter(isSpellOrChamp);
  if (ids.length) return ids;
  const grid: any[] = await client.get("/lol-champ-select/v1/all-grid-champions").catch(() => []);
  return grid
    .filter((c) => isSpellOrChamp(c?.id) && !c.disabled && (type === "ban" || c.owned || c.freeToPlay || c.rented || c.freeToPlayForQueue))
    .map((c) => c.id as number);
}

/** Your pick that has not started yet, if you have one. */
const upcomingPick = (actions: any[], me: number) =>
  actions.find((a) => a.actorCellId === me && a.type === "pick" && !a.completed && !a.isInProgress);

export interface PhoneDeps {
  client: LcuClient;
  /** Fetches Data Dragon files. Defaults to the network; tests pass a stub. */
  fetch?: Fetcher;
}

// The state changes every second in champ select: no browser may keep an old copy.
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

const isSpellOrChamp = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

interface ChampionInfo {
  name: string;
  alias: string;
  roles: string[];
}

let champions: { at: number; map: Map<number, ChampionInfo> } = { at: 0, map: new Map() };
/** Forgets the champion names, so a test reads its own list. */
export function resetChampionCache() {
  champions = { at: 0, map: new Map() };
}
async function championInfo(client: LcuClient): Promise<Map<number, ChampionInfo>> {
  if (Date.now() - champions.at > 10 * 60_000) {
    const list: { id: number; name: string; alias: string; roles?: string[] }[] = await client.get("/lol-game-data/assets/v1/champion-summary.json");
    champions = {
      at: Date.now(),
      map: new Map<number, ChampionInfo>(list.map((c) => [c.id, { name: c.name, alias: c.alias, roles: c.roles ?? [] }])),
    };
  }
  return champions.map;
}

/** The client's position names, as the phone shows them. */
const POSITIONS = new Map([
  ["top", "TOP"],
  ["jungle", "JGL"],
  ["middle", "MID"],
  ["bottom", "BOT"],
  ["utility", "SUP"],
]);

const DISALLOWED = "/lol-gameflow/v1/session/per-position-summoner-spells/disallowed";
const idsIn = (x: unknown): number[] => (Array.isArray(x) ? x.filter((n): n is number => typeof n === "number") : []);

/**
 * Spell ids your position may not use. The response shape is NOT confirmed: an array of ids,
 * or an object keyed by position, are both read. Check it in a live champ select.
 * Any error means no spell is refused here.
 */
async function disallowedSpells(client: LcuClient, session: any): Promise<number[]> {
  try {
    const list = await client.get(DISALLOWED);
    if (Array.isArray(list)) return idsIn(list);
    if (!list || typeof list !== "object") return [];
    const me = (session.myTeam ?? []).find((p: any) => p.cellId === session.localPlayerCellId);
    const position = String(me?.assignedPosition ?? "").toLowerCase();
    const key = Object.keys(list).find((k) => k.toLowerCase() === position);
    return key ? idsIn(list[key]) : [];
  } catch {
    return [];
  }
}

/** The current rune page, or null when the client gives no pages. */
function runeState(pages: any[] | null) {
  if (!pages) return null;
  const current = pages.find((p) => p.current);
  return { current: current ? { id: current.id as number, name: current.name as string } : null };
}

/**
 * The skins for your champion: whether you may change the one you wear now, which one you wear,
 * and the skins the client offers. The skin list is read only while the selector is open. A skin
 * with no ownership data counts as owned; the client refuses the rest.
 */
async function skinOffers(client: LcuClient) {
  const info = await client.get(SKIN_INFO).catch(() => null);
  const open = Boolean(info?.showSkinSelector);
  const carousel: any[] = open ? await client.get(SKIN_CAROUSEL).catch(() => []) : [];
  return {
    available: open && !info?.skinSelectionDisabled,
    selected: (info?.selectedSkinId ?? 0) as number,
    options: carousel
      .filter((s) => !s.disabled)
      .map((s) => ({ id: s.id as number, name: s.name as string, owned: s.ownership?.owned !== false })),
  };
}

const seconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The queue and a found match, for the phone outside champ select. Null where the client has none. */
async function queueState(client: LcuClient, phase: string) {
  // The search is read only while one can exist; the client answers 404 otherwise, which reads as null.
  const [search, check] = await Promise.all([
    phase === "Matchmaking" ? client.get("/lol-matchmaking/v1/search").catch(() => null) : null,
    phase === "ReadyCheck" ? client.get(READY_CHECK).catch(() => null) : null,
  ]);
  return {
    search: search
      ? { searching: search.searchState === "Searching", timeInQueue: seconds(search.timeInQueue) ?? 0, estimatedQueueTime: seconds(search.estimatedQueueTime) }
      : null,
    readyCheck: check ? { response: (check.playerResponse as string) ?? "None", secondsLeft: seconds(check.timer) } : null,
  };
}

/** Everything the phone shows. In champ select it is the champion select; elsewhere the queue or a found match. */
export async function phoneState(client: LcuClient, fetchFn?: Fetcher) {
  const phase: string = await client.get(GAMEFLOW);
  if (phase !== "ChampSelect") {
    const [queue, lobby] = await Promise.all([queueState(client, phase), phase === "Lobby" ? lobbyState(client) : null]);
    // On the home screen, the modes a new lobby can be opened in.
    const createModes = phase === "None" ? await modeOptions(client).catch(() => []) : [];
    return { phase, inChampSelect: false, ...queue, lobby, createModes };
  }

  const [session, info] = await Promise.all([
    client.get("/lol-champ-select/v1/session"),
    championInfo(client),
  ]);
  const me = session.localPlayerCellId;
  const actions: any[] = (session.actions ?? []).flat();
  const turn = actions.find((a) => a.actorCellId === me && openAction(a));
  // Before your turn, the champion on your coming pick is your pre-pick, which your team sees.
  const plan = turn ? undefined : upcomingPick(actions, me);
  const live = actions.find(openAction);
  const lockedIn = (cellId: number) => actions.some((a) => a.actorCellId === cellId && a.type === "pick" && a.completed);
  const mine = (session.myTeam ?? []).find((p: any) => p.cellId === me);
  // On your turn the hover is the action's champion, or the pre-pick if the client did not carry it over.
  const hover: number = turn ? turn.championId || (turn.type === "pick" ? mine?.championPickIntent || 0 : 0) : 0;
  // Banned, locked and teammates' champions cannot be chosen, so they are not offered.
  const taken = takenBy(session, actions, me);
  const named = (id: number) => ({
    name: id ? (info.get(id)?.name ?? `#${id}`) : "",
    alias: info.get(id)?.alias ?? "",
  });
  // The client writes -1 ("None") for a skipped ban or an empty pick; only real champions are shown.
  const real = (id: unknown) => (isSpellOrChamp(id) ? id : 0);
  const champs = (ids: number[] | undefined) => (ids ?? []).filter(isSpellOrChamp).map((id) => ({ id, ...named(id) }));

  const [options, selection, champSwaps, orderSwaps, pages, allSpells, banned, skins] = await Promise.all([
    turn || plan ? choosable(client, turn?.type ?? "pick") : [],
    client.get(MY_SELECTION).catch(() => null),
    // Champions are swapped only after you lock in, pick order only before: read just that list.
    lockedIn(me) ? client.get(SWAP_PATHS.champion).catch(() => []) : [],
    lockedIn(me) ? [] : client.get(SWAP_PATHS["pick-order"]).catch(() => []),
    client.get(PAGES).catch(() => null),
    // From Data Dragon on the internet: never allowed to hold up an update.
    summonerSpellsSoon(fetchFn),
    disallowedSpells(client, session),
    skinOffers(client),
  ]);

  const lists: Record<SwapKind, any[]> = {
    champion: Array.isArray(champSwaps) ? champSwaps : [],
    "pick-order": Array.isArray(orderSwaps) ? orderSwaps : [],
  };
  // The swap of one kind with a teammate, by the client's swap id: requests go to that id, not
  // the cell. Only a swap you can ask for (AVAILABLE) or have asked for (SENT).
  const swapWith = (kind: SwapKind, cellId: number) => {
    const x = cellId === me ? undefined : lists[kind].find((w) => w.cellId === cellId && isSpellOrChamp(w.id));
    return x && (x.state === "AVAILABLE" || x.state === "SENT") ? { id: x.id as number, state: x.state as string } : null;
  };
  const position = (p: any) => POSITIONS.get(p?.assignedPosition) ?? "";
  // The client can keep listing a swap as AVAILABLE when it no longer makes sense, so the game's
  // rules decide: pick order only while both of you still have to pick, champions only once both
  // of you have locked in.
  const swapMakesSense = (kind: SwapKind, cellId: number) =>
    kind === "pick-order" ? !lockedIn(me) && !lockedIn(cellId) : lockedIn(me) && lockedIn(cellId);

  return {
    phase,
    inChampSelect: true,
    timer: {
      leftMs: typeof session.timer?.adjustedTimeLeftInPhase === "number" && !session.timer.isInfinite ? session.timer.adjustedTimeLeftInPhase : null,
      phase: live ? live.type : "",
      // The client's own phase: PLANNING, BAN_PICK, FINALIZATION or GAME_STARTING.
      stage: typeof session.timer?.phase === "string" ? session.timer.phase : "",
    },
    // False in modes where you make no pick here, such as ARAM.
    hasPicks: actions.some((a) => a.actorCellId === me && (a.type === "pick" || a.type === "ban")),
    // True once your pick is locked in.
    lockedIn: lockedIn(me),
    turn: turn ? { championId: hover, type: turn.type as string } : null,
    plan: plan ? { championId: (plan.championId as number) || 0 } : null,
    options: (options as number[])
      .filter((id) => !taken.has(id))
      .map((id) => ({ id, ...named(id), roles: info.get(id)?.roles ?? [] })),
    team: (session.myTeam ?? []).map((p: any) => {
      const championId: number = real(p.championId) || real(p.championPickIntent);
      const locked = lockedIn(p.cellId);
      return {
        cellId: p.cellId as number,
        mine: p.cellId === me,
        championId,
        ...named(championId),
        position: position(p),
        spells: typeof p.spell1Id === "number" && typeof p.spell2Id === "number" ? { spell1: p.spell1Id, spell2: p.spell2Id } : null,
        locked,
        hovering: !locked && championId !== 0,
        swap: swapMakesSense("champion", p.cellId) ? swapWith("champion", p.cellId) : null,
        orderSwap: swapMakesSense("pick-order", p.cellId) ? swapWith("pick-order", p.cellId) : null,
      };
    }),
    bans: {
      mine: champs(session.bans?.myTeamBans),
      theirs: champs(session.bans?.theirTeamBans),
    },
    // The client can leave an enemy's championId at 0 after they lock in; their completed
    // pick action always carries the champion, so it is read first.
    enemies: (session.theirTeam ?? []).map((p: any) => {
      const pick = actions.find((a) => a.actorCellId === p.cellId && a.type === "pick" && a.completed && a.championId);
      const championId: number = real(pick?.championId) || real(p.championId);
      return { cellId: p.cellId as number, championId, ...named(championId) };
    }),
    spells: selection ? { spell1: selection.spell1Id, spell2: selection.spell2Id } : null,
    spellList: allSpells.map((s) => ({ id: s.id, name: s.name, file: s.file, disallowed: banned.includes(s.id) })),
    runes: runeState(pages),
    // Only requests a teammate sent you. The client lists every teammate, whatever the state.
    swaps: (Object.keys(lists) as SwapKind[]).flatMap((kind) =>
      lists[kind]
        .filter((x) => x.state === "RECEIVED" && isSpellOrChamp(x.id) && swapMakesSense(kind, x.cellId))
        .map((x) => {
          const from = (session.myTeam ?? []).find((p: any) => p.cellId === x.cellId);
          const champ = from ? real(from.championId) || real(from.championPickIntent) : 0;
          return { kind, id: x.id as number, cellId: x.cellId as number, ...named(champ), position: position(from) };
        })
    ),
    skins,
  };
}

/**
 * Hovers or locks a champion for your current pick or ban. A lock with no champion locks
 * the one you are hovering. Before your turn, a hover sets the champion on your coming pick
 * (a pre-pick, as in the client); locking waits for your turn.
 */
export async function phoneChoose(client: LcuClient, championId: unknown, lock: unknown) {
  const locking = lock === true;
  const useHover = locking && (championId === undefined || championId === null || championId === 0);
  if (!useHover && !isSpellOrChamp(championId)) throw new ActionRefused("pick a champion from the list");
  const session = await client.get("/lol-champ-select/v1/session");
  const me = session.localPlayerCellId;
  const actions: any[] = (session.actions ?? []).flat();
  const current = actions.find((a) => a.actorCellId === me && openAction(a));
  const turn = current ?? (locking ? undefined : upcomingPick(actions, me));
  if (!turn) throw new ActionRefused(locking ? "it is not your turn" : "you have no pick left");
  const intent = (session.myTeam ?? []).find((p: any) => p.cellId === me)?.championPickIntent;
  // Locking with no champion locks the hover, or your pre-pick if the client did not carry it over.
  const id = useHover ? turn.championId || (turn.type === "pick" ? intent : 0) : championId;
  if (!isSpellOrChamp(id)) throw new ActionRefused("hover a champion first");
  if (!(await choosable(client, turn.type)).includes(id)) throw new ActionRefused("that champion is not available to you");
  if (takenBy(session, actions, me).has(id)) throw new ActionRefused("that champion is banned or taken");
  // A pre-pick sends only the champion: the action has not started, so it cannot be completed.
  await client.patch(`/lol-champ-select/v1/session/actions/${turn.id}`, current ? { championId: id, completed: locking } : { championId: id });
  return { ok: true };
}

/** Sets your two summoner spells for this game. */
export async function phoneSpells(client: LcuClient, spell1: unknown, spell2: unknown) {
  if (!isSpellOrChamp(spell1) || !isSpellOrChamp(spell2)) throw new ActionRefused("pick two spells");
  if (spell1 === spell2) throw new ActionRefused("pick two different spells");
  const session = await client.get("/lol-champ-select/v1/session").catch(() => ({}));
  const banned = await disallowedSpells(client, session);
  if (banned.includes(spell1) || banned.includes(spell2)) throw new ActionRefused("that spell is not allowed for your position");
  await client.patch(MY_SELECTION, { spell1Id: spell1, spell2Id: spell2 });
  return { ok: true };
}

/** Makes one of your rune pages the current one, with the client's own call. Locked pages count too. */
export async function phoneRune(client: LcuClient, id: unknown) {
  if (!isSpellOrChamp(id)) throw new ActionRefused("pick a rune page");
  const pages: any[] = await client.get(PAGES);
  if (!pages.some((p) => p.id === id)) throw new ActionRefused("that rune page does not exist");
  // The client takes the bare id as the JSON body. Axios 0.21 refuses a number, so it is sent as JSON text.
  await client.put("/lol-perks/v1/currentpage", JSON.stringify(id));
  return { ok: true };
}

/**
 * Requests, cancels, accepts or declines a champion or pick order swap. `id` is the swap's id
 * from the client's swap list, not a cell. Not yet tested in a live game.
 */
const SWAP_ACTIONS = ["request", "cancel", "accept", "decline"];
export async function phoneSwap(client: LcuClient, kind: unknown, action: unknown, id: unknown) {
  // The kind and the action go into the request path, so only the known words are allowed.
  if (!Object.prototype.hasOwnProperty.call(SWAP_PATHS, kind as string)) throw new ActionRefused("pick a swap");
  if (!SWAP_ACTIONS.includes(action as string)) throw new ActionRefused("pick a swap");
  if (!isSpellOrChamp(id)) throw new ActionRefused("pick a swap");
  await client.post(`${SWAP_PATHS[kind as SwapKind]}/${id}/${action}`, {});
  return { ok: true };
}

/** Leaves champion select (a dodge), with the client's usual penalty. Only in champ select. */
export async function phoneDodge(client: LcuClient) {
  await requirePhase(client, "ChampSelect", "you are not in champion select");
  await client.post(DODGE, undefined);
  return { ok: true };
}

/** Wears a skin you own, from the skins the client offers. Skins you do not own are bought in the client. */
export async function phoneSkin(client: LcuClient, skinId: unknown) {
  if (!isSpellOrChamp(skinId)) throw new ActionRefused("pick a skin");
  await requirePhase(client, "ChampSelect", "pick a skin in champion select");
  const skins = await skinOffers(client);
  if (!skins.available) throw new ActionRefused("the skin is locked now");
  const skin = skins.options.find((s) => s.id === skinId);
  if (!skin) throw new ActionRefused("that skin is not offered for this champion");
  if (!skin.owned) throw new ActionRefused("buy that skin in the client first");
  if (skins.selected !== skinId) await client.patch(MY_SELECTION, { selectedSkinId: skinId });
  return { ok: true };
}

/** Accepts or declines the match that was found. Only while it waits for you and you have not answered. */
export async function phoneReadyCheck(client: LcuClient, action: "accept" | "decline") {
  const phase: string = await client.get(GAMEFLOW);
  const check = phase === "ReadyCheck" ? await client.get(READY_CHECK) : null;
  if (!awaitingAnswer(check)) throw new ActionRefused("no match is waiting for you");
  await client.post(`${READY_CHECK}/${action}`, {});
  return { ok: true };
}

/** Refuses unless the client is in the given phase. */
async function requirePhase(client: LcuClient, phase: string, refusal: string) {
  if ((await client.get(GAMEFLOW)) !== phase) throw new ActionRefused(refusal);
}

/** Starts the queue from your lobby, as the client's Find Match button does. Only from a lobby. */
export async function phoneQueue(client: LcuClient) {
  await requirePhase(client, "Lobby", "queue up from a lobby in the client");
  await client.post("/lol-lobby/v2/lobby/matchmaking/search", {});
  return { ok: true };
}

/** Cancels the search that is running. Only while the client is searching. */
export async function phoneCancelQueue(client: LcuClient) {
  await requirePhase(client, "Matchmaking", "you are not in a queue");
  await client.delete("/lol-lobby/v2/lobby/matchmaking/search");
  return { ok: true };
}

let modeCache: { at: number; list: { id: number; name: string }[] } | null = null;
/** Forgets the mode list (used by tests). */
export function resetModeCache() {
  modeCache = null;
}

/** The modes the phone can switch to: available Summoner's Rift and ARAM queues, cached for ten minutes. */
async function modeOptions(client: LcuClient) {
  if (modeCache && Date.now() - modeCache.at < 10 * 60_000) return modeCache.list;
  const queues: any[] = await client.get("/lol-game-queues/v1/queues");
  const list = queues
    .filter((q) => q.queueAvailability === "Available" && q.category === "PvP" && ["kSummonersRift", "kARAM"].includes(q.gameSelectModeGroup))
    .map((q) => ({ id: q.id as number, name: (q.description || q.name || `Queue ${q.id}`) as string }));
  modeCache = { at: Date.now(), list };
  return list;
}

/** The lobby's current mode and the modes to switch to. Null when there is no lobby. */
async function lobbyState(client: LcuClient) {
  const lobby = await client.get("/lol-lobby/v2/lobby").catch(() => null);
  const queueId = lobby?.gameConfig?.queueId;
  if (!isSpellOrChamp(queueId)) return null;
  return { queueId: queueId as number, modes: await modeOptions(client).catch(() => []) };
}

/** Opens a lobby in a mode, as the client's Create lobby does. Only from the home screen, where no lobby is open. */
export async function phoneCreateLobby(client: LcuClient, queueId: unknown) {
  if (!isSpellOrChamp(queueId)) throw new ActionRefused("pick a mode");
  await requirePhase(client, "None", "a lobby is already open; leave it first");
  if (!(await modeOptions(client)).some((m) => m.id === queueId)) throw new ActionRefused("that mode is not available");
  await client.post("/lol-lobby/v2/lobby", { queueId });
  return { ok: true };
}

/** Switches the lobby to another mode. Only from the lobby, so a search has to be cancelled first. */
export async function phoneMode(client: LcuClient, queueId: unknown) {
  if (!isSpellOrChamp(queueId)) throw new ActionRefused("pick a mode");
  await requirePhase(client, "Lobby", "change the mode from a lobby in the client");
  if (!(await modeOptions(client)).some((m) => m.id === queueId)) throw new ActionRefused("that mode is not available");
  await client.post("/lol-lobby/v2/lobby", { queueId });
  return { ok: true };
}

/** Leaves the lobby. Only from the lobby, not during a search. */
export async function phoneLeaveLobby(client: LcuClient) {
  await requirePhase(client, "Lobby", "you are not in a lobby");
  await client.delete("/lol-lobby/v2/lobby");
  return { ok: true };
}

/** Serves one icon, or 404 when the path does not name a valid icon. */
async function iconReply(path: string, deps: PhoneDeps): Promise<Response> {
  const champion = path.match(/^\/icon\/champion\/(.+)\.png$/);
  const spell = path.match(/^\/icon\/spell\/(.+)$/);
  const rune = path.match(/^\/icon\/rune\/(\d+)\.png$/);
  // A skin id is the champion's id times 1000, plus the skin's number.
  const splash = path.match(/^\/icon\/splash\/(\d+)\.jpg$/);
  try {
    let bytes: ArrayBuffer | null = null;
    if (champion) bytes = await championIcon(champion[1], deps.fetch);
    else if (spell) bytes = await spellIcon(spell[1], deps.fetch);
    else if (rune) bytes = await runeIcon(deps.client, Number(rune[1]), deps.fetch);
    else if (splash) {
      const skinId = Number(splash[1]);
      const champ = (await championInfo(deps.client)).get(Math.floor(skinId / 1000));
      bytes = champ ? await skinArt(champ.alias, skinId % 1000, deps.fetch) : null;
    }
    if (!bytes) return reply({ error: "not found" }, 404);
    const type = splash ? "image/jpeg" : "image/png";
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
  } catch {
    return reply({ error: "icon unavailable" }, 502);
  }
}

type Route = (deps: PhoneDeps, body: any) => Promise<unknown>;

/** The API, by "METHOD /path". A request for anything else is 404. */
const ROUTES: Record<string, Route> = {
  // The app checks that the server is alive with this; it does not touch the League client.
  "GET /api/ping": async () => ({ ok: true }),
  "GET /api/state": (d) => phoneState(d.client, d.fetch),
  "POST /api/choose": (d, b) => phoneChoose(d.client, b.championId, b.lock),
  "POST /api/spells": (d, b) => phoneSpells(d.client, b.spell1, b.spell2),
  "POST /api/swap": (d, b) => phoneSwap(d.client, b.kind ?? "champion", b.action, b.id),
  "POST /api/dodge": (d) => phoneDodge(d.client),
  "POST /api/skin": (d, b) => phoneSkin(d.client, b.skinId),
  "POST /api/accept": (d) => phoneReadyCheck(d.client, "accept"),
  "POST /api/decline": (d) => phoneReadyCheck(d.client, "decline"),
  "POST /api/queue": (d) => phoneQueue(d.client),
  "POST /api/cancel": (d) => phoneCancelQueue(d.client),
  "POST /api/lobby": (d, b) => phoneCreateLobby(d.client, b.queueId),
  "POST /api/mode": (d, b) => phoneMode(d.client, b.queueId),
  "POST /api/leave": (d) => phoneLeaveLobby(d.client),
  "POST /api/rune": (d, b) => phoneRune(d.client, b.id),
  "GET /api/runes": (d) => runeData(d.client),
  "POST /api/rune-save": (d, b) => saveRunePage(d.client, b),
};

/** Handles one request from the phone. Only the page, the API under /api and the icons under /icon are served. */
export async function handlePhone(req: Request, deps: PhoneDeps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/") {
    return new Response(PHONE_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.pathname.startsWith("/icon/")) {
    return req.method === "GET" ? iconReply(url.pathname, deps) : reply({ error: "not found" }, 404);
  }
  const route = url.pathname.startsWith("/api/") ? ROUTES[`${req.method} ${url.pathname}`] : undefined;
  if (!route) return reply({ error: "not found" }, 404);

  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as any) : {};
  try {
    return reply(await route(deps, body));
  } catch (err: any) {
    if (err instanceof ActionRefused) return reply({ error: err.message }, 422);
    if (err?.code === "ECONNREFUSED") return reply({ error: "League client not running" }, 502);
    return reply({ error: err?.response?.data?.message ?? err?.message ?? "request failed" }, 502);
  }
}

/**
 * Runs the phone server on the local network until the process is stopped. The app waits
 * for the `phone page on port` line on stderr before it shows the QR code.
 */
export function servePhone(lock: LockFile, port: number): Promise<never> {
  Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch: (req) => handlePhone(req, { client: lcuClient(lock) }),
  });
  console.error(`phone page on port ${port}`);
  return new Promise(() => {});
}
