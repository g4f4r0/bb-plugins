import type { AdapterExecutionContext, DecisionProvider, DecisionRequest, DecisionResponse } from "../contracts/adapter.js";
import { decisionResponseSchema } from "../contracts/adapter.js";
import { errorMessage, wayfinderError } from "../core/errors.js";
import { sanitizeDecisionRequest } from "../policy/privacy.js";
import { adapterEffect } from "./effect.js";

const MAX_TYPESAFE_CHOICES = 240;

export interface JevProviderOptions {
  /** TypeSafe System One endpoint, normally https://api.typesafe.ai/v1/systemone. */
  readonly endpoint: string;
  readonly model: string;
  /** Injected in memory from a verified Infisical scope; never read from files here. */
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxCalls?: number;
  readonly maxApproxTokens?: number;
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface ProviderProbeResult {
  readonly state: "ready" | "setup-required" | "unavailable";
  readonly message: string;
}

interface ChoiceAnswer {
  readonly choice: string;
  readonly probabilities: ReadonlyArray<{ readonly choiceId: string; readonly probability: number }>;
  readonly confidence: number;
}

interface SystemOneResult {
  readonly answers: Record<string, unknown>;
  readonly latencyMs: number;
}

function criteria(choices: ReadonlyArray<{ choiceId: string; label: string }>): Record<string, string> {
  return Object.fromEntries(choices.map((choice) => [choice.choiceId, choice.label]));
}

function parseChoice(value: unknown, allowed: ReadonlySet<string>, name: string): ChoiceAnswer {
  if (value === null || typeof value !== "object") throw wayfinderError("provider-unavailable", "decide", `Jev omitted the ${name} choice`);
  const answer = value as { choice?: unknown; probabilities?: unknown; confidence?: unknown };
  if (typeof answer.choice !== "string" || !allowed.has(answer.choice)) throw wayfinderError("provider-unavailable", "decide", `Jev returned an invalid ${name} choice`);
  if (answer.probabilities === null || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) {
    throw wayfinderError("provider-unavailable", "decide", `Jev omitted ${name} probabilities`);
  }
  const probabilities = Object.entries(answer.probabilities as Record<string, unknown>).map(([choiceId, probability]) => {
    if (!allowed.has(choiceId) || typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw wayfinderError("provider-unavailable", "decide", `Jev returned invalid ${name} probabilities`);
    }
    return { choiceId, probability };
  });
  const confidence = typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
    ? answer.confidence
    : probabilities.find((entry) => entry.choiceId === answer.choice)?.probability;
  if (confidence === undefined || confidence < 0 || confidence > 1) throw wayfinderError("provider-unavailable", "decide", `Jev omitted ${name} confidence`);
  return { choice: answer.choice, probabilities, confidence };
}

export class JevDecisionProvider implements DecisionProvider {
  readonly #options: Required<Omit<JevProviderOptions, "fetchImpl">> & { readonly fetchImpl: typeof fetch };
  #calls = 0;
  #tokens = 0;

  constructor(options: JevProviderOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
      throw wayfinderError("setup-required", "decide", "TypeSafe System One endpoint must use HTTPS or explicit local loopback");
    }
    if (options.apiKey.trim().length === 0) throw wayfinderError("setup-required", "decide", "TypeSafe provider credential is missing");
    if (options.model.trim().length === 0) throw wayfinderError("setup-required", "decide", "TypeSafe Jev model is missing");
    this.#options = {
      ...options,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxResponseBytes: options.maxResponseBytes ?? 256_000,
      maxCalls: options.maxCalls ?? 400,
      maxApproxTokens: options.maxApproxTokens ?? 2_000_000,
      maxRetries: options.maxRetries ?? 0,
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  decide(request: DecisionRequest, context: AdapterExecutionContext) {
    return adapterEffect("decide", () => this.#decide(request, context));
  }

  async probe(signal: AbortSignal): Promise<ProviderProbeResult> {
    try {
      const result = await this.#systemOne(
        { wayfinder_probe: true },
        { ready: { type: "choice", instructions: "Select the only readiness option.", criteria: { ready: "ready" } } },
        signal,
      );
      const ready = parseChoice(result.answers.ready, new Set(["ready"]), "readiness");
      return ready.choice === "ready"
        ? { state: "ready", message: "TypeSafe System One completed a typed functional probe" }
        : { state: "unavailable", message: "TypeSafe System One returned an invalid readiness result" };
    } catch (error) {
      const message = errorMessage(error);
      return { state: /401|403|credential/iu.test(message) ? "setup-required" : "unavailable", message: `TypeSafe functional probe failed: ${message}`.slice(0, 1_000) };
    }
  }

  async #decide(rawRequest: DecisionRequest, context: AdapterExecutionContext): Promise<DecisionResponse> {
    const request = sanitizeDecisionRequest(rawRequest);
    const operationIds = new Set(request.operationChoices.map((choice) => choice.choiceId));
    const state = {
      goal: request.goal,
      observation: request.observation,
      recent_outcomes: request.recentOutcomeSummaries,
      operation_choices: request.operationChoices,
      target_choices: request.targetChoices,
    };
    const first = await this.#systemOne(state, {
      operation: {
        type: "choice",
        instructions: "Which supplied operation choice makes the most progress toward goal from observation? Select only a supplied ID; never generate an action or argument.",
        criteria: criteria(request.operationChoices),
      },
    }, context.signal);
    const operation = parseChoice(first.answers.operation, operationIds, "operation");
    let target: ChoiceAnswer | null = null;
    let latencyMs = first.latencyMs;
    const targetOperation = operation.choice.endsWith("_click") ? "click"
      : operation.choice.endsWith("_type") ? "type"
      : operation.choice.endsWith("_select") ? "select"
      : operation.choice.endsWith("_scroll") ? "scroll"
      : operation.choice.endsWith("_activate") ? "activate"
      : operation.choice.endsWith("_invoke_menu") ? "invoke-menu"
      : null;
    if (targetOperation !== null) {
      const eligibleTargetIds = new Set(request.observation.targets
        .filter((candidate) => candidate.allowedOperations.includes(targetOperation))
        .map((candidate) => `target_${candidate.targetId}`));
      const eligibleTargets = request.targetChoices.filter((choice) => eligibleTargetIds.has(choice.choiceId));
      if (eligibleTargets.length === 0) throw wayfinderError("provider-unavailable", "decide", "Jev selected an operation with no compatible bounded target");
      const groups = Array.from({ length: Math.ceil(eligibleTargets.length / MAX_TYPESAFE_CHOICES) }, (_, index) =>
        eligibleTargets.slice(index * MAX_TYPESAFE_CHOICES, (index + 1) * MAX_TYPESAFE_CHOICES));
      let selected = groups[0]!;
      let groupConfidence = 1;
      if (groups.length > 1) {
        const groupIds = new Set(groups.map((_, index) => `group_${index}`));
        const groupResult = await this.#systemOne(
          { ...state, target_choices: eligibleTargets },
          { target_group: { type: "choice", instructions: "Which supplied target group contains the target that best advances goal?", criteria: Object.fromEntries(groups.map((group, index) => [`group_${index}`, group.map((choice) => choice.label).slice(0, 12).join("; ")])) } },
          context.signal,
        );
        const group = parseChoice(groupResult.answers.target_group, groupIds, "target group");
        selected = groups[Number(group.choice.slice("group_".length))] ?? selected;
        groupConfidence = group.confidence;
        latencyMs += groupResult.latencyMs;
      }
      const targetResult = await this.#systemOne(
        { ...state, selected_operation: operation.choice, target_choices: selected },
        { target: { type: "choice", instructions: "For the selected operation, which compatible supplied target best advances goal? Select only a supplied ID.", criteria: criteria(selected) } },
        context.signal,
      );
      target = parseChoice(targetResult.answers.target, new Set(selected.map((choice) => choice.choiceId)), "target");
      target = { ...target, confidence: Math.min(groupConfidence, target.confidence) };
      latencyMs += targetResult.latencyMs;
    }
    return decisionResponseSchema.parse({
      operationChoiceId: operation.choice,
      targetChoiceId: target?.choice ?? null,
      operationProbabilities: operation.probabilities,
      targetProbabilities: target?.probabilities ?? [],
      confidence: Math.min(operation.confidence, target?.confidence ?? 1),
      providerModel: this.#options.model,
      latencyMs: Math.min(120_000, latencyMs),
    });
  }

  async #systemOne(state: unknown, questions: Record<string, unknown>, signal: AbortSignal): Promise<SystemOneResult> {
    const body = JSON.stringify({ state, model: this.#options.model, questions });
    const inputEstimate = Math.ceil(body.length / 4);
    for (let attempt = 0; attempt <= this.#options.maxRetries; attempt += 1) {
      if (++this.#calls > this.#options.maxCalls) throw wayfinderError("limit-exceeded", "decide", "TypeSafe provider call limit exceeded");
      if (this.#tokens + inputEstimate > this.#options.maxApproxTokens) throw wayfinderError("limit-exceeded", "decide", "TypeSafe provider token limit exceeded");
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort("timeout"), this.#options.timeoutMs);
      const abort = () => timeout.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const startedAt = Date.now();
      try {
        const response = await this.#options.fetchImpl(this.#options.endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${this.#options.apiKey}`, "content-type": "application/json" },
          body,
          signal: timeout.signal,
        });
        const text = await response.text();
        if (Buffer.byteLength(text) > this.#options.maxResponseBytes) throw wayfinderError("limit-exceeded", "decide", "TypeSafe response exceeded the output limit");
        let parsed: { answers?: unknown; usage?: { input_tokens?: unknown } };
        try { parsed = JSON.parse(text) as typeof parsed; }
        catch { throw wayfinderError("provider-unavailable", "decide", "TypeSafe returned invalid JSON"); }
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < this.#options.maxRetries) continue;
          throw wayfinderError("provider-unavailable", "decide", `TypeSafe System One returned HTTP ${response.status}`, { retryable });
        }
        if (parsed.answers === null || typeof parsed.answers !== "object" || Array.isArray(parsed.answers)) {
          throw wayfinderError("provider-unavailable", "decide", "TypeSafe response omitted typed answers");
        }
        const exactTokens = parsed.usage?.input_tokens;
        this.#tokens += typeof exactTokens === "number" && Number.isFinite(exactTokens) ? Math.max(0, Math.ceil(exactTokens)) : inputEstimate + Math.ceil(text.length / 4);
        if (this.#tokens > this.#options.maxApproxTokens) throw wayfinderError("limit-exceeded", "decide", "TypeSafe provider token limit exceeded");
        return { answers: parsed.answers as Record<string, unknown>, latencyMs: Date.now() - startedAt };
      } catch (error) {
        if (timeout.signal.aborted) throw wayfinderError(signal.aborted ? "cancelled" : "timed-out", "decide", signal.aborted ? "TypeSafe request cancelled" : "TypeSafe request timed out", { retryable: !signal.aborted });
        if (attempt >= this.#options.maxRetries || (error !== null && typeof error === "object" && "code" in error)) throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    }
    throw wayfinderError("provider-unavailable", "decide", "TypeSafe request retries exhausted");
  }
}

export function providerSetupReadiness(input: { endpoint?: string; model?: string; credentialAvailable: boolean }): ProviderProbeResult {
  if (!input.credentialAvailable) return { state: "setup-required", message: "A verified Infisical project, environment, path, and TypeSafe credential are required" };
  if (input.endpoint === undefined || input.model === undefined) return { state: "setup-required", message: "TypeSafe System One endpoint and Jev model are required" };
  return { state: "unavailable", message: "TypeSafe configuration is present but has not passed a functional typed probe" };
}
