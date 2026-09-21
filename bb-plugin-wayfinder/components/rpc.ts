import type { artifactRpcExtensions } from "../src/artifacts/rpc-extensions.js";
import type { wayfinderRpcContract } from "../src/contracts/api.js";

/** Published frontend contract plus the proposed artifact extensions (see rpc-extensions.ts). */
export type UiRpcContract = typeof wayfinderRpcContract & typeof artifactRpcExtensions;

/** Realtime channel the server publishes on when host `runChanged`/`artifactChanged` signals arrive. */
export const COMPUTER_REALTIME_CHANNEL = "computer";
