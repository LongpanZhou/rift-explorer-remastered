/**
 * Builds the ASCII art converter (github.com/TheZoraiz/ascii-image-converter, Apache-2.0) for one
 * platform into src-tauri/binaries, where Tauri bundles it next to the app.
 *
 *   bun scripts/build-converter.ts [target-triple]    (defaults to this machine)
 */
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync } from "fs";
import { delimiter, join } from "path";

const VERSION = "v1.13.1";
const MODULE = "github.com/TheZoraiz/ascii-image-converter";

const PLATFORMS: Record<string, { goos: string; goarch: string; exe: string }> = {
  "aarch64-apple-darwin": { goos: "darwin", goarch: "arm64", exe: "" },
  "x86_64-apple-darwin": { goos: "darwin", goarch: "amd64", exe: "" },
  "x86_64-pc-windows-msvc": { goos: "windows", goarch: "amd64", exe: ".exe" },
  "x86_64-unknown-linux-gnu": { goos: "linux", goarch: "amd64", exe: "" },
};

const triple = process.argv[2] ?? execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const platform = PLATFORMS[triple];
if (!platform) throw new Error(`no converter build for ${triple}`);

const goEnv = (name: string) => execFileSync("go", ["env", name], { encoding: "utf8" }).trim();
const hostOs = goEnv("GOHOSTOS");
const hostArch = goEnv("GOHOSTARCH");
const gopath = goEnv("GOPATH").split(delimiter)[0];

// Installing for another OS or CPU than this machine's puts the binary in its own folder.
const cross = hostOs !== platform.goos || hostArch !== platform.goarch;
execFileSync("go", ["install", `${MODULE}@${VERSION}`], {
  stdio: "inherit",
  env: { ...process.env, GOOS: platform.goos, GOARCH: platform.goarch, CGO_ENABLED: "0" },
});

const built = join(gopath, "bin", ...(cross ? [`${platform.goos}_${platform.goarch}`] : []), `ascii-image-converter${platform.exe}`);
mkdirSync("src-tauri/binaries", { recursive: true });
const out = join("src-tauri/binaries", `ascii-image-converter-${triple}${platform.exe}`);
copyFileSync(built, out);
console.log(`converter ${VERSION} for ${triple} -> ${out}`);
