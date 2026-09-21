import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { wayfinderRpcContract } from "./src/contracts/api.js";
import { hostContract, hostSignals } from "./src/contracts/host.js";
import { artifactHttpRoutes } from "./src/contracts/artifact.js";
import { routeSchema, type WayfinderRoute } from "./src/contracts/route.js";
import type { RunRecord } from "./src/contracts/run.js";
import { sha256 } from "./src/core/hash.js";
import { artifactErrorResponse, createInternalArtifactHandlers, type ArtifactChunkReader } from "./src/artifacts/http.js";
import { ArtifactError } from "./src/artifacts/errors.js";
import { artifactRpcExtensions } from "./src/artifacts/rpc-extensions.js";
import { LiveFrameRelay, createLiveFrameHandler, liveHttpRoutes } from "./src/media/live.js";

const COMPUTER_REALTIME_CHANNEL = "computer";
const RECENT_RUNS = 20;
export { wayfinderRpcContract as rpcContract };
export const FOUNDATION_ONLY_MESSAGE = "Wayfinder is configured for bounded execution; live Jev runs remain setup-required until Infisical scope is verified.";
const SHARE_DISABLED = "External sharing is disabled until a verified HTTPS export origin is configured";

const toolInput = z.object({ idempotencyKey: z.string().min(1).max(128), route: routeSchema }).strict();
type RunIndex = { hostId: string; threadId: string; routeHash: string };
type IdempotencyEntry = { runId: string; routeHash: string };

/**
 * Trust boundary: the BB plugin SDK gives rpc and `auth: "local"` http handlers
 * no per-caller identity (BB is a single-user local app), and the frontend
 * supplies `threadId` itself. Thread scoping of artifact/run reads is therefore
 * a consistency filter for that one authenticated user, not a multi-user
 * authorization check. What is enforced: the agent tool takes its thread from
 * the trusted tool context, and every run's host/environment identity comes
 * from BB's own thread -> environment records, never from route input.
 */
export default function plugin(bb: BbPluginApi): void {
  bb.settings.define({
    hostId: { type: "string", label: "Computer host ID", description: "BB host ID of the shared computer that runs Wayfinder (see `bb host list`)." },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const kv = bb.storage.kv;
  const publish = () => bb.realtime.publish(COMPUTER_REALTIME_CHANNEL, {});
  const hostOptions = (hostId: string, signal?: AbortSignal) => ({ hostId, timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) });
  for (const signal of ["runChanged", "frameAvailable", "artifactChanged"] as const) host.experimental_onSignal(signal, publish);

  const runIndex = (runId: string) => kv.get<RunIndex>(`run:${runId}`);
  const knownHosts = async () => (await kv.get<string[]>("hosts")) ?? [];
  const requireRun = async (runId: string): Promise<RunIndex> => {
    const entry = await runIndex(runId);
    if (entry === undefined) throw new Error("Run not found");
    return entry;
  };

  /** Host and environment come from BB's thread record, not from caller input. */
  async function identityFor(threadId: string): Promise<WayfinderRoute["identity"]> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) throw new Error("This thread has no environment, so Wayfinder cannot pick a computer");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return { hostId: environment.hostId, threadId, projectId: thread.projectId, environmentId: environment.id };
  }

  const inflightStarts = new Map<string, Promise<{ runId: string; routeHash: string; deduplicated: boolean }>>();
  function startRun(threadId: string, idempotencyKey: string, requested: unknown, signal?: AbortSignal) {
    const key = `${threadId}:${idempotencyKey}`;
    const running = inflightStarts.get(key) ?? doStart(key, threadId, idempotencyKey, requested, signal).finally(() => inflightStarts.delete(key));
    inflightStarts.set(key, running);
    return running;
  }
  async function doStart(key: string, threadId: string, idempotencyKey: string, requested: unknown, signal?: AbortSignal) {
    const identity = await identityFor(threadId);
    const route = routeSchema.parse({ ...(requested as object), identity });
    const routeHash = sha256(route);
    const stored = await kv.get<IdempotencyEntry>(`idem:${key}`);
    if (stored !== undefined) {
      if (stored.routeHash !== routeHash) throw new Error(`Idempotency key "${idempotencyKey}" was already used for a different route`);
      return { runId: stored.runId, routeHash, deduplicated: true };
    }
    const runId = `run_${randomUUID().replaceAll("-", "")}`;
    await kv.set(`idem:${key}`, { runId, routeHash } satisfies IdempotencyEntry);
    await kv.set(`run:${runId}`, { hostId: identity.hostId, threadId, routeHash } satisfies RunIndex);
    try {
      await host.call("runs.start", { expectedHostId: identity.hostId, runId, routeHash, route }, hostOptions(identity.hostId, signal));
    } catch (error) {
      await kv.delete(`idem:${key}`);
      await kv.delete(`run:${runId}`);
      throw error;
    }
    const hosts = await knownHosts();
    if (!hosts.includes(identity.hostId)) await kv.set("hosts", [...hosts, identity.hostId]);
    await kv.set("recent", [runId, ...((await kv.get<string[]>("recent")) ?? [])].slice(0, RECENT_RUNS));
    publish();
    return { runId, routeHash, deduplicated: false };
  }

  async function hostStatus(runId: string): Promise<RunRecord> {
    const entry = await requireRun(runId);
    return host.call("runs.status", { expectedHostId: entry.hostId, runId }, hostOptions(entry.hostId));
  }

  bb.rpc.register(wayfinderRpcContract, {
    "runs.start": (input) => startRun(input.route.identity.threadId, input.idempotencyKey, input.route),
    "runs.status": (input) => hostStatus(input.runId),
    async "runs.cancel"(input) {
      const entry = await requireRun(input.runId);
      const result = await host.call("runs.cancel", { expectedHostId: entry.hostId, runId: input.runId, reason: input.reason }, hostOptions(entry.hostId));
      return result.run;
    },
    async "computer.snapshot"(input) {
      const readiness = await host.call("capabilities.probe", { expectedHostId: input.hostId }, hostOptions(input.hostId));
      const runs: RunRecord[] = [];
      for (const runId of (await kv.get<string[]>("recent")) ?? []) {
        const entry = await runIndex(runId);
        if (entry?.hostId !== input.hostId) continue;
        try { runs.push(await hostStatus(runId)); } catch { /* run expired on the host */ }
      }
      const queued = runs.filter((run) => run.state === "queued");
      return {
        hostId: input.hostId,
        readiness: (readiness.decisionProvider.state === "ready" ? "ready" : "setup-required") as "ready" | "setup-required",
        readinessMessage: readiness.decisionProvider.detail,
        activeRun: runs.find((run) => run.activeController) ?? null,
        queue: queued.map((run, index) => ({ runId: run.runId, threadId: run.route.identity.threadId, position: run.queuePosition ?? index + 1, enqueuedAt: run.updatedAt })),
        selectedRun: input.selectedRunId === null ? null : (runs.find((run) => run.runId === input.selectedRunId) ?? (await hostStatus(input.selectedRunId).catch(() => null))),
        connectionState: "connected" as const,
        frameSequence: null,
        frameCapturedAt: null,
        sampledAt: Date.now(),
      };
    },
    async "artifacts.list"(input) {
      const hosts = await knownHosts();
      const hostId = input.runId === null ? hosts[0] : (await runIndex(input.runId))?.hostId;
      if (hostId === undefined) return { artifacts: [], nextCursor: null };
      return host.call("artifacts.list", { expectedHostId: hostId, ...input }, hostOptions(hostId));
    },
    async "artifacts.createShare"() { throw new Error(SHARE_DISABLED); },
    async "artifacts.revokeShare"() { throw new Error("Share not found"); },
  });

  bb.rpc.register(artifactRpcExtensions, {
    async "artifacts.get"(input) {
      for (const hostId of await knownHosts()) {
        try { return await host.call("artifacts.get", { expectedHostId: hostId, ...input }, hostOptions(hostId)); } catch { /* another host */ }
      }
      throw new Error("Artifact not found");
    },
    "artifacts.shareStatus": () => ({ external: { state: "disabled" as const, reason: SHARE_DISABLED }, shares: [] }),
    async "artifacts.createShareScoped"() { throw new Error(SHARE_DISABLED); },
    async "artifacts.revokeShareScoped"() { throw new Error("Share not found"); },
  });

  const readChunk: ArtifactChunkReader = async (artifactId, start, endInclusive, signal) => {
    for (const hostId of await knownHosts()) {
      try {
        const chunk = await host.call("artifacts.readRange", { expectedHostId: hostId, artifactId, range: { start, endInclusive } }, hostOptions(hostId, signal));
        return { artifact: chunk.artifact, bytes: Buffer.from(chunk.bytesBase64, "base64"), start: chunk.range.start, endInclusive: chunk.range.endInclusive };
      } catch { /* not on this host */ }
    }
    throw new ArtifactError("not-found", "Artifact not found");
  };
  const artifactHandlers = createInternalArtifactHandlers(readChunk);
  bb.http.route("GET", artifactHttpRoutes.inline, (c) => artifactHandlers.inline(c.req.raw));
  bb.http.route("GET", artifactHttpRoutes.download, (c) => artifactHandlers.download(c.req.raw));

  const relay = new LiveFrameRelay({
    fetchLatest: async (runId, afterSequence, signal) => {
      const entry = await requireRun(runId);
      return (await host.call("media.latest", { expectedHostId: entry.hostId, runId, afterSequence }, hostOptions(entry.hostId, signal))).frame;
    },
  });
  const liveHandler = createLiveFrameHandler({ relay, authorize: async (runId) => (await runIndex(runId)) !== undefined });
  bb.http.route("GET", liveHttpRoutes.frame, (c) => liveHandler(c.req.raw).catch(artifactErrorResponse));

  bb.agents.registerTool({
    name: "wayfinder_start",
    description: "Start one bounded Wayfinder browser or filesystem verification run. The computer host and environment come from this thread, not from the route.",
    parameters: toolInput,
    execute: async (input, context): Promise<PluginAgentToolResult> => {
      const parsed = toolInput.parse(input);
      return JSON.stringify(await startRun(context.threadId, parsed.idempotencyKey, parsed.route, context.signal));
    },
  });
  bb.onDispose(() => { inflightStarts.clear(); });
}
