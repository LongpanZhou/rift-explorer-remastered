import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invokeJson, messageFor, type SidecarError } from "../errors";
import { formatDuration, queueName, summarize, type Game } from "./summary";
import { safeCount, safeWorth, summarizeLoot, worth, type LootItem } from "./loot";
import { fillerFor, LINE_INDENT, NBSP } from "./width";
import { fitsStatusBox, padArt } from "./asciiArt";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { encodeText, joinClientLines, splitClientLines, toClientText } from "../../app/util/text";
import StatusError from "../StatusError";
import PhonePanel from "./PhonePanel";
import type { AutoConfig, AutoTickResult, ClaimAllResult, PendingReward, StyleInfo } from "../../app/util/player";
import { LEVELS_PER_CREST, MIN_COUNTED_SECONDS, TOKEN_LIMIT } from "../../app/util/rules";

interface Profile {
  summoner: { gameName: string; tagLine: string; summonerLevel: number; profileIconId: number; availability: string; statusMessage: string };
  ranked: { queueType: string; tier: string; division: string; leaguePoints: number; wins: number; losses: number }[];
  games: Game[];
  champions: Record<number, { name: string; alias: string }>;
  regalia: { preferredCrestType: string; preferredBannerType: string; selectedPrestigeCrest: number; maxPrestigeCrest: number };
  backgroundSkinId: number;
  icons: Item[];
  skins: Item[];
}

/** A catalog entry; `owned` means the inventory grants it. */
interface Item {
  id: number;
  title?: string;
  name?: string;
  /** A skin's champion. */
  champion?: string;
  owned: boolean;
}

const collate = new Intl.Collator().compare;
/** The orders the skin grid can sort by. The first is the order the list comes in. */
const SKIN_ORDERS = [
  { label: "Name", compare: (a: Item, b: Item) => collate(a.name ?? "", b.name ?? "") },
  {
    label: "Champion",
    compare: (a: Item, b: Item) => collate(a.champion ?? "", b.champion ?? "") || collate(a.name ?? "", b.name ?? ""),
  },
];

type Reward = PendingReward;

interface Loot {
  wallet: { rp: number; be: number; oe: number };
  items: LootItem[];
}

interface RunePage {
  id: number;
  name: string;
  current: boolean;
  editable: boolean;
  primaryStyleId: number;
  subStyleId: number;
  selectedPerkIds: number[];
}

type RuneStyle = StyleInfo;

/**
 * Calls `tick` every `ms` while `enabled`, and right away when it starts. A call is skipped
 * while the previous one is still running, so slow requests never pile up.
 */
function usePoll(tick: () => Promise<unknown>, ms: number, enabled: boolean) {
  const pending = useRef(false);
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (pending.current) return;
      pending.current = true;
      latest.current().finally(() => (pending.current = false));
    };
    run();
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  }, [enabled, ms]);
}

/** Two clicks for anything that cannot be undone: the first click arms, the second acts. */
function useArmed() {
  const [armed, setArmed] = useState<string | null>(null);
  const confirm = (key: string, go: () => void) => {
    if (armed === key) {
      setArmed(null);
      go();
    } else setArmed(key);
  };
  return { armed, confirm };
}

interface Runes {
  pages: RunePage[];
  perks: Record<number, { name: string; icon: string; desc: string }>;
  styles: Record<number, RuneStyle>;
  ownedPages: number;
  canAddPage: boolean;
  buy: { prices: { currency: string; cost: number }[]; options: string[]; reason: string | null };
}

interface Challenges {
  earned: { id: number; name: string; level: string; description: string; icon: string }[];
  titles: { itemId: number; name: string }[];
  currentTitle: number;
  currentTokens: number[];
}

// Images come from Riot's public Data Dragon CDN; the client's own asset
// routes need the lockfile password, which the webview does not have.
const DD = "https://ddragon.leagueoflegends.com/cdn";
// Client art (challenge tokens, reward items) is not on Data Dragon. CommunityDragon, a public
// community mirror of the client's files, serves the same images.
const CDRAGON = "https://raw.communitydragon.org/latest/plugins/";
const clientAsset = (clientPath: string) => {
  const lower = clientPath.toLowerCase();
  if (lower.startsWith("/lol-game-data/assets/"))
    return CDRAGON + "rcp-be-lol-game-data/global/default/" + lower.slice("/lol-game-data/assets/".length);
  if (lower.startsWith("/fe/lol-loot/"))
    return CDRAGON + "rcp-fe-lol-loot/global/default/" + lower.slice("/fe/lol-loot/".length);
  return "";
};
const QUEUE_LABEL: Record<string, string> = {
  RANKED_SOLO_5x5: "Solo/Duo",
  RANKED_FLEX_SR: "Flex",
};
const SECTIONS = [
  ["overview", "Overview"],
  ["icon", "Icon"],
  ["border", "Border & banner"],
  ["background", "Background"],
  ["titles", "Title & tokens"],
  ["rewards", "Rewards"],
  ["loot", "Loot"],
  ["runes", "Rune pages"],
  ["auto", "Auto champ select"],
  ["phone", "Phone"],
] as const;
type Section = (typeof SECTIONS)[number][0];

const run = (args: string[]) => invokeJson("player", { args });
const onClass = (active: boolean) => (active ? "on" : "");

type AutoSettings = AutoConfig & { enabled: boolean };
const AUTO_KEY = "rift-explorer-auto";
const AUTO_DEFAULT: AutoSettings = { enabled: false, accept: false, lock: false, bans: [], picks: [] };
/** Classic Rift's versions of champions use ids 60000 + the normal id; auto mode uses only normal ones. */
const isNormalChamp = (id: number) => id > 0 && id < 60000;
function loadAuto(): AutoSettings {
  try {
    // Auto mode always starts off; the lists and switches are remembered.
    return { ...AUTO_DEFAULT, ...JSON.parse(localStorage.getItem(AUTO_KEY) ?? "{}"), enabled: false };
  } catch {
    return AUTO_DEFAULT;
  }
}
const idList = (ids: number[]) => (ids.length ? ids.join("-") : "none");

/** The ASCII art button sits next to the status message. Set to false to hide it. */
const ASCII_ART_ENABLED = true;

export default function Player({ active = true }: { active?: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [challenges, setChallenges] = useState<Challenges | null>(null);
  const [rewards, setRewards] = useState<Reward[] | null>(null);
  const [loot, setLoot] = useState<Loot | null>(null);
  const [runes, setRunes] = useState<Runes | null>(null);
  const [error, setError] = useState<SidecarError | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<Section>("overview");
  const [asciiOpen, setAsciiOpen] = useState(false);
  const [auto, setAuto] = useState<AutoSettings>(loadAuto);
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const [autoPhase, setAutoPhase] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_KEY, JSON.stringify(auto));
    } catch {
      // Settings just are not remembered.
    }
  }, [auto]);
  // Auto champ select: one pick, ban or accept step every two seconds while auto mode is on.
  usePoll(
    () =>
      run(["auto-tick", auto.accept ? "1" : "0", auto.lock ? "1" : "0", idList(auto.bans), idList(auto.picks)])
        .then((r: AutoTickResult) => {
          setAutoPhase(r.phase);
          if (!r.did) return;
          const name = r.championId ? profileRef.current?.champions[r.championId]?.name : undefined;
          const line = `${new Date().toLocaleTimeString()} ${name ? r.did.replace(String(r.championId), name) : r.did}`;
          setAutoLog((log) => [line, ...log].slice(0, 20));
        })
        .catch((e: SidecarError) => setAutoPhase(messageFor(e))),
    2000,
    auto.enabled
  );
  // Phone champ select and auto mode do not run together: opening the Phone tab turns auto off.
  useEffect(() => {
    if (section === "phone") setAuto((a) => (a.enabled ? { ...a, enabled: false } : a));
  }, [section]);
  const [ddVersion, setDdVersion] = useState("");
  // The profile icons, copied from the client into the app's cache folder. `missing` lists the
  // ids the client had no picture for.
  const [icons, setIcons] = useState<{ dir: string; missing: number[] } | null>(null);
  // The skin loading pictures are copied as the Background tab shows them. `cached` lists the ones
  // copied so far; `skinWanted` lists the skins that have come near the screen.
  const [skinArt, setSkinArt] = useState<{ dir: string; cached: Set<number> } | null>(null);
  const [skinWanted, setSkinWanted] = useState<number[]>([]);
  const skinAsked = useRef(new Set<number>());
  const wantSkin = useCallback((id: number) => setSkinWanted((w) => (w.includes(id) ? w : [...w, id])), []);
  const profileRef = useRef<Profile | null>(null);
  profileRef.current = profile;

  const load = () => {
    setError(null);
    fetchInto("profile", setProfile);
  };
  useEffect(load, []);
  useEffect(() => {
    fetch("https://ddragon.leagueoflegends.com/api/versions.json")
      .then((r) => r.json())
      .then((v) => setDdVersion(v[0]))
      .catch(() => {});
  }, []);
  // Tab data loads once, on the first visit to its tab. The challenge list is about 3 MB.
  const fetchInto = (cmd: string, set: (value: any) => void) => run([cmd]).then(set).catch(setError);
  useEffect(() => {
    const lazy: [Section, boolean, string, (value: any) => void][] = [
      ["titles", challenges !== null, "challenges", setChallenges],
      ["rewards", rewards !== null, "rewards", setRewards],
      ["loot", loot !== null, "loot", setLoot],
      ["runes", runes !== null, "runes", setRunes],
    ];
    for (const [name, loaded, cmd, set] of lazy) if (section === name && !loaded) fetchInto(cmd, set);
  }, [section, challenges, rewards, loot, runes]);
  const reloadRunes = () => fetchInto("runes", setRunes);
  // The icons are copied on the first visit to the Icon tab. Later visits only find the copies.
  useEffect(() => {
    if (section === "icon" && icons === null) invokeJson<{ dir: string; missing: number[] }>("icon_cache").then(setIcons).catch(setError);
  }, [section, icons]);
  // Each new batch of skins that came near the screen is copied once, after a short pause.
  useEffect(() => {
    const fresh = skinWanted.filter((id) => !skinAsked.current.has(id));
    if (fresh.length === 0) return;
    const timer = setTimeout(() => {
      fresh.forEach((id) => skinAsked.current.add(id));
      invokeJson<{ dir: string; missing: number[] }>("skin_cache", { ids: fresh })
        .then((r) => {
          const missing = new Set(r.missing);
          setSkinArt((cur) => ({
            dir: r.dir,
            cached: new Set([...(cur?.cached ?? []), ...fresh.filter((id) => !missing.has(id))]),
          }));
        })
        .catch(setError);
    }, 150);
    return () => clearTimeout(timer);
  }, [skinWanted]);

  /**
   * Runs a write. On success, patches the loaded data instead of reloading it:
   * a reload spawns the sidecar again and refetches the 6 MB skin catalog.
   */
  const act = <T,>(args: string[], done: string | ((result: T) => string), patch: (result: T) => void) => {
    setBusy(true);
    setNotice("");
    run(args)
      .then((result: T) => {
        setNotice(typeof done === "string" ? done : done(result));
        patch(result);
      })
      .catch((e: SidecarError) => setNotice(messageFor(e)))
      .finally(() => setBusy(false));
  };
  // Downloads do not change the profile, so they run alongside other actions.
  const download = (kind: "icon" | "skin", id: number) =>
    run(["download", kind, String(id)])
      .then((r: { path: string }) => setNotice(`Saved to ${r.path}`))
      .catch((e: SidecarError) => setNotice(messageFor(e)));
  // Re-read what the client can change while the app is open (icon, status, crest, banner,
  // background, title, tokens), so changes made in the client show here. Runs only while the
  // player tab is showing, and skips a tick while an action is saving.
  const polling = profile !== null && active;
  usePoll(
    () =>
      busy
        ? Promise.resolve()
        : run(["live"])
            .then((live: Pick<Profile, "summoner" | "regalia" | "backgroundSkinId"> & Pick<Challenges, "currentTitle" | "currentTokens">) => {
              // Title and tokens live on the challenges data, which may not be loaded yet.
              setChallenges((cur) =>
                cur && (cur.currentTitle !== live.currentTitle || cur.currentTokens.join() !== live.currentTokens.join())
                  ? { ...cur, currentTitle: live.currentTitle, currentTokens: live.currentTokens }
                  : cur
              );
              setProfile((cur) =>
                cur && { ...cur, summoner: { ...cur.summoner, ...live.summoner }, regalia: live.regalia, backgroundSkinId: live.backgroundSkinId }
              );
            })
            .catch(() => {}),
    3000,
    polling
  );

  const patchProfile = (p: Partial<Profile>) => () => setProfile((cur) => cur && { ...cur, ...p });
  const patchSummoner = (p: Partial<Profile["summoner"]>) => () =>
    setProfile((cur) => cur && { ...cur, summoner: { ...cur.summoner, ...p } });
  const patchChallenges = (c: Partial<Challenges>) => () => setChallenges((cur) => cur && { ...cur, ...c });

  if (error) return <StatusError error={error} retry={load} />;
  if (!profile) return <p className="status">Loading your profile...</p>;

  const iconUrl = (id: number) => (ddVersion ? `${DD}/${ddVersion}/img/profileicon/${id}.png` : "");
  // The grid shows the copies in the cache folder, which load from disk.
  const iconFile = (id: number) => (icons && !icons.missing.includes(id) ? convertFileSrc(`${icons.dir}/${id}.jpg`) : "");
  const champ = (id: number) => profile.champions[id];
  const avatar = iconUrl(profile.summoner.profileIconId);
  // Data Dragon's loading picture of a skin: the fallback when the client's copy is missing.
  const loadingArt = (id: number) => {
    const alias = champ(Math.floor(id / 1000))?.alias;
    return alias ? `${DD}/img/champion/loading/${alias}_${id % 1000}.jpg` : "";
  };
  const skinFile = (id: number) => (skinArt?.cached.has(id) ? convertFileSrc(`${skinArt.dir}/${id}.jpg`) : "");

  return (
    <div className="player">
      <header className="profile-head">
        {avatar && <img className="avatar" src={avatar} alt="" />}
        <div>
          <h1>
            {profile.summoner.gameName}
            <span className="tag">#{profile.summoner.tagLine}</span>
          </h1>
          <p className="muted">Level {profile.summoner.summonerLevel}</p>
          <div className="status-row">
          {profile.summoner.availability && (
            <StatusMessage
              value={profile.summoner.statusMessage}
              busy={busy}
              save={(m) =>
                act(
                  ["set-status-message", encodeText(m)],
                  m ? "Status message saved." : "Status message cleared.",
                  patchSummoner({ statusMessage: m })
                )
              }
            />
          )}
          {ASCII_ART_ENABLED && (
            <button className={`ascii-toggle ${asciiOpen ? "on" : ""}`} onClick={() => setAsciiOpen(!asciiOpen)}>
              {asciiOpen ? "Hide ASCII art" : "ASCII art"}
            </button>
          )}
          {asciiOpen && (
            <div className="ascii-pop">
              <AsciiArt
                busy={busy}
                setStatus={(text) =>
                  act(
                    ["set-status-message", encodeText(text)],
                    "ASCII art set as your status.",
                    patchSummoner({ statusMessage: text })
                  )
                }
              />
            </div>
          )}
          </div>
        </div>
        {profile.summoner.availability && (
          <StatusPicker
            value={profile.summoner.availability}
            busy={busy}
            set={(a) =>
              act(
                ["set-status", a],
                `Status set to ${STATUS_LABEL[a]}.`,
                patchSummoner({ availability: a })
              )
            }
          />
        )}
      </header>

      <nav className="subnav">
        {SECTIONS.map(([key, label]) => (
          <button key={key} className={onClass(section === key)} onClick={() => setSection(key)}>
            {label}
          </button>
        ))}
      </nav>

      {notice && <p className="notice">{notice}</p>}

      {section === "overview" && <Overview profile={profile} champ={champ} />}
      {section === "icon" &&
        (icons ? (
          <CatalogGrid
            kind="icons"
            items={profile.icons}
            current={profile.summoner.profileIconId}
            busy={busy}
            lockedClickable={false}
            intro="Click an owned icon to use it; locked icons are not owned."
            placeholder="Search name or ID"
            matches={(i, t) => String(i.id).includes(t) || (i.title ?? "").toLowerCase().includes(t)}
            image={iconFile}
            fallback={iconUrl}
            label={(i) => `${i.title || "Icon"} (${i.id})`}
            onDownload={(i) => download("icon", i.id)}
            onPick={(i) =>
              act(
                ["set-icon", String(i.id)],
                `Icon changed to ${i.id}.`,
                patchSummoner({ profileIconId: i.id })
              )
            }
          />
        ) : (
          <p className="muted">Copying icons from the client...</p>
        ))}
      {section === "border" && (
        <RegaliaPicker
          regalia={profile.regalia}
          busy={busy}
          onSave={(c, b, n) =>
            act(
              ["set-regalia", c, b, String(n)],
              "Border and banner saved.",
              patchProfile({
                regalia: { ...profile.regalia, preferredCrestType: c, preferredBannerType: b, selectedPrestigeCrest: n },
              })
            )
          }
        />
      )}
      {section === "background" && (
        <CatalogGrid
          kind="skins"
          items={profile.skins}
          current={profile.backgroundSkinId}
          busy={busy}
          lockedClickable
          intro="Any skin can be your profile background; the lock marks skins you do not own."
          placeholder="Search skins"
          matches={(s, t) => (s.name ?? "").toLowerCase().includes(t)}
          image={skinFile}
          fallback={loadingArt}
          onVisible={wantSkin}
          orders={SKIN_ORDERS}
          label={(s) => s.name ?? ""}
          caption
          onDownload={(s) => download("skin", s.id)}
          onPick={(s) =>
            act(["set-background", String(s.id)], `Background set to ${s.name}.`, patchProfile({ backgroundSkinId: s.id }))
          }
        />
      )}
      {section === "auto" && (
        <AutoPanel
          settings={auto}
          change={(p) => setAuto((a) => ({ ...a, ...p }))}
          champions={profile.champions}
          portrait={(id) => {
            const alias = profile.champions[id]?.alias;
            return alias && ddVersion ? `${DD}/${ddVersion}/img/champion/${alias}.png` : "";
          }}
          phase={autoPhase}
          log={autoLog}
        />
      )}
      {section === "phone" && <PhonePanel />}
      {section === "runes" &&
        (runes ? (
          <RunePages
            runes={runes}
            busy={busy}
            act={(args, done) => act(args, done, reloadRunes)}
          />
        ) : (
          <p className="muted">Loading your rune pages...</p>
        ))}
      {section === "loot" &&
        (loot ? (
          <LootView loot={loot} refresh={() => fetchInto("loot", setLoot)} />
        ) : (
          <p className="muted">Loading your loot...</p>
        ))}
      {section === "rewards" &&
        (rewards ? (
          <Rewards
            rewards={rewards}
            busy={busy}
            claim={(r) =>
              act(["claim-reward", r.grantId], `Claimed: ${r.title}.`, () =>
                setRewards((cur) => cur && cur.filter((x) => x.grantId !== r.grantId))
              )
            }
            claimAll={() =>
              act<ClaimAllResult>(
                ["claim-all"],
                (res) => {
                  const parts = [`Claimed ${res.claimed.length}`];
                  if (res.skipped.length) parts.push(`${res.skipped.length} need a choice in the client`);
                  if (res.failed.length) parts.push(`${res.failed.length} failed: ${res.failed[0].error}`);
                  return parts.join("; ") + ".";
                },
                (res) => setRewards((cur) => cur && cur.filter((x) => !res.claimed.includes(x.grantId)))
              )
            }
          />
        ) : (
          <p className="muted">Loading your rewards...</p>
        ))}
      {section === "titles" &&
        (challenges ? (
          <TitlesTokens
            key={`${challenges.currentTitle}:${challenges.currentTokens.join()}`}
            data={challenges}
            busy={busy}
            saveTitle={(title) =>
              act(["set-title", String(title)], "Title saved.", patchChallenges({ currentTitle: title }))
            }
            saveTokens={(tokens) =>
              act(["set-tokens", ...tokens.map(String)], "Tokens saved.", patchChallenges({ currentTokens: tokens }))
            }
          />
        ) : (
          <p className="muted">Loading your challenges...</p>
        ))}
    </div>
  );
}

function Overview({ profile, champ }: { profile: Profile; champ: (id: number) => { name: string } | undefined }) {
  const s = summarize(profile.games);
  return (
    <>
      <section className="cards">
        {profile.ranked.map((r) => (
          <div className="card" key={r.queueType}>
            <h3>{QUEUE_LABEL[r.queueType] ?? r.queueType}</h3>
            {r.tier ? (
              <>
                <p className="big">
                  {r.tier} {r.division}
                </p>
                <p className="muted">
                  {r.leaguePoints} LP · {r.wins}W {r.losses}L
                </p>
              </>
            ) : (
              <p className="big">Unranked</p>
            )}
          </div>
        ))}
        <div className="card">
          <h3>Last {profile.games.length} games</h3>
          {s ? (
            <>
              <p className="big">{s.winRate}% wins</p>
              <p className="muted">
                {s.wins}W {s.counted - s.wins}L over {s.counted} games · avg {formatDuration(s.avgDuration)}
              </p>
              <p className="muted">
                Most played: {champ(s.topChampionId)?.name ?? `#${s.topChampionId}`} ({s.topChampionGames})
              </p>
            </>
          ) : (
            <p className="big">No full games yet</p>
          )}
          <p className="fine">Games under {MIN_COUNTED_SECONDS / 60} minutes are not counted.</p>
        </div>
      </section>

      <table className="games">
        <thead>
          <tr>
            <th>Result</th>
            <th>Champion</th>
            <th>Queue</th>
            <th>KDA</th>
            <th>Length</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {profile.games.map((g, i) => (
            <tr key={i} className={g.win ? "win" : "loss"}>
              <td>{g.win ? "Win" : "Loss"}</td>
              <td>{champ(g.championId)?.name ?? `#${g.championId}`}</td>
              <td>{queueName(g)}</td>
              <td>
                {g.kills ?? 0}/{g.deaths ?? 0}/{g.assists ?? 0}
              </td>
              <td>{formatDuration(g.gameDuration)}</td>
              <td>{new Date(g.gameCreation).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Searchable grid of a whole catalog (icons or skins) with an owned-only filter. */
function CatalogGrid(props: {
  kind: "icons" | "skins";
  items: Item[];
  current: number;
  busy: boolean;
  /** Whether unowned items can still be picked (backgrounds) or not (icons). */
  lockedClickable: boolean;
  intro: string;
  placeholder: string;
  matches: (item: Item, term: string) => boolean;
  image: (id: number) => string;
  /** Tried once when `image` fails to load. */
  fallback?: (id: number) => string;
  /** Called once for a tile when it comes near the screen. */
  onVisible?: (id: number) => void;
  /** Orders the grid can be sorted by; the first is the default. */
  orders?: typeof SKIN_ORDERS;
  label: (item: Item) => string;
  caption?: boolean;
  onPick: (item: Item) => void;
  onDownload: (item: Item) => void;
}) {
  const [q, setQ] = useState("");
  // The icon list opens on the owned icons: the unowned ones make it slow to load.
  const [ownedOnly, setOwnedOnly] = useState(props.kind === "icons");
  const [order, setOrder] = useState(0);
  // Filtering thousands of items per keystroke is deferred so typing stays smooth.
  const term = useDeferredValue(q.trim().toLowerCase());
  const { items, matches } = props;
  const shown = useMemo(() => {
    const picked = items.filter((i) => (!ownedOnly || i.owned) && (!term || matches(i, term)));
    return props.orders ? picked.sort(props.orders[order].compare) : picked;
    // `matches` is recreated each render but depends only on the item and term.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, term, ownedOnly, order]);
  const ownedCount = useMemo(() => items.filter((i) => i.owned).length, [items]);

  return (
    <>
      <p className="muted">
        All {items.length} {props.kind}. {props.intro}
        <input className="search" placeholder={props.placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="owned-filter">
          <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} />
          Owned only ({ownedCount} of {items.length})
        </label>
        {props.orders && (
          <label className="owned-filter">
            Sort by{" "}
            <select value={order} onChange={(e) => setOrder(Number(e.target.value))}>
              {props.orders.map((o, n) => (
                <option key={o.label} value={n}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </p>
      <div className={`grid ${props.kind}`}>
        {shown.map((i) => (
          <Tile
            key={i.id}
            onDownload={props.onDownload}
            item={i}
            on={i.id === props.current}
            disabled={props.busy || i.id === props.current || (!i.owned && !props.lockedClickable)}
            src={props.image(i.id)}
            fallback={props.fallback?.(i.id)}
            onVisible={props.onVisible}
            label={props.label(i)}
            caption={props.caption}
            onPick={props.onPick}
          />
        ))}
      </div>
    </>
  );
}

/** Memoized so a busy/notice change does not re-render thousands of tiles. */
const Tile = memo(function Tile(p: {
  item: Item;
  on: boolean;
  disabled: boolean;
  src: string;
  /** Used once if `src` fails to load. */
  fallback?: string;
  onVisible?: (id: number) => void;
  label: string;
  caption?: boolean;
  onPick: (item: Item) => void;
  onDownload: (item: Item) => void;
}) {
  // Tries the pictures in order (`src`, then `fallback`), skipping each one that fails to load.
  const [failed, setFailed] = useState<string[]>([]);
  const src = [p.src, p.fallback].find((s) => s && !failed.includes(s)) ?? "";
  // Reports the tile once, when it is about to scroll into view.
  const near = useRef<HTMLDivElement>(null);
  const { onVisible } = p;
  const id = p.item.id;
  useEffect(() => {
    const el = near.current;
    if (!onVisible || !el) return;
    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        watch.disconnect();
        onVisible(id);
      },
      { rootMargin: "400px" }
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [onVisible, id]);
  return (
    <div className="tile-wrap" ref={near}>
      <button
        className={`tile ${p.on ? "on" : ""} ${p.item.owned ? "" : "locked"}`}
        disabled={p.disabled}
        onClick={() => p.onPick(p.item)}
        title={p.item.owned ? p.label : `${p.label} - not owned`}
      >
        {src ? (
          <img src={src} alt={p.caption ? "" : p.label} loading="lazy" onError={() => setFailed((f) => [...f, src])} />
        ) : (
          !p.caption && p.item.id
        )}
        {p.caption && <span>{p.label}</span>}
      </button>
      <button className="dl" title={`Download ${p.label}`} onClick={() => p.onDownload(p.item)}>
        ⬇
      </button>
    </div>
  );
},
// onPick is a new closure each render but always does the same thing for an item.
(a, b) => a.item === b.item && a.on === b.on && a.disabled === b.disabled && a.src === b.src && a.fallback === b.fallback && a.onVisible === b.onVisible);

function RegaliaPicker(props: {
  regalia: Profile["regalia"];
  busy: boolean;
  onSave: (crest: string, banner: string, prestige: number) => void;
}) {
  const r = props.regalia;
  const [crest, setCrest] = useState(r.preferredCrestType);
  const [banner, setBanner] = useState(r.preferredBannerType);
  const [prestige, setPrestige] = useState(Math.max(1, Math.min(r.selectedPrestigeCrest, r.maxPrestigeCrest)));
  const levels = Array.from({ length: r.maxPrestigeCrest }, (_, i) => i + 1);
  return (
    <div className="form">
      <label>
        Crest around your icon
        <select value={crest} onChange={(e) => setCrest(e.target.value)}>
          <option value="prestige">Level border (prestige)</option>
          <option value="ranked">Ranked crest</option>
        </select>
      </label>
      <label>
        Level border {crest !== "prestige" && <span className="fine">(shown when the crest is set to level border)</span>}
        <select value={prestige} onChange={(e) => setPrestige(Number(e.target.value))}>
          {levels.map((l) => (
            <option key={l} value={l}>
              Level {l * LEVELS_PER_CREST}+ border
            </option>
          ))}
        </select>
      </label>
      <label>
        Banner
        <select value={banner} onChange={(e) => setBanner(e.target.value)}>
          <option value="lastSeasonHighestRank">Last season's highest rank</option>
          <option value="blank">Blank</option>
        </select>
      </label>
      <p className="fine">You can pick any level border up to your level. The client applies the change right away.</p>
      <button disabled={props.busy} onClick={() => props.onSave(crest, banner, prestige)}>
        Save
      </button>
    </div>
  );
}

function TitlesTokens(props: {
  data: Challenges;
  busy: boolean;
  saveTitle: (title: number) => void;
  saveTokens: (tokens: number[]) => void;
}) {
  const { data } = props;
  const [title, setTitle] = useState(data.currentTitle);
  const [tokens, setTokens] = useState(data.currentTokens);
  const [q, setQ] = useState("");

  const toggle = (id: number) =>
    setTokens((t) => (t.includes(id) ? t.filter((x) => x !== id) : t.length < TOKEN_LIMIT ? [...t, id] : t));
  const term = useDeferredValue(q.trim().toLowerCase());
  const shown = data.earned.filter((c) => c.name.toLowerCase().includes(term));
  const name = (id: number) => data.earned.find((c) => c.id === id)?.name ?? `#${id}`;

  return (
    <div className="form wide">
      <label>
        Title ({data.titles.length} owned)
        <select value={title} onChange={(e) => setTitle(Number(e.target.value))}>
          <option value={-1}>No title</option>
          {data.titles.map((t) => (
            <option key={t.itemId} value={t.itemId}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <button disabled={props.busy || title === data.currentTitle} onClick={() => props.saveTitle(title)}>
        Save title
      </button>

      <h3>Tokens: pick up to {TOKEN_LIMIT} ({tokens.length}/{TOKEN_LIMIT})</h3>
      <p className="muted">
        Selected: {tokens.length ? tokens.map(name).join(", ") : "none"}
        <input className="search" placeholder="Search challenges" value={q} onChange={(e) => setQ(e.target.value)} />
      </p>
      <div className="token-list">
        {shown.map((c) => (
          <label key={c.id} className={`token ${tokens.includes(c.id) ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={tokens.includes(c.id)}
              disabled={!tokens.includes(c.id) && tokens.length >= TOKEN_LIMIT}
              onChange={() => toggle(c.id)}
            />
            {c.icon && <img className="token-img" src={clientAsset(c.icon)} alt="" loading="lazy" />}
            <span className="token-text">
              <span>{c.name}</span>
              <span className="fine">{c.description}</span>
            </span>
            <span className={`level lv-${c.level.toLowerCase()}`}>{c.level}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <button disabled={props.busy} onClick={() => props.saveTokens(tokens)}>
          Save tokens
        </button>
        <button
          disabled={props.busy || !data.currentTokens.length}
          onClick={() => {
            setTokens([]);
            props.saveTokens([]);
          }}
        >
          Clear tokens
        </button>
      </div>
      <p className="fine">Only titles you own and challenges you have earned are listed; the client rejects others.</p>
    </div>
  );
}

function Rewards(props: { rewards: Reward[]; busy: boolean; claim: (r: Reward) => void; claimAll: () => void }) {
  // A claim cannot be undone, so the first click only arms the button.
  const { armed, confirm } = useArmed();
  if (!props.rewards.length) return <p className="muted">No unclaimed rewards.</p>;
  return (
    <>
      <p className="muted">
        {props.rewards.length} rewards waiting. Claiming adds them to your inventory, like the claim button in the client.
      </p>
      <button
        disabled={props.busy}
        onClick={() => confirm("all", props.claimAll)}
      >
        {armed === "all" ? `Click again to claim all ${props.rewards.length}` : "Claim all"}
      </button>
      <div className="rewards">
        {props.rewards.map((r) => (
          <div className="card reward" key={r.grantId}>
            <div className="reward-items">
              {r.items.map((i) => (
                <div className="reward-item" key={i.id} title={i.details}>
                  {i.icon && <img src={clientAsset(i.icon)} alt="" loading="lazy" />}
                  <span>
                    {i.name}
                    {i.quantity > 1 && ` x${i.quantity}`}
                  </span>
                </div>
              ))}
            </div>
            <p className="fine">Granted {r.date ? new Date(r.date).toLocaleDateString() : "unknown date"}</p>
            <button
              disabled={props.busy}
              onClick={() => confirm(r.grantId, () => props.claim(r))}
            >
              {armed === r.grantId ? "Click again to claim" : "Claim"}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

const n = (v: number) => v.toLocaleString();
const SAFE_GROUPS: [LootItem["kind"], string][] = [
  ["champion", "Champions"],
  ["skin", "Skins"],
  ["ward", "Wards"],
];
const LOOT_GROUPS: [LootItem["kind"], string][] = [
  ["champion", "Champions"],
  ["skin", "Skin shards"],
  ["ward", "Ward shards"],
  ["material", "Materials"],
];

/** A titled card with one large value and a note under it. */
function StatCard({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <p className="big">{value}</p>
      <p className="muted">{note}</p>
    </div>
  );
}

/** One item in the loot grid: art, name with its count, and a line of detail. */
function LootTile({
  item,
  count,
  className,
  detail,
}: {
  item: LootItem;
  count: number;
  className: string;
  detail: ReactNode;
}) {
  return (
    <div className={`loot ${className}`} title={item.name}>
      {clientAsset(item.tile) && <img src={clientAsset(item.tile)} alt="" loading="lazy" />}
      <span className="loot-name">
        {item.name}
        {count > 1 && <b> x{count}</b>}
      </span>
      {detail}
    </div>
  );
}

/** Read-only view of loot: wallet, what everything is worth, and what OE can unlock. */
function LootView({ loot, refresh }: { loot: Loot; refresh: () => void }) {
  const s = useMemo(() => summarizeLoot(loot.items), [loot]);
  const [sort, setSort] = useState<"value" | "name">("value");
  const byKind = (kind: LootItem["kind"]) =>
    loot.items
      .filter((i) => i.kind === kind)
      .sort((a, b) =>
        sort === "name" ? a.name.localeCompare(b.name) : worth(b) - worth(a)
      );

  return (
    <>
      <section className="cards">
        <StatCard title="Wallet" value={`${n(loot.wallet.be)} BE`} note={`${n(loot.wallet.oe)} OE · ${n(loot.wallet.rp)} RP`} />
        <StatCard
          title="If you disenchant everything"
          value={`+${n(s.championBE)} BE`}
          note={`+${n(s.shardOE)} OE from skin and ward shards`}
        />
        <StatCard
          title="Safe to disenchant"
          value={`+${n(s.safeBE)} BE`}
          note={`+${n(s.safeOE)} OE · champions and skins you own, plus duplicate copies`}
        />
      </section>

      <p className="muted">
        Values are what the client shows for each item. This view only reads your loot; open or disenchant items in the
        client.
        <button className="inline" onClick={() => setSort(sort === "value" ? "name" : "value")}>
          Sort by {sort === "value" ? "name" : "value"}
        </button>
        <button className="inline" onClick={refresh}>
          Refresh
        </button>
      </p>

      {s.safe.length > 0 && (
        <section>
          <h2 className="loot-heading">Safe to disenchant</h2>
          {SAFE_GROUPS.map(([kind, label]) => {
            const list = s.safe.filter((i) => i.kind === kind);
            if (!list.length) return null;
            const value = list.reduce((v, i) => v + safeWorth(i), 0);
            return (
              <div key={kind}>
                <h3>
                  {label} ({list.length}) · +{n(value)} {list[0].currency}
                </h3>
                <div className="loot-grid">
                  {list.map((i) => (
                    <LootTile
                      key={i.id}
                      item={i}
                      count={safeCount(i)}
                      className="owned"
                      detail={
                        <span className="fine">
                          +{n(safeWorth(i))} {i.currency}
                          {i.owned ? (kind === "champion" ? " · champion owned" : " · you own this") : " · duplicate copies"}
                        </span>
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <h2 className="loot-heading">All loot</h2>
        </section>
      )}

      {LOOT_GROUPS.map(([kind, label]) => {
        const list = byKind(kind);
        if (!list.length) return null;
        return (
          <section key={kind}>
            <h3>
              {label} ({list.reduce((c, i) => c + i.count, 0)})
            </h3>
            <div className="loot-grid">
              {list.map((i) => (
                <LootTile
                  key={i.id}
                  item={i}
                  count={i.count}
                  className={i.owned && kind !== "champion" ? "owned" : ""}
                  detail={
                    i.disenchant > 0 && (
                      <span className="fine">
                        {n(i.disenchant)} {i.currency}
                        {i.upgrade > 0 && !i.owned && ` · unlock ${n(i.upgrade)} OE`}
                        {i.owned && kind !== "champion" && " · you own this skin"}
                      </span>
                    )
                  }
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

const CURRENCY_LABEL: Record<string, string> = { IP: "BE", RP: "RP" };

function RunePages(props: {
  runes: Runes;
  busy: boolean;
  act: (args: string[], done: string) => void;
}) {
  const { runes } = props;
  // Two clicks for a purchase, which cannot be undone.
  const { armed, confirm } = useArmed();
  const [editing, setEditing] = useState<number | null>(null);

  return (
    <>
      <section className="cards">
        <StatCard
          title="Pages"
          value={`${runes.pages.length} of ${runes.ownedPages}`}
          note={runes.canAddPage ? "You have a free slot." : "All your page slots are in use."}
        />
        <div className="card">
          <h3>Buy one more page</h3>
          <div className="row">
            {runes.buy.prices.map((p) => {
              const offered = runes.buy.options.includes(p.currency);
              const label = `${n(p.cost)} ${CURRENCY_LABEL[p.currency] ?? p.currency}`;
              return (
                <button
                  key={p.currency}
                  disabled={props.busy || !offered}
                  onClick={() => confirm(`buy-${p.currency}`, () => props.act(["buy-rune-page", p.currency], "Rune page bought."))}
                >
                  {armed === `buy-${p.currency}` ? `Click again to spend ${label}` : `Buy with ${label}`}
                </button>
              );
            })}
          </div>
          {!runes.buy.options.length && <p className="fine">The store is not offering a page right now: {runes.buy.reason}.</p>}
        </div>
      </section>

      <div className="rune-pages">
        {runes.pages.map((p) =>
          editing === p.id ? (
            <RuneEditor
              key={p.id}
              page={p}
              runes={runes}
              busy={props.busy}
              cancel={() => setEditing(null)}
              save={(name, primary, sub, perks) => {
                setEditing(null);
                props.act(
                  ["edit-rune-page", String(p.id), encodeText(name), String(primary), String(sub), ...perks.map(String)],
                  `Saved ${name || "page"}.`
                );
              }}
            />
          ) : (
          <div className={`card rune-page ${p.current ? "on" : ""}`} key={p.id}>
            <h3>
              {p.name || "(unnamed)"} {p.current && <span className="fine">· in use</span>}
            </h3>
            <p className="muted">
              {[p.primaryStyleId, p.subStyleId].map((id) => runes.styles[id]?.name ?? id).join(" / ")}
            </p>
            <div className="runes">
              {p.selectedPerkIds.map((id, i) => {
                const perk = runes.perks[id];
                return (
                  <span key={i} className={`rune ${i === 0 ? "keystone" : ""}`} title={perk ? `${perk.name}: ${perk.desc}` : String(id)}>
                    {perk?.icon && <img src={clientAsset(perk.icon)} alt={perk.name} loading="lazy" />}
                  </span>
                );
              })}
            </div>
            {p.editable && (
              <button className="inline-left" disabled={props.busy} onClick={() => setEditing(p.id)}>
                Edit
              </button>
            )}
          </div>
          )
        )}
      </div>
    </>
  );
}


/** Edits one page with the client's layout, so every choice is a valid page. */
function RuneEditor(props: {
  page: RunePage;
  runes: Runes;
  busy: boolean;
  cancel: () => void;
  save: (name: string, primary: number, sub: number, perks: number[]) => void;
}) {
  const { styles, perks: perkInfo } = props.runes;
  const [name, setName] = useState(props.page.name);
  const [primary, setPrimary] = useState(props.page.primaryStyleId);
  const [sub, setSub] = useState(props.page.subStyleId);
  const [picks, setPicks] = useState(props.page.selectedPerkIds);
  const P = styles[primary];
  const S = styles[sub];

  const firstSecondary = (st: RuneStyle) => [st.rows[0][0], st.rows[1][0]];
  const choosePrimary = (id: number) => {
    const np = styles[id];
    const ns = np.allowedSubStyles.includes(sub) && sub !== id ? sub : np.defaultSubStyle;
    const keepShards = picks.slice(6, 9).map((x, i) => (np.shards[i]?.includes(x) ? x : np.shards[i][0]));
    setPrimary(id);
    setSub(ns);
    setPicks([np.keystones[0], ...np.rows.map((r) => r[0]), ...(ns === sub ? picks.slice(4, 6) : firstSecondary(styles[ns])), ...keepShards]);
  };
  const chooseSub = (id: number) => {
    setSub(id);
    setPicks((p) => [...p.slice(0, 4), ...firstSecondary(styles[id]), ...p.slice(6)]);
  };
  const setAt = (i: number, id: number) => setPicks((p) => p.map((x, k) => (k === i ? id : x)));
  // Two secondary runes from different rows: replace the pick in the same row,
  // otherwise drop the older pick.
  const chooseSecondary = (id: number) =>
    setPicks((p) => {
      const rowOf = (x: number) => S.rows.findIndex((r) => r.includes(x));
      const [a, b] = [p[4], p[5]];
      if (id === a || id === b) return p;
      const row = rowOf(id);
      const next = rowOf(a) === row ? [id, b] : rowOf(b) === row ? [a, id] : [b, id];
      return [...p.slice(0, 4), ...next, ...p.slice(6)];
    });

  const rune = (id: number, on: boolean, pick: () => void, big = false) => {
    const info = perkInfo[id];
    return (
      <button key={id} className={`rune-pick ${on ? "on" : ""} ${big ? "keystone" : ""}`} title={info ? `${info.name}: ${info.desc}` : String(id)} onClick={pick}>
        {info?.icon ? <img src={clientAsset(info.icon)} alt={info.name} /> : id}
      </button>
    );
  };
  const tree = (id: number, on: boolean, pick: () => void) => (
    <button key={id} className={`tree-pick ${on ? "on" : ""}`} onClick={pick}>
      {styles[id].icon && <img src={clientAsset(styles[id].icon)} alt="" />}
      {styles[id].name}
    </button>
  );

  return (
    <div className="card rune-editor">
      <label className="form-row">
        Name
        <input className="search" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} />
      </label>

      <h4>Primary tree</h4>
      <div className="row wrap">{Object.keys(styles).map(Number).map((id) => tree(id, id === primary, () => choosePrimary(id)))}</div>
      <div className="rune-row">{P.keystones.map((id) => rune(id, picks[0] === id, () => setAt(0, id), true))}</div>
      {P.rows.map((row, i) => (
        <div className="rune-row" key={i}>{row.map((id) => rune(id, picks[i + 1] === id, () => setAt(i + 1, id)))}</div>
      ))}

      <h4>Secondary tree (2 runes, different rows)</h4>
      <div className="row wrap">{P.allowedSubStyles.filter((id) => styles[id]).map((id) => tree(id, id === sub, () => chooseSub(id)))}</div>
      {S.rows.map((row, i) => (
        <div className="rune-row" key={i}>{row.map((id) => rune(id, picks[4] === id || picks[5] === id, () => chooseSecondary(id)))}</div>
      ))}

      <h4>Stat shards</h4>
      {P.shards.map((row, i) => (
        <div className="rune-row" key={i}>{row.map((id) => rune(id, picks[i + 6] === id, () => setAt(i + 6, id)))}</div>
      ))}

      <div className="row">
        <button disabled={props.busy} onClick={() => props.save(name.trim(), primary, sub, picks)}>
          Save page
        </button>
        <button onClick={props.cancel}>Cancel</button>
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<string, [string, string]> = {
  None: ["Waiting: not in a lobby", "idle"],
  Lobby: ["Waiting in a lobby", "idle"],
  Matchmaking: ["In queue", "active"],
  ReadyCheck: ["Match found", "hot"],
  ChampSelect: ["In champ select", "hot"],
  InProgress: ["In game", "idle"],
  WaitingForStats: ["Game over", "idle"],
  EndOfGame: ["Game over", "idle"],
};

function Switch(props: { on: boolean; set: (on: boolean) => void; big?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={props.on}
      className={`switch ${props.on ? "on" : ""} ${props.big ? "big" : ""}`}
      onClick={() => props.set(!props.on)}
    >
      <span />
    </button>
  );
}

function AutoPanel(props: {
  settings: AutoSettings;
  change: (p: Partial<AutoSettings>) => void;
  champions: Profile["champions"];
  portrait: (id: number) => string;
  phase: string;
  log: string[];
}) {
  const { settings: s, change } = props;
  const [label, tone] = !s.enabled
    ? ["Off", "off"]
    : PHASE_LABEL[props.phase] ?? [props.phase || "Starting...", props.phase ? "error" : "idle"];
  const nothingSet = !s.accept && !s.bans.length && !s.picks.length;

  return (
    <div className="auto">
      <section className="auto-hero card">
        <Switch big on={s.enabled} set={(enabled) => change({ enabled })} />
        <div>
          <h2>Auto champ select</h2>
          <p className="status-pill">
            <span className={`dot ${tone}`} />
            {label}
          </p>
          {s.enabled && nothingSet && <p className="fine">Turn on auto-accept or add champions below.</p>}
        </div>
      </section>

      <section className="auto-cards">
        <div className="card auto-card">
          <div className="auto-card-head">
            <h3>Accept match</h3>
            <Switch on={s.accept} set={(accept) => change({ accept })} />
          </div>
          <p className="muted">Accepts the match as soon as it is found.</p>
        </div>
        <div className="card auto-card">
          <div className="auto-card-head">
            <h3>Lock in</h3>
            <Switch on={s.lock} set={(lock) => change({ lock })} />
          </div>
          <p className="muted">
            {s.lock ? "Hovers right away, then locks in during the last 5 seconds of your turn, after teammates' picks are checked." : "Champions are hovered right away; you press Lock In."}
          </p>
        </div>
      </section>

      <ChampionList
        title="Ban"
        hint="Bans the first champion on this list that is still available and that no teammate has hovered."
        ids={s.bans}
        champions={props.champions}
        portrait={props.portrait}
        set={(bans) => change({ bans })}
      />
      <ChampionList
        title="Pick"
        hint="Picks the first champion that is available and not taken or hovered by a teammate."
        ids={s.picks}
        champions={props.champions}
        portrait={props.portrait}
        set={(picks) => change({ picks })}
      />

      <section className="card">
        <h3>Activity</h3>
        {props.log.length ? (
          <ul className="auto-log">
            {props.log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing yet. Actions appear here as they happen.</p>
        )}
      </section>

      <p className="fine">
        If you hover a champion yourself, auto mode leaves it alone. Auto-accept is common in approved apps; auto-pick,
        ban and lock use the client's unofficial API and may break Riot's rules. Use at your own risk.
      </p>
    </div>
  );
}

function ChampionList(props: {
  title: string;
  hint: string;
  ids: number[];
  champions: Profile["champions"];
  portrait: (id: number) => string;
  set: (ids: number[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const all = useMemo(
    () =>
      Object.entries(props.champions)
        .map(([id, c]) => ({ id: Number(id), name: c.name }))
        .filter((c) => isNormalChamp(c.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [props.champions]
  );
  const term = q.trim().toLowerCase();
  const results = all.filter((c) => !props.ids.includes(c.id) && c.name.toLowerCase().includes(term));
  const move = (i: number, by: number) => {
    const next = [...props.ids];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    props.set(next);
  };
  const add = (id: number) => {
    props.set([...props.ids, id]);
    setQ("");
  };

  return (
    <section className="card auto-list">
      <div className="auto-card-head">
        <h3>
          {props.title} <span className="fine">{props.ids.length ? `${props.ids.length} in order` : "off"}</span>
        </h3>
        <div className="row">
          {props.ids.length > 0 && <button onClick={() => props.set([])}>Clear</button>}
          <button className={onClass(adding)} onClick={() => setAdding(!adding)}>
            {adding ? "Done" : "+ Add champion"}
          </button>
        </div>
      </div>
      <p className="muted">{props.hint}</p>

      {props.ids.length > 0 && (
        <ol className="champ-order">
          {props.ids.map((id, i) => (
            <li key={id} className="champ-chip">
              <span className="rank">{i + 1}</span>
              {props.portrait(id) && <img src={props.portrait(id)} alt="" />}
              <span className="name">{props.champions[id]?.name ?? id}</span>
              <button title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button title="Move down" disabled={i === props.ids.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button title="Remove" onClick={() => props.set(props.ids.filter((x) => x !== id))}>
                ×
              </button>
            </li>
          ))}
        </ol>
      )}

      {adding && (
        <div className="champ-picker">
          <input
            className="search"
            autoFocus
            placeholder="Search champions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && results[0] && add(results[0].id)}
          />
          <div className="champ-grid">
            {results.map((c) => (
              <button key={c.id} className="champ-tile" title={c.name} onClick={() => add(c.id)}>
                {props.portrait(c.id) ? <img src={props.portrait(c.id)} alt="" loading="lazy" /> : null}
                <span>{c.name}</span>
              </button>
            ))}
            {!results.length && <p className="muted">No champions match.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

const STATUS_LABEL: Record<string, string> = { chat: "Online", away: "Away", mobile: "Mobile", offline: "Offline" };

/** Your chat status as friends see it; "Offline" means appear offline. */
function StatusPicker(props: { value: string; busy: boolean; set: (a: string) => void }) {
  return (
    <label className="status-picker">
      <span className={`dot status-${props.value}`} />
      <select value={props.value} disabled={props.busy} onChange={(e) => props.set(e.target.value)}>
        {Object.entries(STATUS_LABEL).map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
        {!STATUS_LABEL[props.value] && <option value={props.value}>{props.value}</option>}
      </select>
    </label>
  );
}

/**
 * The custom message friends see under your name, one row per line. Click to edit.
 * Enter saves, Shift+Enter starts a new line, Escape cancels. The client stores
 * line breaks as carriage returns, so those are used when saving.
 */
function StatusMessage(props: { value: string; busy: boolean; save: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);
  const start = () => {
    setDraft(props.value);
    setEditing(true);
  };
  const save = () => {
    setEditing(false);
    // Blank text clears the message; anything else is saved as typed, so pixel art keeps its spacing.
    const text = toClientText(draft);
    const empty = text.replace(/[ \t\r]/g, "") === "";
    const next = empty ? "" : text;
    if (next !== props.value) props.save(next);
  };
  if (!editing) {
    const lines = props.value ? splitClientLines(props.value) : [];
    return (
      <button className="status-message" disabled={props.busy} onClick={start} title="Edit your status message">
        {lines.length ? (
          <span className="status-lines">
            {lines.map((line, i) => (
              <span className="status-line" key={i}>
                {line || NBSP}
              </span>
            ))}
          </span>
        ) : (
          "Set a status message"
        )}{" "}
        <span className="fine">✎</span>
      </button>
    );
  }
  return (
    <div className="status-message-edit">
      <textarea
        className="search status-edit"
        wrap="off"
        autoFocus
        rows={Math.min(24, Math.max(3, draft.split(/\r\n|\r|\n/).length + 1))}
        placeholder="What friends see under your name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.shiftKey) {
            // Shift+Enter: pad this line to the line width, then start a new line.
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: start, selectionEnd: end, value } = el;
            // Fill the line being finished to the line width, then start the next line.
            const lineStart = value.lastIndexOf("\n", start - 1) + 1;
            const insert = fillerFor(value.slice(lineStart, start)) + "\n" + LINE_INDENT;
            setDraft(value.slice(0, start) + insert + value.slice(end));
            setTimeout(() => el.setSelectionRange(start + insert.length, start + insert.length), 0);
          } else if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <div className="row">
        <button onClick={save}>Save</button>
        {props.value && (
          <button
            onClick={() => {
              setEditing(false);
              props.save("");
            }}
          >
            Clear
          </button>
        )}
        <button onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </div>
  );
}

/** The most characters across the slider. Wider art can be previewed, but the status box fits about 40. */
const ASCII_MAX_COLS = 60;
/** The width the picture starts at: the most the status box fits. */
const ASCII_DEFAULT_COLS = 40;
/** The longest side of the picture sent to the converter. The art is at most 60 characters wide, so more detail is wasted. */
const ASCII_PICTURE_PX = 512;

/** The picture as PNG bytes, scaled down and on a white background, for the converter on the Mac. */
function pictureBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be read as a picture."));
    };
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, ASCII_PICTURE_PX / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("This browser cannot read the picture."));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error("This browser cannot read the picture."));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, "image/png");
    };
    image.src = url;
  });
}

/** The character sets, as the site ascii-converter.github.io offers them. The keys are sent to the converter. */
const CHARACTER_SETS: [string, string][] = [
  ["standard", "Standard"],
  ["detailed", "Detailed"],
  ["blocks", "Blocks"],
  ["binary", "Binary"],
];

/** Drop a picture, choose its width, character set and shading, preview it as ASCII, and set it as your status. */
function AsciiArt(props: { busy: boolean; setStatus: (text: string) => void }) {
  const [cols, setCols] = useState(ASCII_DEFAULT_COLS);
  const [invert, setInvert] = useState(false);
  const [chars, setChars] = useState("standard");
  const [picture, setPicture] = useState<Uint8Array | null>(null);
  const [name, setName] = useState("");
  const [art, setArt] = useState<string[] | null>(null);
  const [problem, setProblem] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // The converter runs on the Mac, so each change of picture, width or shading asks it again. An
  // answer to an earlier setting is dropped.
  useEffect(() => {
    if (!picture) {
      setArt(null);
      return;
    }
    let current = true;
    invoke<string>("ascii_art", picture, { headers: { "x-cols": String(cols), "x-invert": invert ? "1" : "0", "x-chars": chars } })
      .then((text) => {
        if (!current) return;
        setProblem("");
        setArt(padArt(text.split("\n").filter((row) => row.length > 0)));
      })
      .catch((e) => {
        if (!current) return;
        setArt(null);
        setProblem(String(e));
      });
    return () => {
      current = false;
    };
  }, [picture, cols, invert, chars]);
  // A row wider than the status box would wrap onto a second line in the client, so it cannot be set.
  const tooWide = !!art && !fitsStatusBox(art);

  const load = (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    pictureBytes(file)
      .then((bytes) => {
        setName(file.name);
        setPicture(bytes);
      })
      .catch((e: Error) => setProblem(e.message));
  };

  return (
    <div className="ascii">
      <div
        className={`drop ${drag ? "on" : ""}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          load(e.dataTransfer.files[0]);
        }}
      >
        <p>{name ? `Picture: ${name}` : "Drop a picture here, or click to choose one"}</p>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => load(e.target.files?.[0])} />
      </div>

      <label className="ascii-option">
        Characters wide: {cols}
        <input type="range" min={10} max={ASCII_MAX_COLS} value={cols} onChange={(e) => setCols(Number(e.target.value))} />
      </label>
      <label className="ascii-option">
        Character set
        <select value={chars} onChange={(e) => setChars(e.target.value)}>
          {CHARACTER_SETS.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="auto-toggle">
        <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
        Invert (light becomes dark)
      </label>

      {problem && <p className="msg bad">{problem}</p>}

      {art && art.length > 0 && (
        <>
          <pre className="ascii-preview">{art.join("\n")}</pre>
          {tooWide && <p className="msg bad">Some rows are too wide for the status box. Choose a smaller width.</p>}
          <button disabled={props.busy || tooWide} onClick={() => props.setStatus(joinClientLines(art))}>
            Set as my status
          </button>
        </>
      )}
    </div>
  );
}
