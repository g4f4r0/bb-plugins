import type { BbPluginApi } from "@get-bb/plugin-sdk";

export { wayfinderRpcContract as rpcContract } from "./src/contracts/api.js";

export const FOUNDATION_ONLY_MESSAGE =
  "Wayfinder contains foundation contracts only. Execution and UI are not wired; do not deploy this generation.";

/**
 * FOUNDATION STUB. Step 4 replaces this with lifecycle, RPC, HTTP, and host
 * wiring after the engine and UI/media implementations have converged.
 */
export default function plugin(bb: BbPluginApi): void {
  bb.log.warn(FOUNDATION_ONLY_MESSAGE);
  bb.status.needsConfiguration(FOUNDATION_ONLY_MESSAGE);
}
