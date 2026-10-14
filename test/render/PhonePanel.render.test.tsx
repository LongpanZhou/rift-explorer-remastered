import { GlobalRegistrator } from "@happy-dom/global-registrator";
// A browser for React, for this file only: other files need Bun's own fetch and Response.
const ownDom = !GlobalRegistrator.isRegistered;
if (ownDom) GlobalRegistrator.register();

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The Phone tab with the app's commands simulated: it watches the running phone page and
// restarts it when it stops, so the phone carries on; it gives up when it keeps stopping.

let health: { state: string; reason: string }[] = [];
const calls: string[] = [];
// The port the page reports it started on.
let startedOn = 8787;
mock.module("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: async (cmd: string) => {
    calls.push(cmd);
    if (cmd === "phone_lan_ip") return "192.168.1.20";
    if (cmd === "phone_start") return startedOn;
    if (cmd === "phone_status") return health.shift() ?? { state: "ok", reason: "" };
    return null;
  },
}));
mock.module("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64," } }));
const { default: PhonePanel } = await import("../../src/player/PhonePanel");

afterAll(async () => {
  if (ownDom) await GlobalRegistrator.unregister();
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  calls.length = 0;
  health = [];
  startedOn = 8787;
});

async function startPanel() {
  const box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
  await act(async () => root!.render(<PhonePanel checkMs={30} />));
  const button = box.querySelector("button")!;
  await act(async () => button.click());
  expect(box.textContent).toContain("http://192.168.1.20:8787/");
  return box;
}
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const starts = () => calls.filter((c) => c === "phone_start").length;

test("when 8787 is taken, the page starts on the next free port and the link says which", async () => {
  startedOn = 8788;
  const box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
  await act(async () => root!.render(<PhonePanel checkMs={30} />));
  await act(async () => box.querySelector("button")!.click());
  expect(box.textContent).toContain("http://192.168.1.20:8788/");
  expect(box.textContent).not.toContain("http://192.168.1.20:8787/");
  expect(box.textContent).not.toContain("?t=");
});

test("a phone page that stopped is started again on the same address, and the reason is shown", async () => {
  const box = await startPanel();
  health = [{ state: "stopped", reason: "exit code 1: lockfile not readable" }];
  await wait(120);
  expect(starts()).toBe(2);
  expect(box.textContent).toContain("The phone page stopped (exit code 1: lockfile not readable) and was restarted.");
  // Still showing the same link and the Stop button.
  expect(box.textContent).toContain("http://192.168.1.20:8787/");
  expect(box.textContent).toContain("Stop phone champ select");
});

test("a phone page that keeps stopping is given up after three restarts in a minute", async () => {
  const box = await startPanel();
  health = Array.from({ length: 6 }, () => ({ state: "not-answering", reason: "it stopped answering" }));
  await wait(400);
  expect(starts()).toBe(1 + 3);
  expect(box.textContent).toContain("The phone page keeps stopping (it stopped answering).");
  expect(box.textContent).toContain("Phone champ select");
  expect(box.textContent).not.toContain("http://192.168.1.20:8787/");
});

test("a healthy phone page is left alone", async () => {
  await startPanel();
  await wait(150);
  expect(starts()).toBe(1);
  expect(calls.filter((c) => c === "phone_status").length).toBeGreaterThan(2);
});
