/**
 * The phone champ select page. It runs on the Mac, on the local network only: a phone on
 * the same Wi-Fi can open it, and nothing goes through the internet. Every request must
 * carry the passcode shown on the Mac.
 */
import { ActionRefused, lcuClient, takenBy, type LcuClient } from "./player";
import type { LockFile } from "./LockFileParser";
import { PHONE_PAGE } from "./phonePage";

export interface PhoneDeps {
  client: LcuClient;
  passcode: string;
}

const JSON_HEADERS = { "content-type": "application/json" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

// Wrong passcodes in the last minute. Past 20, the server refuses until they age out.
let failures: number[] = [];
/** Clears the wrong-passcode count (used by tests). */
export function resetPasscodeFailures() {
  failures = [];
}
const WINDOW_MS = 60_000;
const MAX_FAILURES = 20;

/** Compares two strings in the same time whatever the difference, so the passcode cannot be guessed from timing. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const isSpellOrChamp = (n: unknown) => Number.isInteger(n) && (n as number) > 0;

let names: { at: number; map: Map<number, string> } = { at: 0, map: new Map() };
async function championNames(client: LcuClient): Promise<Map<number, string>> {
  if (Date.now() - names.at > 10 * 60_000) {
    const list: { id: number; name: string }[] = await client.get("/lol-game-data/assets/v1/champion-summary.json");
    names = { at: Date.now(), map: new Map(list.map((c) => [c.id, c.name])) };
  }
  return names.map;
}

/** Everything the phone shows. Outside champ select it says so and nothing else. */
export async function phoneState(client: LcuClient) {
  const phase: string = await client.get("/lol-gameflow/v1/gameflow-phase");
  if (phase !== "ChampSelect") return { phase, inChampSelect: false };

  const [session, nameOf] = await Promise.all([
    client.get("/lol-champ-select/v1/session"),
    championNames(client),
  ]);
  const me = session.localPlayerCellId;
  const actions: any[] = (session.actions ?? []).flat();
  const turn = actions.find(
    (a) => a.actorCellId === me && a.isInProgress && !a.completed && (a.type === "ban" || a.type === "pick")
  );
  const name = (id: number) => (id ? nameOf.get(id) ?? `#${id}` : "");

  const options: number[] = turn
    ? await client.get(turn.type === "ban" ? "/lol-champ-select/v1/bannable-champion-ids" : "/lol-champ-select/v1/pickable-champion-ids")
    : [];
  const selection = await client.get("/lol-champ-select/v1/session/my-selection").catch(() => null);
  const swaps = await client.get("/lol-champ-select/v1/session/champion-swaps").catch(() => []);

  return {
    phase,
    inChampSelect: true,
    turn: turn ? { id: turn.id, type: turn.type, championId: turn.championId, name: name(turn.championId) } : null,
    options: options.map((id) => ({ id, name: name(id) })),
    team: (session.myTeam ?? []).map((p: any) => ({
      mine: p.cellId === me,
      champion: name(p.championId) || name(p.championPickIntent),
      cellId: p.cellId,
    })),
    bans: {
      mine: (session.bans?.myTeamBans ?? []).map(name),
      theirs: (session.bans?.theirTeamBans ?? []).map(name),
    },
    enemies: (session.theirTeam ?? []).map((p: any) => name(p.championId)).filter(Boolean),
    spells: selection ? { spell1: selection.spell1Id, spell2: selection.spell2Id } : null,
    swaps,
  };
}

/** Hovers or locks a champion for your current pick or ban. */
export async function phoneChoose(client: LcuClient, championId: unknown, lock: unknown) {
  if (!isSpellOrChamp(championId)) throw new ActionRefused("pick a champion from the list");
  const session = await client.get("/lol-champ-select/v1/session");
  const me = session.localPlayerCellId;
  const actions: any[] = (session.actions ?? []).flat();
  const turn = actions.find(
    (a) => a.actorCellId === me && a.isInProgress && !a.completed && (a.type === "ban" || a.type === "pick")
  );
  if (!turn) throw new ActionRefused("it is not your turn");
  const allowed: number[] = await client.get(
    turn.type === "ban" ? "/lol-champ-select/v1/bannable-champion-ids" : "/lol-champ-select/v1/pickable-champion-ids"
  );
  if (!allowed.includes(championId as number)) throw new ActionRefused("that champion is not available to you");
  if (takenBy(session, actions, me).has(championId as number)) throw new ActionRefused("a teammate has that champion");
  await client.patch(`/lol-champ-select/v1/session/actions/${turn.id}`, {
    championId,
    completed: lock === true,
  });
  return { ok: true };
}

/** Sets your two summoner spells for this game. */
export async function phoneSpells(client: LcuClient, spell1: unknown, spell2: unknown) {
  if (!isSpellOrChamp(spell1) || !isSpellOrChamp(spell2)) throw new ActionRefused("pick two spells");
  if (spell1 === spell2) throw new ActionRefused("pick two different spells");
  await client.patch("/lol-champ-select/v1/session/my-selection", { spell1Id: spell1, spell2Id: spell2 });
  return { ok: true };
}

/** Asks for a champion swap with a teammate, or accepts one. Not yet tested in a live game. */
export async function phoneSwap(client: LcuClient, action: "request" | "accept", id: unknown) {
  if (!isSpellOrChamp(id)) throw new ActionRefused("pick a swap");
  await client.post(`/lol-champ-select/v1/session/champion-swaps/${id}/${action}`, {});
  return { ok: true };
}

/** Handles one request from the phone. Only the page and the API under /api are served. */
export async function handlePhone(req: Request, deps: PhoneDeps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/") {
    return new Response(PHONE_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (!url.pathname.startsWith("/api/")) return reply({ error: "not found" }, 404);

  const now = Date.now();
  failures = failures.filter((t) => now - t < WINDOW_MS);
  if (failures.length >= MAX_FAILURES) return reply({ error: "too many wrong passcodes; wait a minute" }, 429);
  const given = req.headers.get("x-passcode") ?? "";
  if (!sameText(given, deps.passcode)) {
    failures.push(now);
    return reply({ error: "wrong passcode" }, 401);
  }

  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as any) : {};
  try {
    if (req.method === "GET" && url.pathname === "/api/state") return reply(await phoneState(deps.client));
    if (req.method === "POST" && url.pathname === "/api/choose") return reply(await phoneChoose(deps.client, body.championId, body.lock));
    if (req.method === "POST" && url.pathname === "/api/spells") return reply(await phoneSpells(deps.client, body.spell1, body.spell2));
    if (req.method === "POST" && url.pathname === "/api/swap") return reply(await phoneSwap(deps.client, body.action, body.id));
    return reply({ error: "not found" }, 404);
  } catch (err: any) {
    if (err instanceof ActionRefused) return reply({ error: err.message }, 422);
    if (err?.code === "ECONNREFUSED") return reply({ error: "League client not running" }, 502);
    return reply({ error: err?.response?.data?.message ?? err?.message ?? "request failed" }, 502);
  }
}

/** Runs the phone server on the local network until the process is stopped. */
export function servePhone(lock: LockFile, port: number, passcode: string): Promise<never> {
  Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch: (req) => handlePhone(req, { client: lcuClient(lock), passcode }),
  });
  console.error(`phone page on port ${port}`);
  return new Promise(() => {});
}
