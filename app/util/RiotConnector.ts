import path, { join, normalize } from "path";
import { EventEmitter } from "events";
import { exec, execFile } from "child_process";
import { existsSync, readFileSync } from "fs-extra";
import { parseDocument } from "yaml";
import { homedir, platform } from "os";

/**
 * Check if is windows other wise assume is macOS since that is the
 * only other supported OS.
 */
const IS_WIN: boolean = platform() === "win32";

/**
 * Name of running executable depending on if system is Windows or macOS.
 */
const RIOTCLIENT_PROCESS: string = IS_WIN
  ? "RiotClientServices.exe"
  : "RiotClientServices";

/**
 * Runs a process lookup. On Windows it is PowerShell without the user's profile and without
 * prompts, which starts several times faster than a plain `powershell` shell.
 */
function lookup(command: string, done: (error: Error | null, stdout: string, stderr: string) => void) {
  if (IS_WIN) {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }, done);
  } else {
    exec(command, done);
  }
}

/**
 * Finds the Riot client and League install folder. Emits "riotclient" with that folder.
 * @since 7.0.0
 */
export default class RiotConnector extends EventEmitter {
  leaguePath: string = "";

  _checkRiotClient() {
    if (platform() === "linux") {
      // The client runs under Wine (Lutris's default prefix); there is no process to read.
      const leaguePath = join(homedir(), "./Games/league-of-legends/drive_c/Riot Games/League of Legends");
      if (!existsSync(join(leaguePath, "lockfile"))) return;
      this.leaguePath = leaguePath;
      this.emit("riotclient", leaguePath);
      return;
    }
    /**
     * Get command based on platform.
     */
    const command: string = IS_WIN
      ? `(Get-CimInstance Win32_Process -Filter "name = '${RIOTCLIENT_PROCESS}'").CommandLine`
      : `ps x -o command= | grep '${RIOTCLIENT_PROCESS}'`;

    lookup(command, (error, stdout, stderr) => {
      if (error || !stdout || stderr) {
        return;
      }

      /**
       * Get string return and normalize it for processing.
       */
      let normalizedPath: string = normalize(stdout);

      /**
       * If Windows we need to slightly adjust.
       */
      if (IS_WIN) normalizedPath = normalizedPath.split(/[\n\r]/).join(" ");

      const match: RegExpMatchArray = normalizedPath.match(
        '"--priority-launch-path=(.*?)"'
      );

      /**
       * Check if there are any matches
       */
      if (!match) {
        const productMatch = normalizedPath.match(
          platform() !== "darwin"
            ? '--launch-product=(.*?)[ $"]'
            : '--upgrade-product=(.*?)[ $"\n]'
        );
        const patchlineMatch = normalizedPath.match(
          platform() !== "darwin"
            ? '--launch-patchline=(.*?)[ $"]'
            : '--upgrade-patchline=(.*?)[ $"\n]'
        );

        /**
         * The Riot Client was started without launch arguments (for example,
         * opened by hand). Use the running League client process instead.
         */
        if (!productMatch || !patchlineMatch) {
          this._leaguePathFromProcess();
          return;
        }
        const product = productMatch[1];
        const patchline = patchlineMatch[1];

        /**
         * There is no ProgramData folder on MacOS
         */
        let programData = process.env.ProgramData;
        if (platform() === "darwin") programData = "/Users/Shared";

        try {
          this.leaguePath = parseDocument(
            readFileSync(
              path.join(
                programData,
                "Riot Games",
                "MetaData",
                `${product}.${patchline}`,
                `${product}.${patchline}.product_settings.yaml`
              )
            ).toString()
          ).get("product_install_full_path");
        } catch (err) {
          console.error(`product settings not readable: ${err}`);
          this._leaguePathFromProcess();
          return;
        }

        if (platform() === "darwin")
          this.leaguePath = path.join(this.leaguePath, "Contents", "LoL");
      } else {
        this.leaguePath = path.dirname(match[1]);
      }
      this.emit("riotclient", this.leaguePath);
    });
  }

  /**
   * Finds the League client install folder from the running LeagueClient
   * process. Emits "riotclient" with that folder. Emits nothing when no League
   * client process is running.
   */
  _leaguePathFromProcess() {
    const command = IS_WIN
      ? `(Get-CimInstance Win32_Process -Filter "name = 'LeagueClient.exe'").ExecutablePath`
      : `ps x -o command= | grep 'LeagueClient.app/Contents/MacOS/LeagueClient' | grep -v grep`;
    lookup(command, (error, stdout) => {
      if (error || !stdout) return;
      const match = IS_WIN
        ? stdout.match(/(.*)\\LeagueClient\.exe/i)
        : stdout.match(/(\/.*\/Contents\/LoL)\/LeagueClient\.app\/Contents\/MacOS\/LeagueClient/);
      if (!match) return;
      this.leaguePath = match[1];
      this.emit("riotclient", this.leaguePath);
    });
  }
}
