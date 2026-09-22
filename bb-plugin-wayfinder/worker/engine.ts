import { Effect } from "effect";

import type { ActionIntent, AdapterObservation, AutomationAdapter, DecisionProvider } from "../src/contracts/adapter.js";
import { actionIntentSchema, decisionRequestSchema, decisionResponseSchema } from "../src/contracts/adapter.js";
import type { Checkpoint, WayfinderRoute } from "../src/contracts/route.js";
import { routeSchema } from "../src/contracts/route.js";
import type { CheckpointResult, WayfinderError } from "../src/contracts/run.js";
import { SingleControllerQueue, type ControllerLease } from "../src/core/controller-queue.js";
import { errorMessage, wayfinderError } from "../src/core/errors.js";
import { opaqueId, sha256 } from "../src/core/hash.js";
import { ActionJournal } from "../src/core/journal.js";
import { assertActionAllowed } from "../src/policy/actions.js";
import type { ActionCatalog } from "./action-catalog.js";

export type EngineTerminalState = "passed" | "failed" | "blocked" | "cancelled" | "timed_out" | "interrupted";

export interface EngineRunResult {
  readonly runId: string;
  readonly state: EngineTerminalState;
  readonly checkpoints: readonly CheckpointResult[];
  readonly actions: number;
  readonly decisions: number;
  readonly error: WayfinderError | null;
  readonly cleanup: { readonly state: "completed" | "incomplete"; readonly message: string | null };
}

export interface EngineRunInput {
  readonly runId: string;
  readonly route: WayfinderRoute;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: { readonly phase: string; readonly actions: number; readonly decisions: number; readonly checkpoints: readonly CheckpointResult[] }) => void;
}

export interface RunEngineOptions {
  readonly queue: SingleControllerQueue;
  readonly journal: ActionJournal;
  readonly adapters: ReadonlyMap<AutomationAdapter["kind"], AutomationAdapter>;
  readonly provider: DecisionProvider;
  readonly actionCatalog: ActionCatalog;
  readonly minDecisionConfidence?: number;
  readonly closeAdaptersOnFinish?: boolean;
  readonly now?: () => number;
  readonly controllerLease?: ControllerLease;
}

function checkpointAdapter(checkpoint: Checkpoint): AutomationAdapter["kind"] | null {
  if (checkpoint.kind === "filesystem") return "filesystem";
  if (checkpoint.kind === "url" || checkpoint.kind === "network-outcome") return "browser";
  if (checkpoint.kind === "visible-text") return checkpoint.surface;
  if (checkpoint.kind === "control-state" || checkpoint.kind === "field-value") return checkpoint.target.surface;
  if (checkpoint.kind === "structured-value") {
    if (checkpoint.source.startsWith("browser-")) return "browser";
    if (checkpoint.source === "desktop-accessibility") return "desktop";
  }
  return null;
}

function asWayfinderError(error: unknown, phase: WayfinderError["phase"]): WayfinderError {
  if (error !== null && typeof error === "object" && "code" in error && "phase" in error && "message" in error) return error as WayfinderError;
  return wayfinderError("internal", phase, errorMessage(error));
}

async function runTypedEffect<A>(effect: Effect.Effect<A, WayfinderError>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === "Left") throw result.left;
  return result.right;
}

export class RunEngine {
  readonly #options: Required<Omit<RunEngineOptions, "now" | "controllerLease">> & { readonly now: () => number; readonly controllerLease?: ControllerLease };

  constructor(options: RunEngineOptions) {
    this.#options = {
      ...options,
      minDecisionConfidence: options.minDecisionConfidence ?? 0.35,
      closeAdaptersOnFinish: options.closeAdaptersOnFinish ?? true,
      now: options.now ?? Date.now,
    };
  }

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    const route = routeSchema.parse(input.route);
    const routePolicyHash = sha256(route);
    const existing = await this.#options.journal.uncertainIntents(input.runId);
    if (existing.length > 0) {
      return this.#result(input.runId, "interrupted", [], 0, 0,
        wayfinderError("uncertain-mutation", "act", "Run has a journaled action without a recorded outcome; automatic replay is forbidden"),
        { state: "completed", message: null });
    }
    const runController = new AbortController();
    const timeout = setTimeout(() => runController.abort("timeout"), Math.max(0, route.limits.maxRuntimeMs));
    const externalAbort = () => runController.abort(input.signal.reason ?? "cancelled");
    input.signal.addEventListener("abort", externalAbort, { once: true });
    let lease: ControllerLease | null = null;
    const cleanup: { state: "completed" | "incomplete"; message: string | null } = { state: "completed", message: null };
    let actions = 0;
    let decisions = 0;
    const results = new Map<string, CheckpointResult>();
    const recent: string[] = [];
    let noProgressRounds = 0;
    try {
      lease = this.#options.controllerLease ?? await this.#options.queue.acquire(input.runId, route.identity.threadId, runController.signal);
      while (true) {
        this.#throwIfAborted(runController.signal);
        lease.heartbeat();
        const selected = this.#selectAdapter(route, results);
        if (selected === null) return this.#result(input.runId, "passed", [...results.values()], actions, decisions, null, cleanup);
        const adapter = this.#options.adapters.get(selected);
        if (adapter === undefined) {
          return this.#result(input.runId, "blocked", [...results.values()], actions, decisions,
            wayfinderError("setup-required", "observe", `${selected} capability is not configured`), cleanup);
        }
        const context = { signal: runController.signal, expectedHostId: route.identity.hostId };
        const observation = await runTypedEffect(adapter.observe(context));
        if (observation.humanActivityDetected) {
          return this.#result(input.runId, "blocked", [...results.values()], actions, decisions,
            wayfinderError("stale-observation", "observe", "External human activity invalidated the observation", { retryable: true }), cleanup);
        }
        await this.#verifyAdapter(route, adapter, observation, context, results);
        input.onProgress?.({ phase: "verify", actions, decisions, checkpoints: [...results.values()] });
        if (route.checkpoints.every((checkpoint) => results.get(checkpoint.checkpointId)?.outcome === "pass")) {
          return this.#result(input.runId, "passed", [...results.values()], actions, decisions, null, cleanup);
        }
        const choices = this.#options.actionCatalog.choices(route, observation);
        if (choices.operationChoices.length === 0) {
          return this.#result(input.runId, "blocked", [...results.values()], actions, decisions,
            wayfinderError("setup-required", "decide", `No bounded ${selected} action can advance the unresolved checkpoints`), cleanup);
        }
        if (++decisions > route.limits.maxDecisions || decisions > route.limits.maxProviderCalls) {
          return this.#result(input.runId, "failed", [...results.values()], actions, decisions, wayfinderError("limit-exceeded", "decide", "Decision limit exceeded"), cleanup);
        }
        const request = decisionRequestSchema.parse({
          runId: input.runId,
          goal: route.goal,
          observation,
          operationChoices: choices.operationChoices,
          targetChoices: choices.targetChoices,
          recentOutcomeSummaries: recent,
        });
        const rawDecision = await runTypedEffect(this.#options.provider.decide(request, context));
        const parsedDecision = decisionResponseSchema.safeParse(rawDecision);
        if (!parsedDecision.success) {
          return this.#result(input.runId, "blocked", [...results.values()], actions, decisions,
            wayfinderError("provider-unavailable", "decide", "Decision provider returned an invalid bounded response"), cleanup);
        }
        const decision = parsedDecision.data;
        const operationIds = new Set(choices.operationChoices.map((choice) => choice.choiceId));
        const targetIds = new Set(choices.targetChoices.map((choice) => choice.choiceId));
        if (!operationIds.has(decision.operationChoiceId) || decision.operationProbabilities?.some((entry) => !operationIds.has(entry.choiceId))) {
          return this.#result(input.runId, "blocked", [...results.values()], actions, decisions,
            wayfinderError("provider-unavailable", "decide", "Decision provider selected an operation outside the bounded choices"), cleanup);
        }
        if ((decision.targetChoiceId !== null && !targetIds.has(decision.targetChoiceId)) || decision.targetProbabilities?.some((entry) => !targetIds.has(entry.choiceId))) {
          return this.#result(input.runId, "blocked", [...results.values()], actions, decisions,
            wayfinderError("provider-unavailable", "decide", "Decision provider selected a target outside the bounded choices"), cleanup);
        }
        if (decision.confidence !== null && decision.confidence < this.#options.minDecisionConfidence) {
          return this.#result(input.runId, "blocked", [...results.values()], actions, decisions,
            wayfinderError("ambiguous-target", "decide", "Jev confidence is below the configured execution threshold", { details: [{ key: "confidence", value: decision.confidence.toFixed(3) }] }), cleanup);
        }
        if (++actions > route.limits.maxActions) {
          return this.#result(input.runId, "failed", [...results.values()], actions, decisions, wayfinderError("limit-exceeded", "act", "Action limit exceeded"), cleanup);
        }
        const action = choices.resolve(decision);
        if (action.kind === "wait") {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { runController.signal.removeEventListener("abort", abort); resolve(); }, action.maxWaitMs);
            const abort = () => { clearTimeout(timer); reject(wayfinderError("cancelled", "act", "Wait cancelled")); };
            runController.signal.addEventListener("abort", abort, { once: true });
          });
          continue;
        }
        const intent = actionIntentSchema.parse({
          actionId: opaqueId("action"),
          runId: input.runId,
          routePolicyHash,
          observation: observation.identity,
          action,
          intentRecordedAt: this.#options.now(),
        });
        assertActionAllowed(route, intent, observation);
        await this.#options.journal.recordIntent(intent);
        let outcome;
        try {
          outcome = await runTypedEffect(adapter.execute(intent, context));
        } catch (error) {
          const failure = asWayfinderError(error, "act");
          if (["policy-denied", "stale-observation", "ambiguous-target", "setup-required"].includes(failure.code)) {
            await this.#options.journal.recordOutcome({ actionId: intent.actionId, state: "blocked", dispatchedAt: null, outcomeRecordedAt: this.#options.now(), summary: failure.message, postObservation: null, error: failure });
            return this.#result(input.runId, "blocked", [...results.values()], actions, decisions, failure, cleanup);
          }
          return this.#result(input.runId, "interrupted", [...results.values()], actions, decisions,
            wayfinderError("uncertain-mutation", "act", "Action failed after intent journaling; automatic replay is forbidden", { details: [{ key: "cause", value: failure.message }] }), cleanup);
        }
        await this.#options.journal.recordOutcome(outcome);
        recent.push(outcome.summary);
        if (recent.length > 20) recent.shift();
        if (outcome.state === "uncertain") {
          return this.#result(input.runId, "interrupted", [...results.values()], actions, decisions,
            outcome.error ?? wayfinderError("uncertain-mutation", "act", outcome.summary), cleanup);
        }
        const postHash = outcome.postObservation?.stateHash;
        noProgressRounds = postHash === observation.stateHash ? noProgressRounds + 1 : 0;
        if (noProgressRounds >= route.limits.maxNoProgressRounds) {
          return this.#result(input.runId, "failed", [...results.values()], actions, decisions,
            wayfinderError("limit-exceeded", "act", "No-progress limit exceeded"), cleanup);
        }
        input.onProgress?.({ phase: "act", actions, decisions, checkpoints: [...results.values()] });
      }
    } catch (error) {
      const failure = asWayfinderError(error, "act");
      const deadlineExceeded = runController.signal.aborted && runController.signal.reason === "timeout";
      const normalized = deadlineExceeded ? wayfinderError("timed-out", failure.phase, "Run deadline exceeded") : failure;
      const state: EngineTerminalState = normalized.code === "cancelled" ? "cancelled" : normalized.code === "timed-out" ? "timed_out" : normalized.code === "uncertain-mutation" ? "interrupted" : "failed";
      return this.#result(input.runId, state, [...results.values()], actions, decisions, normalized, cleanup);
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", externalAbort);
      lease?.release();
      if (this.#options.closeAdaptersOnFinish) {
        const closeController = new AbortController();
        const closeTimer = setTimeout(() => closeController.abort("timeout"), 5_000);
        const failures: string[] = [];
        for (const adapter of this.#options.adapters.values()) {
          try { await runTypedEffect(adapter.close({ signal: closeController.signal, expectedHostId: route.identity.hostId })); }
          catch (error) { failures.push(`${adapter.kind}: ${errorMessage(error)}`); }
        }
        clearTimeout(closeTimer);
        if (failures.length > 0) {
          cleanup.state = "incomplete";
          cleanup.message = failures.join("; ").slice(0, 1_000);
        }
      }
    }
  }

  async reconcileUncertain(runId?: string): Promise<readonly ActionIntent[]> {
    return this.#options.journal.uncertainIntents(runId);
  }

  async #verifyAdapter(
    route: WayfinderRoute,
    adapter: AutomationAdapter,
    observation: AdapterObservation,
    context: { signal: AbortSignal; expectedHostId: string },
    results: Map<string, CheckpointResult>,
  ): Promise<void> {
    for (const checkpoint of route.checkpoints) {
      if (checkpointAdapter(checkpoint) !== adapter.kind) continue;
      if (checkpoint.timing === "historical" && results.get(checkpoint.checkpointId)?.outcome === "pass") continue;
      const result = await runTypedEffect(adapter.verify(checkpoint, observation, context));
      results.set(checkpoint.checkpointId, result);
    }
  }

  #selectAdapter(route: WayfinderRoute, results: ReadonlyMap<string, CheckpointResult>): AutomationAdapter["kind"] | null {
    for (const checkpoint of route.checkpoints) {
      if (results.get(checkpoint.checkpointId)?.outcome !== "pass") {
        const adapter = checkpointAdapter(checkpoint);
        if (adapter !== null) return adapter;
      }
    }
    return null;
  }

  #throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw wayfinderError(signal.reason === "timeout" ? "timed-out" : "cancelled", "act", signal.reason === "timeout" ? "Run deadline exceeded" : "Run cancelled");
  }

  #result(runId: string, state: EngineTerminalState, checkpoints: readonly CheckpointResult[], actions: number, decisions: number, error: WayfinderError | null, cleanup: EngineRunResult["cleanup"]): EngineRunResult {
    return { runId, state, checkpoints, actions, decisions, error, cleanup };
  }
}
