import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Renderer check (T12): the App mounts under React 18, asks the Tauri command
// for the spec, and renders Swagger UI with it. The Tauri bridge and the CSS
// imports are stubbed; this runs without a browser or a League client.

const spec = {
  swagger: "2.0",
  info: { title: "render check", version: "16.20.824.8524" },
  paths: {
    "/lol-render/v1/check": {
      get: {
        summary: "Render check operation",
        responses: { "200": { description: "ok" } },
      },
    },
  },
  definitions: {},
};

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "player") throw { code: 2, message: "not running" };
    if (cmd !== "get_spec") throw new Error(`unexpected command ${cmd}`);
    return JSON.stringify(spec);
  },
}));
mock.module("swagger-ui-react/swagger-ui.css", () => ({}));
mock.module("./App.css", () => ({}));

let container: HTMLElement;
let root: Root;

beforeAll(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterAll(() => {
  root?.unmount();
  GlobalRegistrator.unregister();
});

async function waitFor(check: () => boolean, timeoutMs = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) return false;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  return true;
}

describe("App renders the spec with Swagger UI", () => {
  test("shows the operation from the spec and no Try it out control", async () => {
    const { default: App } = await import("../../src/App");
    root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    // Player mode opens first; with no client it shows the error and a Retry.
    expect(await waitFor(() => container.textContent!.includes("not running"))).toBe(true);

    const devButton = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Developer"
    )!;
    await act(async () => {
      devButton.click();
    });

    const shown = await waitFor(
      () => container.querySelector(".opblock") !== null
    );
    expect(shown).toBe(true);
    expect(container.textContent).toContain("Render check operation");
    expect(container.querySelector(".try-out__btn")).toBeNull();
  });
});
