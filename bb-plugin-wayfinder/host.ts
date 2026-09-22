import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { Effect } from "effect";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { BrowserAdapter } from "./src/adapters/browser.js";
import { hostContract, hostSignals, type HostCapabilities } from "./src/contracts/host.js";
import { runRecordSchema, type RunRecord } from "./src/contracts/run.js";
import type { DecisionProvider, DecisionRequest, DecisionResponse } from "./src/contracts/adapter.js";
import type { WayfinderRoute } from "./src/contracts/route.js";
import { sha256 } from "./src/core/hash.js";
import { wayfinderError } from "./src/core/errors.js";
import { SingleControllerQueue, hostControllerQueue, disposeHostControllerQueue } from "./src/core/controller-queue.js";
import { ControlGate } from "./src/core/control-gate.js";
import { ActionJournal } from "./src/core/journal.js";
import { FIXTURE_HTML } from "./fixtures/browser/page.js";
import { RunEngine } from "./worker/engine.js";
import { ObservedActionCatalog } from "./worker/action-catalog.js";
import { ArtifactStore, type PutArtifactInput } from "./src/artifacts/store.js";
import type { ArtifactRecord } from "./src/contracts/artifact.js";
import { JevDecisionProvider } from "./src/adapters/jev.js";
import { createInfisicalClient, type InfisicalScope } from "./src/core/infisical.js";
import { resolveFortressExecutable } from "./src/core/browser-runtime.js";
const INFISICAL_SCOPE: InfisicalScope = {
  projectId: "bd53277c-43aa-4093-8aea-1e4040fc1962",
  env: "prod",
  path: "/",
};
const PROVIDER_KEY_NAME = { jev: "TYPESAFE_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
const infisical = createInfisicalClient();
let artifactRootPath: string | null = process.env.WAYFINDER_DATA_DIR ?? null;
let runRootPath: string | null = artifactRootPath === null ? null : join(artifactRootPath, "runs");
const runs = new Map<string, RunRecord>();
const jobs = new Map<string, { abort: AbortController; process: ChildProcess | null; profile: string | null; server: Server | null; adapter: BrowserAdapter | null; artifact: ArtifactRecord | null; emit: Emit; capture: Promise<Buffer> | null; controlGate: ControlGate }>();
type Emit = (signal: "runChanged" | "frameAvailable" | "artifactChanged", payload: Record<string, unknown>) => void;
let queue = hostControllerQueue("wayfinder-host");
let artifacts: ArtifactStore | null = artifactRootPath === null ? null : new ArtifactStore({ root: artifactRootPath, quotaBytes: 256 * 1024 * 1024, retentionMs: 30 * 24 * 60 * 60 * 1000 });
function ensureStorage(dataDir: string): void {
  if (artifactRootPath !== null) return;
  artifactRootPath = join(dataDir, "artifacts");
  runRootPath = join(artifactRootPath, "runs");
  artifacts = new ArtifactStore({ root: artifactRootPath, quotaBytes: 256 * 1024 * 1024, retentionMs: 30 * 24 * 60 * 60 * 1000 });
}
function artifactRoot(): string { if (artifactRootPath === null) throw new Error("Wayfinder host storage is not initialized"); return artifactRootPath; }
function runRoot(): string { if (runRootPath === null) throw new Error("Wayfinder host storage is not initialized"); return runRootPath; }
function artifactStore(): ArtifactStore { if (artifacts === null) throw new Error("Wayfinder host storage is not initialized"); return artifacts; }
const artifactRecords = new Map<string, ArtifactRecord>();
const liveFrames = new Map<string, { sequence: number; capturedAt: number; bytes: Buffer }>();
const setupError = (message: string, phase: "observe" | "cleanup" = "observe") => ({ code: "setup-required" as const, phase, message, retryable: false, details: [] });
function persistRun(run: RunRecord): void {
  const root = runRoot();
  void mkdir(root, { recursive: true, mode: 0o700 }).then(() => writeFile(join(root, `${run.runId}.json`), JSON.stringify(run), { mode: 0o600 })).catch(() => undefined);
}
function loadRun(runId: string): RunRecord | undefined {
  try { return runRecordSchema.parse(JSON.parse(readFileSync(join(runRoot(), `${runId}.json`), "utf8"))); } catch { return undefined; }
}

function update(run: RunRecord, patch: Partial<RunRecord>): RunRecord {
  const next = runRecordSchema.parse({ ...run, ...patch, revision: run.revision + 1, updatedAt: Date.now() });
  runs.set(run.runId, next); persistRun(next); jobs.get(run.runId)?.emit("runChanged", { runId: run.runId, revision: next.revision }); return next;
}
function initialRun(runId: string, routeHash: string, route: WayfinderRoute): RunRecord {
  const now = Date.now();
  const run = runRecordSchema.parse({ runId, routeHash, route, state: "queued", revision: 1, queuePosition: null, activeController: false, currentActionId: null, currentCheckpointId: null, startedAt: null, updatedAt: now, finishedAt: null, deadlineAt: now + route.limits.maxRuntimeMs, error: null, cleanup: { state: "pending", message: null, completedAt: null }, checkpoints: [] });
  persistRun(run); return run;
}

class FixtureProvider implements DecisionProvider {
  decide(request: DecisionRequest) {
    const operation = request.operationChoices.find((choice) => choice.choiceId === "op_browser_click") ?? request.operationChoices[0];
    if (!operation) throw wayfinderError("provider-unavailable", "decide", "No bounded fixture operation was offered");
    const target = request.targetChoices.find((choice) => /create local report/iu.test(choice.label)) ?? request.targetChoices[0];
    const response: DecisionResponse = {
      operationChoiceId: operation.choiceId,
      targetChoiceId: target?.choiceId ?? null,
      operationProbabilities: [{ choiceId: operation.choiceId, probability: 1 }],
      targetProbabilities: target ? [{ choiceId: target.choiceId, probability: 1 }] : [],
      confidence: 1, providerModel: "wayfinder-deterministic-fixture", latencyMs: 0,
    };
    return Effect.succeed(response);
  }
}

async function waitForJson(url: string, signal: AbortSignal, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try { const response = await fetch(url, { signal }); if (response.ok) return await response.json() as Record<string, unknown>; } catch { /* launch settling */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw wayfinderError("provider-unavailable", "observe", "Fortress CDP endpoint did not become ready", { retryable: true });
}
async function launch(route: WayfinderRoute, signal: AbortSignal, controlGate: ControlGate) {
  const fortress = await resolveFortressExecutable();
  if (fortress === null) throw wayfinderError("setup-required", "observe", `Fortress is not installed for ${process.platform}/${process.arch}`);
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(FIXTURE_HTML); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture server did not expose a port");
  const fixtureOrigin = `http://127.0.0.1:${address.port}`;
  const root = artifactRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const profile = await mkdtemp(join(root, "profiles-"));
  const probe = net.createServer(); await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => resolve()); });
  const probeAddress = probe.address(); if (!probeAddress || typeof probeAddress === "string") throw new Error("Could not reserve a Fortress CDP port"); const cdpPort = probeAddress.port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(fortress, ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--window-size=1280,800", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", `${fixtureOrigin}/`], { stdio: "ignore", env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":99" } });
  const abort = () => { child.kill("SIGTERM"); server.close(); void rm(profile, { recursive: true, force: true }).catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`, signal);
    const ws = version.webSocketDebuggerUrl;
    if (typeof ws !== "string") throw wayfinderError("provider-unavailable", "observe", "Fortress did not publish a CDP WebSocket");
    const port = new URL(ws).port;
    const tabs = await waitForJson(`http://127.0.0.1:${port}/json/list`, signal);
    const tab = Array.isArray(tabs) ? (tabs as unknown[]).find((entry) => typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "page") as { id?: unknown } | undefined : undefined;
    if (typeof tab?.id !== "string") throw wayfinderError("provider-unavailable", "observe", "Fortress did not expose a page target");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const adapter = await BrowserAdapter.connectFortress({ route, hostId: route.identity.hostId, tabId: tab.id, resourceGeneration: `fortress_${Date.now()}`, wsEndpoint: ws, signal, controlGate });
    return { server, profile, child, adapter, fixtureOrigin };
  } catch (error) { child.kill("SIGTERM"); server.close(); await rm(profile, { recursive: true, force: true }).catch(() => undefined); throw error; }
}

/** Resolves the decision provider's credential from the verified Infisical scope for this one call; never a static env var. */
export function jevProviderTarget(provider: "jev" | "openrouter", config?: { endpoint?: string | null; model?: string | null }): { endpoint: string; model: string } {
  return {
    endpoint: config?.endpoint ?? (provider === "openrouter"
      ? process.env.WAYFINDER_OPENROUTER_SYSTEMONE_ENDPOINT ?? "https://openrouter.ai/api/v1/systemone"
      : process.env.WAYFINDER_TYPESAFE_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone"),
    model: config?.model || (provider === "openrouter"
      ? process.env.WAYFINDER_OPENROUTER_JEV_MODEL ?? "~typesafe/jev-latest"
      : process.env.WAYFINDER_TYPESAFE_MODEL ?? "jev-latest"),
  };
}

async function providerFor(route: WayfinderRoute): Promise<DecisionProvider> {
  const selected = route.decisionProvider?.provider;
  if (!selected) throw wayfinderError("setup-required", "queue", "A decisionProvider must be explicitly selected; fixture mode is opt-in");
  if (selected === "fixture") return new FixtureProvider();
  const config = route.decisionProvider;
  const keyName = PROVIDER_KEY_NAME[selected];
  const apiKey = await infisical.resolveSecret(INFISICAL_SCOPE, keyName);
  if (apiKey === null) throw wayfinderError("setup-required", "queue", `Infisical secret ${keyName} did not resolve at the verified project/environment/path; confirm project membership and CLI authentication before a real provider run`);
  const target = jevProviderTarget(selected, config);
  return new JevDecisionProvider({ ...target, apiKey, maxCalls: route.limits.maxProviderCalls, maxApproxTokens: route.limits.maxProviderTokens, maxRetries: route.limits.maxRequestRetries });
}

/** One screenshot in flight per run; the engine's final capture and viewers share it. */
function capture(job: { adapter: BrowserAdapter | null; abort: AbortController; capture: Promise<Buffer> | null }): Promise<Buffer> {
  if (job.capture) return job.capture;
  const pending = job.adapter!.captureScreenshot(job.abort.signal).finally(() => { job.capture = null; });
  job.capture = pending; return pending;
}

async function execute(run: RunRecord): Promise<void> {
  const job = jobs.get(run.runId)!; const signal = job.abort.signal;
  let lease: Awaited<ReturnType<SingleControllerQueue["acquire"]>> | null = null;
  try {
    lease = await queue.acquire(run.runId, run.route.identity.threadId, signal);
    update(runs.get(run.runId)!, { queuePosition: null, activeController: true });
    const provider = await providerFor(run.route);
    const launched = await launch(run.route, signal, job.controlGate); job.server = launched.server; job.profile = launched.profile; job.process = launched.child; job.adapter = launched.adapter;
    runs.set(run.runId, update(runs.get(run.runId)!, { state: "running", activeController: true, startedAt: Date.now() }));
    const journal = new ActionJournal(join(artifactRoot(), "journals", `${run.runId}.ndjson`)); await journal.initialize();
    const effectiveRoute = JSON.parse(JSON.stringify(run.route)) as WayfinderRoute;
    for (const origin of effectiveRoute.browser.navigationOrigins) if (origin.purpose === "fixture") (origin as { origin: string }).origin = launched.fixtureOrigin;
    for (const origin of effectiveRoute.browser.resourceOrigins) if (origin.purpose === "fixture") (origin as { origin: string }).origin = launched.fixtureOrigin;
    for (const checkpoint of effectiveRoute.checkpoints) if (checkpoint.kind === "url" || checkpoint.kind === "network-outcome") if (checkpoint.origin === "http://127.0.0.1:4173") (checkpoint as { origin: string }).origin = launched.fixtureOrigin;
    const engine = new RunEngine({ queue, controllerLease: lease, journal, adapters: new Map([["browser", launched.adapter]]), provider, actionCatalog: new ObservedActionCatalog(), closeAdaptersOnFinish: false });
    const result = await engine.run({ runId: run.runId, route: effectiveRoute, signal, onProgress: (progress) => { const current = runs.get(run.runId); if (current) runs.set(run.runId, update(current, { state: progress.phase === "verify" ? "verifying" : "running", activeController: true, checkpoints: [...progress.checkpoints] })); } });
    let artifact: ArtifactRecord | null = null;
    try { const png = await capture(job); liveFrames.set(run.runId, { sequence: (liveFrames.get(run.runId)?.sequence ?? 0) + 1, capturedAt: Date.now(), bytes: png }); const input: PutArtifactInput = { runId: run.runId, threadId: run.route.identity.threadId, projectId: run.route.identity.projectId, kind: "image", filename: "wayfinder-fixture.png", mimeType: "image/png", width: 1280, height: 800, durationMs: null, captureStartedAt: Date.now(), captureEndedAt: Date.now(), redacted: false, sanitized: true }; artifact = await artifactStore().put(input, png); artifactRecords.set(artifact.artifactId, artifact); job.artifact = artifact; job.emit("artifactChanged", { runId: run.runId, artifactId: artifact.artifactId }); } catch { /* evidence capture is best effort after verification */ }
    const current = runs.get(run.runId)!; if (current.state !== "cancelled") update(current, { state: result.state, activeController: true, finishedAt: Date.now(), error: result.error, cleanup: { state: "pending", message: null, completedAt: null }, checkpoints: result.checkpoints.map((checkpoint) => artifact ? { ...checkpoint, evidenceArtifactIds: [artifact.artifactId] } : checkpoint) });
  } catch (error) {
    const current = runs.get(run.runId)!;
    const candidate = error && typeof error === "object" ? error as Record<string, unknown> : null;
    const failure = candidate && typeof candidate.code === "string" && typeof candidate.phase === "string" && typeof candidate.retryable === "boolean" && Array.isArray(candidate.details)
      ? candidate as RunRecord["error"]
      : setupError(error instanceof Error ? error.message : "Fortress run failed");
    if (current.state !== "cancelled") update(current, { state: signal.aborted ? "cancelled" : "blocked", activeController: true, finishedAt: Date.now(), error: failure, cleanup: { state: "pending", message: null, completedAt: null } });
  } finally { await cleanup(run.runId); lease?.release(); }
}
async function cleanup(runId: string) { const job = jobs.get(runId); if (!job) return; job.controlGate.dispose(); let failure: string | null = null; try { if (job.adapter) await job.adapter.close({ signal: new AbortController().signal, expectedHostId: runs.get(runId)!.route.identity.hostId }); } catch (error) { failure = error instanceof Error ? error.message : "Browser cleanup failed"; } if (job.process) { if (!job.process.killed) job.process.kill("SIGTERM"); let exited = job.process.exitCode !== null; await new Promise<void>((resolve) => { if (exited) return resolve(); const timer = setTimeout(resolve, 5_000); job.process!.once("exit", () => { exited = true; clearTimeout(timer); resolve(); }); }); if (!exited) failure = failure ?? "Fortress process did not exit before cleanup deadline"; } if (job.server) await new Promise<void>((resolve) => job.server!.close(() => resolve())); if (job.profile) await rm(job.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error) => { failure = failure ?? (error instanceof Error ? error.message : "Profile cleanup failed"); }); const run = runs.get(runId); if (run) runs.set(runId, update(run, { activeController: false, cleanup: { state: failure === null ? "completed" : "incomplete", message: failure, completedAt: failure === null ? Date.now() : null } })); jobs.delete(runId); }

async function probe(hostId: string, provider: "fixture" | "jev" | "openrouter"): Promise<HostCapabilities> {
  const fortressReady = await resolveFortressExecutable() !== null;
  const selected = provider === "fixture" ? "deterministic-fixture" : provider === "openrouter" ? "openrouter" : "typesafe-jev";
  const providerReady = provider === "fixture" || await infisical.secretConfigured(INFISICAL_SCOPE, PROVIDER_KEY_NAME[provider]).catch(() => false);
  return {
    hostId,
    platform: { os: process.platform, arch: process.arch, nodeVersion: process.version },
    browser: { state: fortressReady ? "ready" : "setup-required", provider: "fortress-cdp", instanceCount: jobs.size, detail: fortressReady ? "Fortress executable found; Wayfinder owns fresh profiles per run." : `Fortress is not installed for ${process.platform}/${process.arch}.` },
    desktop: { state: "setup-required", provider: "cua-driver", version: null, daemonRunning: false, accessibilityReady: false, captureReady: false, detail: `Native desktop support is not installed for ${process.platform}/${process.arch}.` },
    encoder: { state: "ready", ffmpegVersion: null, h264Encoders: [], detail: "Screenshot evidence uses Fortress PNG capture." },
    ocr: { state: "setup-required", provider: null, detail: "OCR is deferred." },
    decisionProvider: { state: providerReady ? "ready" : "setup-required", provider: selected, infisicalScopeVerified: providerReady, detail: providerReady ? `${selected} credential is available on this host.` : `${selected} credential is not configured on this host.` },
    probedAt: Date.now(),
  };
}

export default experimental_defineHostEntry({ contract: hostContract, experimental_signals: hostSignals, handlers: {
  "capabilities.probe": async (input) => probe(input.expectedHostId, input.provider),
  "runs.start": async (input, context) => { ensureStorage(context.experimental_paths.dataDir); context.signal.throwIfAborted(); if (runs.has(input.runId) || loadRun(input.runId)) return { accepted: true as const, runId: input.runId }; const run = initialRun(input.runId, input.routeHash, input.route); runs.set(input.runId, run); const abort = new AbortController(); const lease = context.experimental_retainWorker(); const emit: Emit = (signal, payload) => { void context.experimental_emitSignal(signal, payload as never).catch(() => undefined); }; const job = { abort, process: null, profile: null, server: null, adapter: null, artifact: null, emit, capture: null, controlGate: new ControlGate() }; jobs.set(input.runId, job); void execute(run).finally(() => lease.dispose()); emit("runChanged", { runId: input.runId, revision: run.revision }); return { accepted: true as const, runId: input.runId }; },
  "runs.status": async (input, context) => { ensureStorage(context.experimental_paths.dataDir); const run = runs.get(input.runId) ?? loadRun(input.runId); if (!run) throw new Error("Run not found"); runs.set(input.runId, run); return run; },
  "runs.cancel": async (input, context) => { ensureStorage(context.experimental_paths.dataDir); const run = runs.get(input.runId); if (!run) throw new Error("Run not found"); if (["passed", "failed", "blocked", "cancelled", "timed_out", "interrupted"].includes(run.state)) return { accepted: false, run }; jobs.get(input.runId)?.abort.abort(input.reason); const cancelled = update(run, { state: "cancelled", error: { code: "cancelled", phase: "cleanup", message: input.reason, retryable: false, details: [] } }); runs.set(input.runId, cancelled); await context.experimental_emitSignal("runChanged", { runId: input.runId, revision: cancelled.revision }); return { accepted: true, run: cancelled }; },
  "computer.control.acquire": async (input, context) => {
    ensureStorage(context.experimental_paths.dataDir);
    const job = jobs.get(input.runId);
    const run = runs.get(input.runId);
    if (!job?.adapter || !run || !["running", "verifying"].includes(run.state)) throw new Error("The computer is not ready for control");
    return { state: await job.controlGate.acquire(input.clientId, context.signal) };
  },
  "computer.control.release": async (input, context) => {
    ensureStorage(context.experimental_paths.dataDir);
    return { released: jobs.get(input.runId)?.controlGate.release(input.clientId) ?? false };
  },
  "computer.control.input": async (input, context) => {
    ensureStorage(context.experimental_paths.dataDir);
    const job = jobs.get(input.runId);
    if (!job?.adapter) throw new Error("The computer is not ready for input");
    await job.adapter.dispatchHumanInput(input.input, input.clientId, context.signal);
    return { accepted: true as const };
  },
  "media.latest": async (input, context) => { ensureStorage(context.experimental_paths.dataDir); const run = runs.get(input.runId); const job = jobs.get(input.runId); const previous = liveFrames.get(input.runId); if (!run) return { frame: null }; if (job?.adapter && ["queued", "running", "verifying"].includes(run.state)) { const png = await capture(job); const frame = { sequence: (previous?.sequence ?? 0) + 1, capturedAt: Date.now(), bytes: png }; liveFrames.set(input.runId, frame); job.emit("frameAvailable", { runId: input.runId, sequence: frame.sequence }); if (input.afterSequence !== null && frame.sequence <= input.afterSequence) return { frame: null }; return { frame: { sequence: frame.sequence, capturedAt: frame.capturedAt, mimeType: "image/png" as const, width: 1280, height: 800, bytesBase64: png.toString("base64"), state: "live" as const } }; } if (!previous) { const artifactId = run.checkpoints.flatMap((checkpoint) => checkpoint.evidenceArtifactIds).at(-1); const artifact = artifactId ? await artifactStore().getUnscoped(artifactId) : null; if (artifact && artifact.media.sizeBytes <= 1_048_576) { const bytes = (await artifactStore().readRange(artifact, 0, artifact.media.sizeBytes - 1)).bytes; return { frame: { sequence: 1, capturedAt: artifact.media.createdAt, mimeType: "image/png" as const, width: artifact.media.width ?? 1280, height: artifact.media.height ?? 800, bytesBase64: bytes.toString("base64"), state: "disconnected" as const } }; } } if (!previous) return { frame: null }; /* ended runs always report "disconnected" so a relay never serves a stale live frame */ return { frame: { sequence: previous.sequence, capturedAt: previous.capturedAt, mimeType: "image/png" as const, width: 1280, height: 800, bytesBase64: previous.bytes.toString("base64"), state: "disconnected" as const } }; },
  "artifacts.list": async (input, context) => { ensureStorage(context.experimental_paths.dataDir); return artifactStore().list({ threadId: input.threadId, runId: input.runId, cursor: input.cursor, limit: input.limit }); },
  "artifacts.get": async (input, context) => { ensureStorage(context.experimental_paths.dataDir); return artifactStore().get(input.artifactId, { threadId: input.threadId }); },
  "artifacts.readRange": async (input, context) => { ensureStorage(context.experimental_paths.dataDir); const known = artifactRecords.get(input.artifactId) ?? await artifactStore().getUnscoped(input.artifactId); if (!known) throw new Error("Artifact not found"); const range = await artifactStore().readRange(known, input.range.start, input.range.endInclusive); return { artifact: known, bytesBase64: range.bytes.toString("base64"), range: { start: range.start, endInclusive: range.endInclusive }, complete: range.endInclusive === known.media.sizeBytes - 1 }; },
}, dispose: async () => { for (const job of jobs.values()) job.abort.abort("dispose"); await Promise.all([...jobs.keys()].map((runId) => cleanup(runId))); disposeHostControllerQueue("wayfinder-host"); runs.clear(); queue = hostControllerQueue("wayfinder-host"); if (process.env.WAYFINDER_DATA_DIR === undefined) { artifactRootPath = null; runRootPath = null; artifacts = null; } }});
