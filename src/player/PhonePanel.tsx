import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";

/** The phone page runs on this port on the local network. */
const PORT = 8787;

/** How often the running phone page is checked, and how many restarts a minute are tried. */
const CHECK_MS = 4000;
const RESTARTS_PER_MINUTE = 3;

/** What phone_status answers: "off", "ok", "stopped" or "not-answering", and why. */
interface PhoneHealth {
  state: string;
  reason: string;
}

/**
 * Starts the phone champ select page and shows a QR code to open it on a phone on the same Wi-Fi.
 * While it runs, it is checked every few seconds; a server that stopped or stopped answering is
 * started again on the same address, so the phone carries on, and the reason is shown.
 */
export default function PhonePanel({ checkMs = CHECK_MS }: { checkMs?: number } = {}) {
  const [link, setLink] = useState("");
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const restarts = useRef<number[]>([]);
  // The secret in the QR code's link. Each Start makes a new one; restarts keep it, so the phone stays signed in.
  const token = useRef("");
  // The port the page is on: PORT, or the next free one when that is taken. And this computer's address.
  const portInUse = useRef(PORT);
  const lanIp = useRef("");
  // Bumped by every start and stop. Async work that finishes after a newer start or a stop
  // (a stop pressed during "Starting...", the tab closing during a restart) is ignored, and a
  // server it started anyway is stopped: it must not keep the port alive behind the panel.
  const session = useRef(0);

  const message = (e: unknown) => (e as { message?: string })?.message ?? String(e);

  /**
   * Shows the link and QR code for the page, on the port it is on. The QR code carries the token;
   * the link shown does not. Nothing is shown when a newer start or a stop has taken over.
   */
  const showLink = async () => {
    const id = session.current;
    const address = `http://${lanIp.current}:${portInUse.current}/`;
    const qrCode = await QRCode.toDataURL(`${address}?t=${token.current}`, { margin: 1, width: 240, color: { dark: "#0f1419", light: "#ffffff" } });
    if (id !== session.current) return;
    setQr(qrCode);
    setLink(address);
  };

  const start = async () => {
    const id = ++session.current;
    setBusy(true);
    setError("");
    setNotice("");
    restarts.current = [];
    try {
      const address = await invoke<string>("phone_lan_ip");
      // Stopped or closed while looking up the address: do not start a server at all.
      if (id !== session.current) return;
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      const port = await invoke<number>("phone_start", { port: PORT, token: secret });
      if (id !== session.current) {
        // A stop or a newer start happened while this one was starting: do not leave its server running.
        await invoke("phone_stop").catch(() => {});
        return;
      }
      lanIp.current = address;
      token.current = secret;
      portInUse.current = port;
      await showLink();
    } catch (e) {
      if (id === session.current) setError(message(e));
    } finally {
      if (id === session.current) setBusy(false);
    }
  };

  const stop = async () => {
    ++session.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await invoke("phone_stop");
      setLink("");
      setQr("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  // Watch the running server; restart it when it stopped, a few times a minute at most.
  useEffect(() => {
    if (!link) return;
    let checking = false;
    let cancelled = false;
    const id = session.current;
    const timer = setInterval(async () => {
      if (checking || cancelled) return;
      checking = true;
      try {
        const health: PhoneHealth = await invoke("phone_status");
        if (cancelled || id !== session.current) return;
        if (health.state === "ok") return;
        // "off" means no server is tracked (for example, the last restart failed); it is not
        // healthy while this panel is showing a link, so it is started again like a stopped one.
        const reason = health.reason || "it was not running";
        const now = Date.now();
        restarts.current = restarts.current.filter((t) => now - t < 60_000);
        if (restarts.current.length >= RESTARTS_PER_MINUTE) {
          setLink("");
          setQr("");
          setNotice("");
          setError(`The phone page keeps stopping (${reason}). Start it again when the League client is ready.`);
          return;
        }
        restarts.current.push(now);
        setNotice(`The phone page stopped (${reason}). Restarting it...`);
        const before = portInUse.current;
        const next = await invoke<number>("phone_start", { port: before, token: token.current });
        if (cancelled || id !== session.current) {
          // Stopped or closed while this restart was starting: stop the server it just made.
          await invoke("phone_stop").catch(() => {});
          return;
        }
        portInUse.current = next;
        if (next === before) {
          setNotice(`The phone page stopped (${reason}) and was restarted. The phone reconnects by itself.`);
        } else {
          await showLink();
          setNotice(`The phone page stopped (${reason}) and restarted on port ${next}. Scan the QR code again.`);
        }
      } catch (e) {
        if (!cancelled && id === session.current) {
          setNotice(`The phone page stopped and could not be restarted: ${message(e)}. Retrying...`);
        }
      } finally {
        checking = false;
      }
    }, checkMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [link, checkMs]);

  // Stop the server when the panel closes, so it is not left running.
  useEffect(() => () => {
    ++session.current;
    invoke("phone_stop").catch(() => {});
  }, []);

  return (
    <div className="phone-panel">
      <p className="muted">
        Scan the code with your phone to see champ select, pick, lock and set spells, accept matches, queue up, switch mode or leave the lobby. Your phone must be on the same
        Wi-Fi as this computer, and this app must stay open. Keep this tab open too: switching to another tab stops the page. Nothing goes through the internet. Auto champ select turns off
        while this tab is open. The first time on Windows, a firewall prompt for lcu-sidecar may open behind this window: click Allow, then reload the page on your phone.
      </p>
      <button disabled={busy} onClick={link ? stop : start}>
        {busy && !link ? "Starting…" : link ? "Stop phone champ select" : "Phone champ select"}
      </button>
      {link && (
        <div className="phone-live">
          <img className="phone-qr" src={qr} alt="QR code for the phone page" />
          <div>
            <p className="fine phone-link">{link}</p>
          </div>
        </div>
      )}
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="notice">{error}</p>}
    </div>
  );
}
