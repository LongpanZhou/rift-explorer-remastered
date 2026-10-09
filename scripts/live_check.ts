/**
 * Release check (D9, item 4): runs the sidecar against a running, logged-in
 * League client and compares the result with the endpoint catalog.
 *
 * Usage: bun scripts/live_check.ts
 * Needs a running League client. Exits 1 if the check fails.
 */
import { join } from "path";
import { LCU_BUILD, LCU_ENDPOINTS } from "../app/util/endpointCatalog";

const SIDECAR = join(import.meta.dir, "..", "app", "util", "sidecar-main.ts");
const EXPECTED_ROUTES = LCU_ENDPOINTS.length;

const started = performance.now();
const proc = Bun.spawn(["bun", SIDECAR], { stdout: "pipe", stderr: "pipe" });
const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
const code = await proc.exited;
const elapsedMs = Math.round(performance.now() - started);

const problems: string[] = [];
if (code !== 0) {
  problems.push(`sidecar exited ${code}: ${stderr.trim()}`);
}

let spec: any = null;
if (code === 0) {
  try {
    spec = JSON.parse(stdout);
  } catch {
    problems.push("stdout is not valid JSON");
  }
}

if (spec) {
  if (spec.swagger !== "2.0") problems.push(`swagger is ${spec.swagger}`);
  if (spec.info?.version !== LCU_BUILD) {
    problems.push(
      `client build ${spec.info?.version} differs from catalog build ${LCU_BUILD}; regenerate the catalog`
    );
  }
  const paths = Object.keys(spec.paths);
  if (paths.length !== EXPECTED_ROUTES) {
    problems.push(`path count ${paths.length}, expected ${EXPECTED_ROUTES}`);
  }
  for (const entry of LCU_ENDPOINTS) {
    const ops = spec.paths[entry.path];
    if (!ops) {
      problems.push(`missing path ${entry.path}`);
      continue;
    }
    const got = Object.keys(ops).sort().join(",");
    const want = entry.methods.map((m) => m.toLowerCase()).sort().join(",");
    if (got !== want) problems.push(`${entry.path}: methods ${got}, expected ${want}`);
  }
}

console.log(
  `sidecar ${code === 0 ? "OK" : "FAILED"} in ${elapsedMs} ms, ` +
    `stdout ${stdout.length} bytes, ` +
    `${spec ? Object.keys(spec.paths).length : 0} paths`
);
if (problems.length) {
  console.log("problems:");
  for (const p of problems.slice(0, 20)) console.log(`  - ${p}`);
  if (problems.length > 20) console.log(`  ... ${problems.length - 20} more`);
  process.exit(1);
}
console.log("live check passed");
