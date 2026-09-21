import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { wayfinderRpcContract } from "./src/contracts/api.js";
import { hostContract, hostSignals } from "./src/contracts/host.js";
import { artifactHttpRoutes } from "./src/contracts/artifact.js";
import { routeSchema } from "./src/contracts/route.js";
import { sha256 } from "./src/core/hash.js";
import { artifactErrorResponse } from "./src/artifacts/http.js";
const COMPUTER_REALTIME_CHANNEL = "computer";
export { wayfinderRpcContract as rpcContract };
export const FOUNDATION_ONLY_MESSAGE = "Wayfinder is configured for bounded execution; live Jev runs remain setup-required until Infisical scope is verified.";
const toolInput = z.object({ idempotencyKey: z.string().min(1).max(128), route: routeSchema }).strict();
const idempotency = new Map<string, { runId: string; routeHash: string; hostId: string }>();
export default function plugin(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const publish = () => bb.realtime.publish(COMPUTER_REALTIME_CHANNEL, {});
  const hostOptions = (hostId: string, signal?: AbortSignal) => ({ hostId, timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) });
  bb.rpc.register(wayfinderRpcContract, {
    async "runs.start"(input) { const routeHash = sha256(input.route); const key = `${input.route.identity.threadId}:${input.idempotencyKey}`; const prior = idempotency.get(key); if (prior !== undefined) return { runId: prior.runId, routeHash: prior.routeHash, deduplicated: true }; const runId = `run_${randomUUID().replaceAll("-", "")}`; await host.call("runs.start", { expectedHostId: input.route.identity.hostId, runId, routeHash, route: input.route }, hostOptions(input.route.identity.hostId)); idempotency.set(key, { runId, routeHash, hostId: input.route.identity.hostId }); publish(); return { runId, routeHash, deduplicated: false }; },
    async "runs.status"(input) { const entry = [...idempotency.values()].find((value) => value.runId === input.runId); if (entry === undefined) throw new Error("Run not found"); const run = await host.call("runs.status", { expectedHostId: entry.hostId, runId: input.runId }, hostOptions(entry.hostId)); return run; },
    async "runs.cancel"(input) { const entry = [...idempotency.values()].find((value) => value.runId === input.runId); if (entry === undefined) throw new Error("Run not found"); const run = await host.call("runs.status", { expectedHostId: entry.hostId, runId: input.runId }, hostOptions(entry.hostId)); const result = await host.call("runs.cancel", { expectedHostId: run.route.identity.hostId, runId: input.runId, reason: input.reason }, hostOptions(run.route.identity.hostId)); return result.run; },
    async "computer.snapshot"(input) { const readiness = await host.call("capabilities.probe", { expectedHostId: input.hostId }, hostOptions(input.hostId)); let activeRun = null; for (const runId of [...idempotency.values()].map((value) => value.runId)) { try { const run = await host.call("runs.status", { expectedHostId: input.hostId, runId }, hostOptions(input.hostId)); if (run.activeController) activeRun = run; } catch { /* another host */ } } let selectedRun = null; if (input.selectedRunId !== null) { try { selectedRun = await host.call("runs.status", { expectedHostId: input.hostId, runId: input.selectedRunId }, hostOptions(input.hostId)); } catch { selectedRun = null; } } return { hostId: input.hostId, readiness: (readiness.decisionProvider.state === "ready" ? "ready" : "setup-required") as "ready" | "setup-required", readinessMessage: readiness.decisionProvider.detail, activeRun, queue: [], selectedRun, connectionState: "connected" as const, frameSequence: null, frameCapturedAt: null, sampledAt: Date.now() }; },
    async "artifacts.list"() { return { artifacts: [], nextCursor: null }; },
    async "artifacts.createShare"() { throw new Error("External sharing is disabled until a verified HTTPS export origin is configured"); },
    async "artifacts.revokeShare"() { throw new Error("Share not found"); },
  });
  bb.http.route("GET", artifactHttpRoutes.inline, () => artifactErrorResponse(Object.assign(new Error("Artifact not found"), { code: "not-found" })));
  bb.http.route("GET", artifactHttpRoutes.download, () => artifactErrorResponse(Object.assign(new Error("Artifact not found"), { code: "not-found" })));
  bb.agents.registerTool({ name: "wayfinder_start", description: "Start one bounded Wayfinder browser or filesystem verification run.", parameters: toolInput, execute: async (input, context): Promise<PluginAgentToolResult> => { const parsed = toolInput.parse(input); const route = routeSchema.parse({ ...parsed.route, identity: { ...parsed.route.identity, threadId: context.threadId, projectId: context.projectId } }); const routeHash = sha256(route); const runId = `run_${randomUUID().replaceAll("-", "")}`; await host.call("runs.start", { expectedHostId: route.identity.hostId, runId, routeHash, route }, hostOptions(route.identity.hostId, context.signal)); idempotency.set(`${context.threadId}:${parsed.idempotencyKey}`, { runId, routeHash, hostId: route.identity.hostId }); publish(); return JSON.stringify({ runId, routeHash, deduplicated: false }); } });
  bb.onDispose(() => { idempotency.clear(); });
}
