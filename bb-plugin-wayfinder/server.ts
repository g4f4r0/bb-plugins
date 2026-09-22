import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { wayfinderRpcContract } from "./src/contracts/api.js";
import { hostContract, hostSignals } from "./src/contracts/host.js";
import { artifactHttpRoutes } from "./src/contracts/artifact.js";
import { routeSchema, type WayfinderRoute } from "./src/contracts/route.js";
import { entityIdSchema } from "./src/contracts/primitives.js";
import type { RunRecord } from "./src/contracts/run.js";
import { sha256 } from "./src/core/hash.js";
import { createInfisicalClient, type InfisicalScope } from "./src/core/infisical.js";
import { artifactErrorResponse, createInternalArtifactHandlers, type ArtifactChunkReader } from "./src/artifacts/http.js";
import { ArtifactError } from "./src/artifacts/errors.js";
import { artifactRpcExtensions } from "./src/artifacts/rpc-extensions.js";
import { LiveFrameRelay, createLiveFrameHandler, liveHttpRoutes } from "./src/media/live.js";
import {
  providerIdSchema,
  wayfinderSettingsRpcContract,
  type HostSummary,
  type ProviderId,
  type WayfinderSettingsState,
} from "./src/contracts/settings.js";

const COMPUTER_REALTIME_CHANNEL = "computer";
const RECENT_RUNS = 20;
export { wayfinderRpcContract as rpcContract };
export const FOUNDATION_ONLY_MESSAGE = "Wayfinder is configured for bounded execution; live Jev runs remain setup-required until Infisical scope is verified.";
const SHARE_DISABLED = "External sharing is disabled until a verified HTTPS export origin is configured";

const INFISICAL_SCOPE: InfisicalScope = {
  projectId: "bd53277c-43aa-4093-8aea-1e4040fc1962",
  env: "prod",
  path: "/",
};
const PROVIDER_KEY_NAME: Record<ProviderId, string> = { jev: "TYPESAFE_API_KEY", openrouter: "OPENROUTER_API_KEY" };
const PROVIDER_PROBE: Record<ProviderId, { url: string; header: string }> = {
  jev: { url: process.env.WAYFINDER_TYPESAFE_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone", header: "authorization" },
  openrouter: { url: "https://openrouter.ai/api/v1/auth/key", header: "authorization" },
};
const MAX_KEY_BODY_BYTES = 8 * 1024;
const saveKeyBodySchema = z.object({ provider: providerIdSchema, key: z.string().min(1).max(4_096) }).strict();
const testKeyBodySchema = z.object({ provider: providerIdSchema }).strict();
const saveSettingsBodySchema = z.object({ hostId: entityIdSchema.nullable(), provider: providerIdSchema, key: z.string().min(1).max(4_096).optional() }).strict();

const toolInput = z.object({ idempotencyKey: z.string().min(1).max(128), route: routeSchema }).strict();
type RunIndex = { hostId: string; threadId: string; routeHash: string };
type IdempotencyEntry = { runId: string; routeHash: string };

/** Reads a request body with a hard byte cap, never buffering past it. */
async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) throw new Error("Request body too large");
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error("Request body too large"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

/**
 * Trust boundary: the BB plugin SDK gives rpc and `auth: "local"` http handlers
 * no per-caller identity (BB is a single-user local app), and the frontend
 * supplies `threadId` itself. Thread scoping of artifact/run reads is therefore
 * a consistency filter for that one authenticated user, not a multi-user
 * authorization check. What is enforced: the agent tool takes its thread from
 * the trusted tool context, and every run's host/environment identity comes
 * from BB's own thread -> environment records, never from route input.
 */
/** `infisicalClient` is overridable only for tests; production always uses the real CLI-backed client. */
export default function plugin(bb: BbPluginApi, deps?: { infisicalClient?: ReturnType<typeof createInfisicalClient> }): void {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const kv = bb.storage.kv;
  const infisical = deps?.infisicalClient ?? createInfisicalClient();
  const publish = () => bb.realtime.publish(COMPUTER_REALTIME_CHANNEL, {});
  const hostOptions = (hostId: string, signal?: AbortSignal) => ({ hostId, timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) });
  for (const signal of ["runChanged", "frameAvailable", "artifactChanged"] as const) host.experimental_onSignal(signal, publish);

  const runIndex = (runId: string) => kv.get<RunIndex>(`run:${runId}`);
  const knownHosts = async () => (await kv.get<string[]>("hosts")) ?? [];

  /**
   * Wayfinder's own host/provider/model selection, distinct from `knownHosts`
   * (hosts that have actually run something). Only non-secret values ever
   * live here or in `bb.storage.kv`; the provider key itself is never
   * persisted anywhere BB controls — see the /settings/key http route.
   */
  type StoredSettings = { hostId: string | null; provider: ProviderId; model: string; lastTest: { ok: boolean; message: string; testedAt: number } | null };
  const DEFAULT_SETTINGS: StoredSettings = { hostId: null, provider: "openrouter", model: "", lastTest: null };
  const readStoredSettings = async (): Promise<StoredSettings> => (await kv.get<StoredSettings>("settings")) ?? DEFAULT_SETTINGS;
  const writeStoredSettings = (next: StoredSettings) => kv.set("settings", next);

  async function enrolledHosts(): Promise<HostSummary[]> {
    const hosts = await bb.sdk.hosts.list();
    return hosts.map((entry) => ({ hostId: entry.id, name: entry.name, status: entry.status, phase: entry.lifecycle.phase }));
  }

  /** Real check against the verified Infisical scope; never a cached/assumed boolean. */
  async function settingsState(): Promise<WayfinderSettingsState> {
    const stored = await readStoredSettings();
    const hosts = await enrolledHosts();
    const stillEnrolled = stored.hostId !== null && hosts.some((entry) => entry.hostId === stored.hostId);
    const keyName = PROVIDER_KEY_NAME[stored.provider];
    const configured = await infisical.secretConfigured(INFISICAL_SCOPE, keyName).catch(() => null);
    return {
      selectedHostId: stillEnrolled ? stored.hostId : null,
      provider: stored.provider,
      model: stored.model,
      keyStatus: configured === null ? "unknown" : configured ? "configured" : "missing",
      lastTest: stored.lastTest,
    };
  }
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
    const parsed = routeSchema.parse({ ...(requested as object), identity });
    const settings = await readStoredSettings();
    const route = parsed.decisionProvider?.provider === "fixture" ? parsed : routeSchema.parse({
      ...parsed,
      decisionProvider: { provider: settings.provider, model: settings.model, endpoint: null },
    });
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

  bb.rpc.register(wayfinderSettingsRpcContract, {
    "settings.hosts": () => enrolledHosts(),
    "settings.get": () => settingsState(),
    async "settings.selectHost"(input) {
      const stored = await readStoredSettings();
      if (input.hostId !== null) {
        const hosts = await enrolledHosts();
        if (!hosts.some((entry) => entry.hostId === input.hostId)) throw new Error("That host is not enrolled");
      }
      await writeStoredSettings({ ...stored, hostId: input.hostId });
      return settingsState();
    },
    async "settings.saveProvider"(input) {
      const stored = await readStoredSettings();
      await writeStoredSettings({ ...stored, provider: input.provider, model: input.model, lastTest: null });
      return settingsState();
    },
  });

  /**
   * A provider key never rides `bb.rpc` (no durable call-history surface for
   * a secret) or an agent tool. This is a narrowly scoped authenticated POST:
   * "local" auth checks Origin/Host and forces a JSON content-type
   * preflight; the body is read with an explicit byte cap and never logged.
   */
  bb.http.route("POST", "/settings/save", async (c) => {
    let parsed: z.infer<typeof saveSettingsBodySchema>;
    try {
      parsed = saveSettingsBodySchema.parse(await readBoundedJson(c.req.raw, MAX_KEY_BODY_BYTES));
    } catch {
      return jsonResponse({ ok: false, message: "Invalid settings" }, 400);
    }
    if (parsed.provider === "openrouter") {
      return jsonResponse({ ok: false, message: "Jev is not currently available through OpenRouter." }, 409);
    }
    if (parsed.hostId !== null) {
      const hosts = await enrolledHosts();
      if (!hosts.some((host) => host.hostId === parsed.hostId && host.status === "connected")) {
        return jsonResponse({ ok: false, message: "Select an available computer." }, 400);
      }
    }
    const keyName = PROVIDER_KEY_NAME[parsed.provider];
    if (parsed.key !== undefined) {
      const saved = await infisical.setSecret(INFISICAL_SCOPE, keyName, parsed.key).catch(() => false);
      if (!saved) return jsonResponse({ ok: false, message: "The API key could not be saved." }, 500);
    }
    const configured = await infisical.secretConfigured(INFISICAL_SCOPE, keyName).catch(() => false);
    if (!configured) return jsonResponse({ ok: false, message: "Enter a TypeSafe API key." }, 400);
    await writeStoredSettings({ hostId: parsed.hostId, provider: "jev", model: "jev-latest", lastTest: null });
    return jsonResponse({ ok: true, message: "Settings saved." });
  });

  bb.http.route("POST", "/settings/key", async (c) => {
    let parsed: z.infer<typeof saveKeyBodySchema>;
    try {
      parsed = saveKeyBodySchema.parse(await readBoundedJson(c.req.raw, MAX_KEY_BODY_BYTES));
    } catch {
      return jsonResponse({ ok: false, keyStatus: "unknown", message: "Invalid request" }, 400);
    }
    const keyName = PROVIDER_KEY_NAME[parsed.provider];
    const saved = await infisical.setSecret(INFISICAL_SCOPE, keyName, parsed.key).catch(() => false);
    const configured = saved ? await infisical.secretConfigured(INFISICAL_SCOPE, keyName).catch(() => false) : false;
    if (saved) {
      const stored = await readStoredSettings();
      if (stored.provider === parsed.provider) await writeStoredSettings({ ...stored, lastTest: null });
    }
    return jsonResponse({
      ok: saved && configured,
      keyStatus: saved && configured ? "configured" : "missing",
      message: saved && configured
        ? "Saved to the verified Infisical scope."
        : "Infisical did not accept the write; verify project membership and CLI authentication.",
    });
  });

  bb.http.route("POST", "/settings/key/test", async (c) => {
    let parsed: z.infer<typeof testKeyBodySchema>;
    try {
      parsed = testKeyBodySchema.parse(await readBoundedJson(c.req.raw, MAX_KEY_BODY_BYTES));
    } catch {
      return jsonResponse({ ok: false, status: 0, message: "Invalid request" }, 400);
    }
    const keyName = PROVIDER_KEY_NAME[parsed.provider];
    const probe = PROVIDER_PROBE[parsed.provider];
    const stored = await readStoredSettings();
    const body = parsed.provider === "jev" ? {
      model: stored.provider === "jev" && stored.model ? stored.model : "jev-latest",
      state: { wayfinder_probe: true },
      questions: { ready: { type: "choice", instructions: "Select the only readiness option.", criteria: { ready: "ready" } } },
    } : undefined;
    const tested = await infisical.testProviderKey(INFISICAL_SCOPE, keyName, probe.url, probe.header, body);
    const result = tested.status === 401 || tested.status === 403 ? {
      ...tested,
      message: parsed.provider === "jev"
        ? "TypeSafe rejected this key. Use a TypeSafe API key for Jev, not an OpenRouter key."
        : "OpenRouter rejected this key. Check the key and its permissions.",
    } : tested;
    const current = await readStoredSettings();
    if (current.provider === parsed.provider && current.model === stored.model) {
      await writeStoredSettings({ ...current, lastTest: { ok: result.ok, message: result.message, testedAt: Date.now() } });
    }
    return jsonResponse(result);
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
