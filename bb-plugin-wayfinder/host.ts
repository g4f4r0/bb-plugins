import { createServer, type Server } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
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
import { SingleControllerQueue } from "./src/core/controller-queue.js";
import { ActionJournal } from "./src/core/journal.js";
import { RunEngine } from "./worker/engine.js";
import { ObservedActionCatalog } from "./worker/action-catalog.js";
import { ArtifactStore, type PutArtifactInput } from "./src/artifacts/store.js";
import type { ArtifactRecord } from "./src/contracts/artifact.js";

const FORTRESS = "/home/g4f4r0/.bb/plugins/browse/host-data/browsers/fortress/v151.0.7908.0/linux-x64/tilion-fortress/tilion";
const FIXTURE = join(process.cwd(), "fixtures/browser/index.html");
const ARTIFACT_ROOT = "/tmp/wayfinder-host-artifacts";
const runs = new Map<string, RunRecord>();
const jobs = new Map<string, { abort: AbortController; process: ChildProcess | null; profile: string | null; server: Server | null; adapter: BrowserAdapter | null; artifact: ArtifactRecord | null }>();
let queue = new SingleControllerQueue({ leaseTtlMs: 30_000 });
const artifacts = new ArtifactStore({ root: ARTIFACT_ROOT, quotaBytes: 256 * 1024 * 1024, retentionMs: 30 * 24 * 60 * 60 * 1000 });
const artifactRecords = new Map<string, ArtifactRecord>();
const setupError = (message: string, phase: "observe" | "cleanup" = "observe") => ({ code: "setup-required" as const, phase, message, retryable: false, details: [] });

function update(run: RunRecord, patch: Partial<RunRecord>): RunRecord {
  const next = runRecordSchema.parse({ ...run, ...patch, revision: run.revision + 1, updatedAt: Date.now() });
  runs.set(run.runId, next); return next;
}
function initialRun(runId: string, routeHash: string, route: WayfinderRoute): RunRecord {
  const now = Date.now();
  return runRecordSchema.parse({ runId, routeHash, route, state: "queued", revision: 1, queuePosition: null, activeController: false, currentActionId: null, currentCheckpointId: null, startedAt: null, updatedAt: now, finishedAt: null, deadlineAt: now + route.limits.maxRuntimeMs, error: null, cleanup: { state: "pending", message: null, completedAt: null }, checkpoints: [] });
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
async function launch(route: WayfinderRoute, signal: AbortSignal) {
  const origin = route.browser.navigationOrigins.find((entry) => entry.purpose === "fixture")?.origin;
  if (origin !== "http://127.0.0.1:4173") throw wayfinderError("setup-required", "observe", "The bounded live slice only runs the committed local fixture at http://127.0.0.1:4173");
  const server = createServer(async (_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(await readFile(FIXTURE)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(4173, "127.0.0.1", resolve); });
  const profile = await mkdtemp("/tmp/wayfinder-fortress-");
  const probe = net.createServer(); await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => resolve()); });
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("Could not reserve a Fortress CDP port"); const cdpPort = address.port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(FORTRESS, ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--window-size=1280,800", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "http://127.0.0.1:4173/"], { stdio: "ignore", env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":99" } });
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
    const adapter = await BrowserAdapter.connectFortress({ route, hostId: route.identity.hostId, tabId: tab.id, resourceGeneration: `fortress_${Date.now()}`, wsEndpoint: ws, signal });
    return { server, profile, child, adapter };
  } catch (error) { child.kill("SIGTERM"); server.close(); await rm(profile, { recursive: true, force: true }).catch(() => undefined); throw error; }
}

async function execute(run: RunRecord): Promise<void> {
  const job = jobs.get(run.runId)!; const signal = job.abort.signal;
  try {
    const launched = await launch(run.route, signal); job.server = launched.server; job.profile = launched.profile; job.process = launched.child; job.adapter = launched.adapter;
    runs.set(run.runId, update(runs.get(run.runId)!, { state: "running", activeController: true, startedAt: Date.now() }));
    const journal = new ActionJournal(join(launched.profile, "journal.ndjson")); await journal.initialize();
    const engine = new RunEngine({ queue, journal, adapters: new Map([["browser", launched.adapter]]), provider: new FixtureProvider(), actionCatalog: new ObservedActionCatalog(), closeAdaptersOnFinish: false });
    const result = await engine.run({ runId: run.runId, route: run.route, signal, onProgress: (progress) => { const current = runs.get(run.runId); if (current) runs.set(run.runId, update(current, { state: progress.phase === "verify" ? "verifying" : "running", activeController: true, checkpoints: [...progress.checkpoints] })); } });
    let artifact: ArtifactRecord | null = null;
    try { const png = await launched.adapter.captureScreenshot(signal); const input: PutArtifactInput = { runId: run.runId, threadId: run.route.identity.threadId, projectId: run.route.identity.projectId, kind: "image", filename: "wayfinder-fixture.png", mimeType: "image/png", width: 1280, height: 800, durationMs: null, captureStartedAt: Date.now(), captureEndedAt: Date.now(), redacted: false, sanitized: true }; artifact = await artifacts.put(input, png); artifactRecords.set(artifact.artifactId, artifact); job.artifact = artifact; } catch { /* evidence capture is best effort after verification */ }
    const current = runs.get(run.runId)!; runs.set(run.runId, update(current, { state: result.state, activeController: false, finishedAt: Date.now(), error: result.error, cleanup: { state: "pending", message: null, completedAt: null }, checkpoints: result.checkpoints.map((checkpoint) => artifact ? { ...checkpoint, evidenceArtifactIds: [artifact.artifactId] } : checkpoint) }));
  } catch (error) {
    const current = runs.get(run.runId)!; const failure = error && typeof error === "object" && "code" in error ? error as RunRecord["error"] : setupError(error instanceof Error ? error.message : "Fortress run failed");
    runs.set(run.runId, update(current, { state: signal.aborted ? "cancelled" : "blocked", activeController: false, finishedAt: Date.now(), error: failure, cleanup: { state: "pending", message: null, completedAt: null } }));
  } finally { await cleanup(run.runId); }
}
async function cleanup(runId: string) { const job = jobs.get(runId); if (!job) return; try { if (job.adapter) await job.adapter.close({ signal: new AbortController().signal, expectedHostId: runs.get(runId)!.route.identity.hostId }); } catch { /* record below */ } if (job.process && !job.process.killed) job.process.kill("SIGTERM"); if (job.server) await new Promise<void>((resolve) => job.server!.close(() => resolve())); if (job.profile) { await new Promise((resolve) => setTimeout(resolve, 100)); await rm(job.profile, { recursive: true, force: true }).catch(() => undefined); } const run = runs.get(runId); if (run) runs.set(runId, update(run, { activeController: false, cleanup: { state: "completed", message: null, completedAt: Date.now() } })); jobs.delete(runId); }

async function probe(hostId: string): Promise<HostCapabilities> { let fortressReady = false; try { await access(FORTRESS, constants.X_OK); fortressReady = true; } catch { /* setup-required */ } return { hostId, platform: { os: process.platform, arch: process.arch, nodeVersion: process.version }, browser: { state: fortressReady ? "ready" : "setup-required", provider: "fortress-cdp", instanceCount: 0, detail: fortressReady ? "Fortress executable found; Wayfinder owns fresh profiles per run." : "Fortress executable is unavailable." }, desktop: { state: "setup-required", provider: "cua-driver", version: null, daemonRunning: false, accessibilityReady: false, captureReady: false, detail: "Native accessibility runtime is deferred." }, encoder: { state: "ready", ffmpegVersion: null, h264Encoders: [], detail: "Screenshot evidence uses Fortress PNG capture." }, ocr: { state: "setup-required", provider: null, detail: "OCR is deferred." }, decisionProvider: { state: "setup-required", provider: "typesafe-jev", infisicalScopeVerified: false, detail: "Infisical project/environment/path and TypeSafe credential are required for non-fixture runs." }, probedAt: Date.now() }; }

export default experimental_defineHostEntry({ contract: hostContract, experimental_signals: hostSignals, handlers: {
  "capabilities.probe": async (input) => probe(input.expectedHostId),
  "runs.start": async (input, context) => { context.signal.throwIfAborted(); if (runs.has(input.runId)) return { accepted: true as const, runId: input.runId }; const run = initialRun(input.runId, input.routeHash, input.route); runs.set(input.runId, run); const abort = new AbortController(); const job = { abort, process: null, profile: null, server: null, adapter: null, artifact: null }; jobs.set(input.runId, job); void execute(run); await context.experimental_emitSignal("runChanged", { runId: input.runId, revision: run.revision }); return { accepted: true as const, runId: input.runId }; },
  "runs.status": async (input) => { const run = runs.get(input.runId); if (!run) throw new Error("Run not found"); return run; },
  "runs.cancel": async (input, context) => { const run = runs.get(input.runId); if (!run) throw new Error("Run not found"); if (["passed", "failed", "blocked", "cancelled", "timed_out", "interrupted"].includes(run.state)) return { accepted: false, run }; jobs.get(input.runId)?.abort.abort(input.reason); const cancelled = update(run, { state: "cancelled", error: { code: "cancelled", phase: "cleanup", message: input.reason, retryable: false, details: [] } }); runs.set(input.runId, cancelled); await context.experimental_emitSignal("runChanged", { runId: input.runId, revision: cancelled.revision }); return { accepted: true, run: cancelled }; },
  "media.latest": async (input) => { const run = runs.get(input.runId); const artifact = run ? [...artifactRecords.values()].find((candidate) => candidate.runId === input.runId) : undefined; if (!artifact) return { frame: null }; const range = await artifacts.readRange(artifact, 0, artifact.media.sizeBytes - 1); return { frame: { sequence: 1, capturedAt: artifact.media.createdAt, mimeType: "image/png" as const, width: artifact.media.width ?? 1, height: artifact.media.height ?? 1, bytesBase64: range.bytes.toString("base64"), state: "live" as const } }; },
  "artifacts.readRange": async (input) => { const known = artifactRecords.get(input.artifactId); if (!known) throw new Error("Artifact not found"); const range = await artifacts.readRange(known, input.range.start, input.range.endInclusive); return { artifact: known, bytesBase64: range.bytes.toString("base64"), range: { start: range.start, endInclusive: range.endInclusive }, complete: range.endInclusive === known.media.sizeBytes - 1 }; },
}, dispose: async () => { for (const job of jobs.values()) job.abort.abort("dispose"); queue.close(); await Promise.all([...jobs.keys()].map((runId) => cleanup(runId))); runs.clear(); queue = new SingleControllerQueue({ leaseTtlMs: 30_000 }); }});
