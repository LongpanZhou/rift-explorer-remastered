/**
 * The page a phone opens. Plain HTML and script, with no outside files, so it works on the
 * local network alone. Text from the client is written with textContent, never as HTML.
 */
export const PHONE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Champ select</title>
<style>
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #0f1419; color: #e6edf3; }
  header { padding: 12px 16px; background: #18202a; border-bottom: 1px solid #2a3542; position: sticky; top: 0; }
  header h1 { margin: 0; font-size: 17px; color: #c8aa6e; }
  main { padding: 12px 16px 40px; display: grid; gap: 14px; }
  section { background: #18202a; border: 1px solid #2a3542; border-radius: 8px; padding: 12px; }
  h2 { margin: 0 0 8px; font-size: 13px; color: #8b98a5; text-transform: uppercase; letter-spacing: .05em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 6px; }
  button { font: inherit; padding: 10px; border-radius: 6px; border: 1px solid #2a3542; background: #0f1419; color: #e6edf3; }
  button.on { border-color: #c8aa6e; color: #c8aa6e; }
  button.lock { background: #c8aa6e; color: #0f1419; border-color: #c8aa6e; font-weight: 600; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row > * { flex: 1; }
  select { font: inherit; padding: 8px; background: #0f1419; color: #e6edf3; border: 1px solid #2a3542; border-radius: 6px; }
  li { padding: 4px 0; border-bottom: 1px solid #2a3542; list-style: none; }
  ul { margin: 0; padding: 0; }
  .muted { color: #8b98a5; font-size: 13px; }
  .msg { min-height: 18px; font-size: 13px; color: #c8aa6e; }
  .warn { font-size: 12px; color: #8b98a5; }
</style>
</head>
<body>
<header><h1 id="status">Connecting...</h1></header>
<main>
  <section id="turn" hidden>
    <h2 id="turn-title">Your turn</h2>
    <div class="grid" id="options"></div>
    <div class="row" style="margin-top:10px">
      <button id="hover">Hover</button>
      <button id="lock" class="lock">Lock in</button>
    </div>
    <div class="msg" id="msg"></div>
  </section>

  <section>
    <h2>Your team</h2>
    <ul id="team"></ul>
  </section>

  <section>
    <h2>Bans</h2>
    <p class="muted" style="margin:0 0 4px">Yours</p>
    <ul id="bans-mine"></ul>
    <p class="muted" style="margin:8px 0 4px">Theirs</p>
    <ul id="bans-theirs"></ul>
  </section>

  <section>
    <h2>Enemy picks</h2>
    <ul id="enemies"></ul>
  </section>

  <section>
    <h2>Summoner spells</h2>
    <div class="row">
      <select id="spell1"></select>
      <select id="spell2"></select>
    </div>
    <div class="row" style="margin-top:10px"><button id="save-spells">Save spells</button></div>
    <div class="msg" id="spells-msg"></div>
  </section>

  <section>
    <h2>Champion swap</h2>
    <p class="warn">Not yet tested in a live game.</p>
    <div class="row">
      <input id="swap-id" inputmode="numeric" placeholder="swap id" style="font:inherit;padding:8px;background:#0f1419;color:#e6edf3;border:1px solid #2a3542;border-radius:6px" />
      <button id="swap-request">Request</button>
      <button id="swap-accept">Accept</button>
    </div>
    <div class="msg" id="swap-msg"></div>
  </section>
</main>
<script>
const KEY = new URLSearchParams(location.search).get("k") || "";
const SPELLS = [[4,"Flash"],[14,"Ignite"],[12,"Teleport"],[7,"Heal"],[6,"Ghost"],[21,"Barrier"],[1,"Cleanse"],[3,"Exhaust"],[11,"Smite"],[13,"Clarity"]];
let state = null, chosen = null;
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-passcode": KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "request failed");
  return data;
}
function fill(list, items) {
  list.replaceChildren(...(items.length ? items.map((t) => el("li", t)) : [el("li", "none yet", "muted")]));
}

function render() {
  if (!state) return;
  if (!state.inChampSelect) {
    $("status").textContent = "Not in champion select";
    $("turn").hidden = true;
    return;
  }
  $("status").textContent = "Champion select";
  const t = state.turn;
  $("turn").hidden = !t;
  if (t) {
    $("turn-title").textContent = t.type === "ban" ? "Your ban" : "Your pick";
    const opts = $("options");
    const keep = chosen && state.options.some((o) => o.id === chosen);
    if (!keep) chosen = null;
    opts.replaceChildren(...state.options.map((o) => {
      const b = el("button", o.name || "#" + o.id);
      if (o.id === chosen) b.className = "on";
      b.onclick = () => { chosen = o.id; render(); };
      return b;
    }));
  }
  fill($("team"), state.team.map((p) => (p.mine ? "You: " : "") + (p.champion || "not picked yet")));
  fill($("bans-mine"), state.bans.mine.filter(Boolean));
  fill($("bans-theirs"), state.bans.theirs.filter(Boolean));
  fill($("enemies"), state.enemies);
  if (state.spells) {
    for (const id of ["spell1", "spell2"]) {
      const sel = $(id);
      if (!sel.options.length) SPELLS.forEach(([v, n]) => sel.add(new Option(n, v)));
      sel.value = String(state.spells[id]);
    }
  }
}

async function refresh() {
  try {
    state = await api("/api/state");
    render();
  } catch (e) {
    $("status").textContent = e.message;
  }
}
async function choose(lock) {
  $("msg").textContent = "";
  if (!chosen) { $("msg").textContent = "Tap a champion first."; return; }
  try {
    await api("/api/choose", { championId: chosen, lock });
    $("msg").textContent = lock ? "Locked in." : "Hovered.";
    await refresh();
  } catch (e) { $("msg").textContent = e.message; }
}
$("hover").onclick = () => choose(false);
$("lock").onclick = () => choose(true);
$("save-spells").onclick = async () => {
  $("spells-msg").textContent = "";
  try {
    await api("/api/spells", { spell1: Number($("spell1").value), spell2: Number($("spell2").value) });
    $("spells-msg").textContent = "Saved.";
  } catch (e) { $("spells-msg").textContent = e.message; }
};
async function swap(action) {
  $("swap-msg").textContent = "";
  try {
    await api("/api/swap", { action, id: Number($("swap-id").value) });
    $("swap-msg").textContent = action === "request" ? "Requested." : "Accepted.";
  } catch (e) { $("swap-msg").textContent = e.message; }
}
$("swap-request").onclick = () => swap("request");
$("swap-accept").onclick = () => swap("accept");

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`;
