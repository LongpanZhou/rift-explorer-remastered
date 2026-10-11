/**
 * Anonymous install count. Each install has a random ID, kept only on this Mac. The app
 * sends that ID to the counter at most once a day. Nothing else is sent: no name, no
 * account and no game data. Turning the switch off stops the sending.
 *
 * COUNTER_URL is the deployed counter's address (see usage-counter/README.md). The
 * VITE_USAGE_URL environment variable overrides it, e.g. for a local test. While both are
 * empty, nothing is sent and the count is not shown.
 */
const COUNTER_URL = "";
export const USAGE_URL: string = (import.meta.env.VITE_USAGE_URL || COUNTER_URL).replace(/\/+$/, "");

const ID_KEY = "rift-install-id";
const DAY_KEY = "rift-usage-day";
const OFF_KEY = "rift-usage-off";

const store = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage is blocked: the count just does not persist.
    }
  },
};

/** True when the user has turned the count off. */
export const usageOff = () => store.get(OFF_KEY) === "1";
export const setUsageOff = (off: boolean) => store.set(OFF_KEY, off ? "1" : "0");

function installId(): string {
  let id = store.get(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    store.set(ID_KEY, id);
  }
  return id;
}

/** Sends this install's ID once per day, unless the user has switched it off. */
export async function reportUse(): Promise<void> {
  if (!USAGE_URL || usageOff()) return;
  const today = new Date().toISOString().slice(0, 10);
  if (store.get(DAY_KEY) === today) return;
  const res = await fetch(`${USAGE_URL}/ping`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: installId() }),
  });
  if (res.ok) store.set(DAY_KEY, today);
}

/** The number of installs counted so far, or null when the counter is not set up. */
export async function fetchUserCount(): Promise<number | null> {
  if (!USAGE_URL) return null;
  const res = await fetch(`${USAGE_URL}/count`);
  const body = (await res.json()) as { users?: number };
  return typeof body.users === "number" ? body.users : null;
}
