import { Buffer } from "buffer";

// swagger-ui reads Node's `global` and `Buffer`, which a webview does not
// provide. Without them its bundle throws at load and the window stays blank.
// Import this module before swagger-ui.
const g = globalThis as unknown as { global?: unknown; Buffer?: typeof Buffer };
g.global ??= globalThis;
g.Buffer ??= Buffer;
