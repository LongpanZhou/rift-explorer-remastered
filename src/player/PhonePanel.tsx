import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";

/** The phone page runs on this port on the local network. */
const PORT = 8787;

/** Starts the phone champ select page and shows a QR code to open it on a phone on the same Wi-Fi. */
export default function PhonePanel() {
  const [link, setLink] = useState("");
  const [qr, setQr] = useState("");
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const message = (e: unknown) => (e as { message?: string })?.message ?? String(e);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const ip: string = await invoke("phone_lan_ip");
      await invoke("phone_start", { port: PORT, passcode: code });
      const url = `http://${ip}:${PORT}/?k=${code}`;
      setQr(await QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: "#0f1419", light: "#ffffff" } }));
      setLink(url);
      setPasscode(code);
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
      setPasscode("");
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
        Scan the code with your phone to pick, lock and set spells during champ select. Your phone must be on the same
        Wi-Fi as this Mac, and this app must stay open. Nothing goes through the internet.
      </p>
      {!link ? (
        <button disabled={busy} onClick={start}>
          Start the phone page
        </button>
      ) : (
        <div className="phone-live">
          <img className="phone-qr" src={qr} alt="QR code for the phone page" />
          <div>
            <p>Passcode: <b className="phone-code">{passcode}</b></p>
            <p className="fine phone-link">{link}</p>
            <button disabled={busy} onClick={stop}>Stop</button>
          </div>
        </div>
      )}
      {error && <p className="notice">{error}</p>}
    </div>
  );
}
