import { lazy, Suspense, useEffect, useState } from "react";
import "./App.css";
import Player from "./player/Player";
import { USAGE_URL, fetchUserCount, reportUse, setUsageOff, usageOff } from "./usage";

const ApiDocs = lazy(() => import("./ApiDocs"));

type Mode = "player" | "developer";

const onClass = (active: boolean) => (active ? "on" : "");

export default function App() {
  const [mode, setMode] = useState<Mode>("player");
  // The docs load on first open, then stay mounted like Player, so switching
  // modes never reloads either one.
  const [docsOpened, setDocsOpened] = useState(false);
  // The anonymous install count, shown top right. Hidden until USAGE_URL is set.
  const [users, setUsers] = useState<number | null>(null);
  const [off, setOff] = useState(usageOff);
  useEffect(() => {
    reportUse().catch(() => {});
    fetchUserCount().then(setUsers).catch(() => {});
  }, []);
  return (
    <div className="app">
      <div className="modebar">
        <span className="brand">Rift Explorer Remastered</span>
        <button className={onClass(mode === "player")} onClick={() => setMode("player")}>
          Player
        </button>
        <button
          className={onClass(mode === "developer")}
          onClick={() => {
            setMode("developer");
            setDocsOpened(true);
          }}
        >
          Developer
        </button>
        {USAGE_URL && (
          <>
            {users !== null && <span className="user-count">{users.toLocaleString()} users</span>}
            <label className="usage-opt" title="Sends one random install ID a day. Turn off to stop.">
              <input
                type="checkbox"
                checked={!off}
                onChange={(e) => {
                  setUsageOff(!e.target.checked);
                  setOff(!e.target.checked);
                }}
              />
              Count me
            </label>
          </>
        )}
      </div>
      <div hidden={mode !== "player"}>
        <Player active={mode === "player"} />
      </div>
      {docsOpened && (
        <div hidden={mode !== "developer"}>
          <Suspense fallback={<p className="status">Loading the API docs...</p>}>
            <ApiDocs />
          </Suspense>
        </div>
      )}
    </div>
  );
}
