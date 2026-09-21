import { access } from "node:fs/promises";
import { constants } from "node:fs";
import process from "node:process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract, hostSignals, type HostCapabilities } from "./src/contracts/host.js";
import { runRecordSchema, type RunRecord } from "./src/contracts/run.js";

const FORTRESS = "/home/g4f4r0/.bb/plugins/browse/host-data/browsers/fortress/v151.0.7908.0/linux-x64/tilion-fortress/tilion";
const runs = new Map<string, RunRecord>();
const setupError = (message: string, phase: "observe" | "cleanup" = "observe") => ({ code: "setup-required" as const, phase, message, retryable: false, details: [] });
function blockedRun(runId: string, routeHash: string, route: RunRecord["route"], now: number): RunRecord {
  return runRecordSchema.parse({ runId, routeHash, route, state: "blocked", revision: 1, queuePosition: null, activeController: false, currentActionId: null, currentCheckpointId: null, startedAt: now, updatedAt: now, finishedAt: now, deadlineAt: now + route.limits.maxRuntimeMs, error: setupError("TypeSafe Jev is unavailable: resolve a verified Infisical project, environment, path, and credential before a live run."), cleanup: { state: "completed", message: "No browser lease was acquired.", completedAt: now }, checkpoints: [] });
}
async function probe(hostId: string): Promise<HostCapabilities> {
  let fortressReady = false; try { await access(FORTRESS, constants.X_OK); fortressReady = true; } catch { /* setup-required */ }
  return { hostId, platform: { os: process.platform, arch: process.arch, nodeVersion: process.version }, browser: { state: fortressReady ? "ready" : "setup-required", provider: "fortress-cdp", instanceCount: 0, detail: fortressReady ? "Fortress executable found; no BB browser lease is active." : "Fortress executable is unavailable." }, desktop: { state: "setup-required", provider: "cua-driver", version: null, daemonRunning: false, accessibilityReady: false, captureReady: false, detail: "Native accessibility runtime is not ready." }, encoder: { state: "ready", ffmpegVersion: null, h264Encoders: [], detail: "Capture encoder is not probed by the bounded host slice." }, ocr: { state: "setup-required", provider: null, detail: "OCR is deferred." }, decisionProvider: { state: "setup-required", provider: "typesafe-jev", infisicalScopeVerified: false, detail: "Infisical project/environment/path and TypeSafe credential are required." }, probedAt: Date.now() };
}
export default experimental_defineHostEntry({
  contract: hostContract, experimental_signals: hostSignals,
  handlers: {
    "capabilities.probe": async (input) => probe(input.expectedHostId),
    "runs.start": async (input, context) => { context.signal.throwIfAborted(); const now = Date.now(); runs.set(input.runId, blockedRun(input.runId, input.routeHash, input.route, now)); await context.experimental_emitSignal("runChanged", { runId: input.runId, revision: 1 }); return { accepted: true as const, runId: input.runId }; },
    "runs.status": async (input) => { const run = runs.get(input.runId); if (run === undefined) throw new Error("Run not found"); return run; },
    "runs.cancel": async (input, context) => { const run = runs.get(input.runId); if (run === undefined) throw new Error("Run not found"); if (!["queued", "running", "awaiting_confirmation", "verifying"].includes(run.state)) return { accepted: false, run }; const now = Date.now(); const cancelled = runRecordSchema.parse({ ...run, state: "cancelled", revision: run.revision + 1, updatedAt: now, finishedAt: now, error: { code: "cancelled", phase: "cleanup", message: input.reason, retryable: false, details: [] }, cleanup: { state: "completed", message: null, completedAt: now } }); runs.set(input.runId, cancelled); await context.experimental_emitSignal("runChanged", { runId: input.runId, revision: cancelled.revision }); return { accepted: true, run: cancelled }; },
    "media.latest": async () => ({ frame: null }),
    "artifacts.readRange": async () => { throw new Error("Artifact not found"); },
  },
  dispose: async () => { runs.clear(); },
});
