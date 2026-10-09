import { lazy, Suspense, useState } from "react";
import "./App.css";
import Player from "./player/Player";

const ApiDocs = lazy(() => import("./ApiDocs"));

type Mode = "player" | "developer";

const onClass = (active: boolean) => (active ? "on" : "");

export default function App() {
  const [mode, setMode] = useState<Mode>("player");
  // The docs load on first open, then stay mounted like Player, so switching
  // modes never reloads either one.
  const [docsOpened, setDocsOpened] = useState(false);
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
