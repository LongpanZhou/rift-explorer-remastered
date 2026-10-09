import createSpec from "./createSpec";
import { parse, type LockFile } from "./LockFileParser";
import {
  lcuClient,
  loadChallenges,
  loadProfile,
  setBackground,
  setIcon,
  setRegalia,
  setTitle,
  setTokens,
  ActionRefused,
  downloadAsset,
  loadRewards,
  claimReward,
  claimAllRewards,
  loadLoot,
  loadRunes,
  buyRunePage,
  editRunePage,
  autoTick,
  setStatus,
  setStatusMessage,
  loadLive,
  parseAutoArgs,
} from "./player";
import { classify, EXIT, findLockfile } from "./sidecar";

/**
 * Sidecar entry point. Prints JSON on stdout and nothing else. Logs and errors
 * go to stderr. Exit codes are in exitCodes.ts.
 *
 * Usage (options come before the command, so command arguments can never be
 * read as options):
 *   lcu-sidecar [--lockfile <path>]                  print the Swagger spec
 *   lcu-sidecar [--lockfile <path>] player <command> [args]
 *     profile | challenges
 *     set-icon <iconId>
 *     set-regalia <crestType> <bannerType> <prestigeCrest>
 *     set-background <skinId>
 *     set-tokens [challengeId ...]   (0 to 3)
 *     set-title <titleItemId>         (-1 clears the title)
 *     rewards | claim-reward <grantId> | claim-all
 *     loot
 *     runes
 *     edit-rune-page <pageId> <n+hexName> <primaryTree> <secondaryTree> <9 rune ids>
 *     live                             (icon, level, status, crest, banner, background)
 *     set-status chat|away|mobile|offline
 *     set-status-message <n+hexText>   ("n" clears it)
 *     auto-tick <accept 0|1> <lock 0|1> <bans 1-2|none> <picks 1-2|none>
 *     buy-rune-page IP|RP              (spends currency; refused unless the store offers it)
 *     download icon|skin <id>         (saves to ~/Downloads/Rift Explorer)
 */

type Client = ReturnType<typeof lcuClient>;
type Command = (client: Client, args: string[]) => Promise<unknown>;

/** Runs a write and reports success. Every write command returns { ok: true }. */
const written = async (run: () => Promise<unknown>) => {
  await run();
  return { ok: true };
};

/** The player commands. This table is the only list of commands. */
const COMMANDS: Record<string, Command> = {
  profile: (c) => loadProfile(c),
  challenges: (c) => loadChallenges(c),
  rewards: (c) => loadRewards(c),
  "claim-reward": (c, r) => written(() => claimReward(c, r[0] ?? "")),
  "claim-all": (c) => claimAllRewards(c),
  loot: (c) => loadLoot(c),
  runes: (c) => loadRunes(c),
  // <pageId> <name as n+hex> <primary> <sub> <9 rune ids>
  "edit-rune-page": (c, r) =>
    written(() => editRunePage(c, Number(r[0]), r[1] ?? "", Number(r[2]), Number(r[3]), r.slice(4).map(Number))),
  "set-status": (c, r) => written(() => setStatus(c, r[0] ?? "")),
  live: (c) => loadLive(c),
  // <text as n+hex>; "n" alone clears it
  "set-status-message": (c, r) => written(() => setStatusMessage(c, r[0] ?? "")),
  "auto-tick": (c, r) => autoTick(c, parseAutoArgs(r)),
  "buy-rune-page": (c, r) => buyRunePage(c, r[0] ?? ""),
  download: (c, r) => downloadAsset(c, r[0], Number(r[1])),
  "set-icon": (c, r) => written(() => setIcon(c, Number(r[0]))),
  "set-regalia": (c, r) => written(() => setRegalia(c, r[0], r[1], Number(r[2]))),
  "set-background": (c, r) => written(() => setBackground(c, Number(r[0]))),
  "set-tokens": (c, r) => written(() => setTokens(c, r.map(Number))),
  "set-title": (c, r) => written(() => setTitle(c, Number(r[0]))),
};

/** Runs one player command. */
async function runPlayer(lock: LockFile, [cmd, ...rest]: string[]): Promise<unknown> {
  const command = Object.prototype.hasOwnProperty.call(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!command) throw new ActionRefused(`unknown player command ${cmd}`);
  return command(lcuClient(lock), rest);
}

/** Reads leading `--option` flags; everything from the first other word on is positional. */
function parseArgs(argv: string[]): { lockfile?: string; positional: string[] } {
  let lockfile: string | undefined;
  let i = 0;
  while (argv[i]?.startsWith("--")) {
    if (argv[i] === "--lockfile") lockfile = argv[++i];
    i++;
  }
  return { lockfile, positional: argv.slice(i) };
}

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

async function main(): Promise<void> {
  // A failed lookup inside the connector would otherwise crash silently.
  process.on("uncaughtException", (err) => {
    const { code, message } = classify(err);
    fail(code, message);
  });

  const { lockfile, positional } = parseArgs(process.argv.slice(2));

  const lockfilePath = await findLockfile(lockfile).catch((err: any) =>
    fail(err.code ?? EXIT.REQUEST_FAILED, err.message ?? String(err))
  );
  const lock: LockFile = await parse(lockfilePath).catch((err: any) => fail(EXIT.LOCKFILE_MALFORMED, err.message));
  const work = positional[0] === "player" ? runPlayer(lock, positional.slice(1)) : createSpec(lock);
  const out = await work.catch((err) => {
    const { code, message } = classify(err);
    fail(code, message);
  });

  // Wait for the write to finish before exiting, or large output is cut off.
  process.stdout.write(JSON.stringify(out), () => process.exit(EXIT.OK));
}

main();
