import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";

/** The phone page runs on this port on the local network. */
const PORT = 8787;

/** Starts the phone champ select page and shows a QR code to open it on a phone on the same Wi-Fi. */
export default function PhonePanel() {
  const [link, setLink] = useState("");
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const message = (e: unknown) => (e as { message?: string })?.message ?? String(e);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const ip: string = await invoke("phone_lan_ip");
      await invoke("phone_start", { port: PORT });
      const url = `http://${ip}:${PORT}/`;
      setQr(await QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: "#0f1419", light: "#ffffff" } }));
      setLink(url);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError("");
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

  // Stop the server when the panel closes, so it is not left running.
  useEffect(() => () => {
    invoke("phone_stop").catch(() => {});
  }, []);

  return (
    <div className="phone-panel">
      <p className="muted">
        Scan the code with your phone to see champ select, pick, lock and set spells, accept matches, queue up, switch mode or leave the lobby. Your phone must be on the same
        Wi-Fi as this computer, and this app must stay open. Nothing goes through the internet. Auto champ select turns off
        while this tab is open. On Windows, allow lcu-sidecar through the firewall when asked.
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
      {error && <p className="notice">{error}</p>}
    </div>
  );
}
