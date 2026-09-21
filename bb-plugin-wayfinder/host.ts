import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { hostContract, hostSignals } from "./src/contracts/host.js";

const FOUNDATION_ONLY_MESSAGE =
  "Wayfinder host execution is a foundation stub and has no runnable adapter.";

function foundationOnly(): never {
  throw Object.assign(new Error(FOUNDATION_ONLY_MESSAGE), {
    name: "WayfinderFoundationOnlyError",
  });
}

/**
 * FOUNDATION STUB. It validates the final host contract but intentionally
 * performs no browser, desktop, filesystem, media, or artifact operation.
 */
export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    "capabilities.probe": async () => foundationOnly(),
    "runs.start": async () => foundationOnly(),
    "runs.status": async () => foundationOnly(),
    "runs.cancel": async () => foundationOnly(),
    "media.latest": async () => foundationOnly(),
    "artifacts.readRange": async () => foundationOnly(),
  },
  dispose: async () => undefined,
});
