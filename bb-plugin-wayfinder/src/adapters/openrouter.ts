import type { AdapterExecutionContext, DecisionProvider, DecisionRequest } from "../contracts/adapter.js";
import { decisionResponseSchema } from "../contracts/adapter.js";
import { wayfinderError } from "../core/errors.js";
import { sanitizeDecisionRequest } from "../policy/privacy.js";
import { adapterEffect } from "./effect.js";

export interface OpenRouterProviderOptions {
  readonly endpoint?: string;
  readonly model: string;
  /** Supplied by the host process from an authorized secret injector. */
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

export class OpenRouterDecisionProvider implements DecisionProvider {
  readonly #options: Required<Omit<OpenRouterProviderOptions, "fetchImpl" | "endpoint">> & { endpoint: string; fetchImpl: typeof fetch };
  constructor(options: OpenRouterProviderOptions) {
    const endpoint = options.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
    if (new URL(endpoint).protocol !== "https:") throw wayfinderError("setup-required", "decide", "OpenRouter endpoint must use HTTPS");
    if (!options.apiKey.trim()) throw wayfinderError("setup-required", "decide", "OpenRouter credential is missing");
    if (!options.model.trim()) throw wayfinderError("setup-required", "decide", "OpenRouter model is missing");
    this.#options = { ...options, endpoint, timeoutMs: options.timeoutMs ?? 30_000, maxResponseBytes: options.maxResponseBytes ?? 256_000, fetchImpl: options.fetchImpl ?? fetch };
  }
  decide(request: DecisionRequest, context: AdapterExecutionContext) { return adapterEffect("decide", () => this.#decide(request, context)); }
  async #decide(raw: DecisionRequest, context: AdapterExecutionContext) {
    const request = sanitizeDecisionRequest(raw);
    const body = JSON.stringify({ model: this.#options.model, temperature: 0, max_tokens: 300, response_format: { type: "json_object" }, messages: [
      { role: "system", content: "Return JSON only with operationChoiceId and targetChoiceId. Select IDs only from the supplied choices. Do not return probabilities or confidence." },
      { role: "user", content: JSON.stringify({ goal: request.goal, observation: request.observation, operationChoices: request.operationChoices, targetChoices: request.targetChoices }) },
    ] });
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort("timeout"), this.#options.timeoutMs);
    const abort = () => timeout.abort(context.signal.reason);
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#options.fetchImpl(this.#options.endpoint, { method: "POST", headers: { authorization: `Bearer ${this.#options.apiKey}`, "content-type": "application/json" }, body, signal: timeout.signal });
      const text = await response.text();
      if (Buffer.byteLength(text) > this.#options.maxResponseBytes) throw wayfinderError("limit-exceeded", "decide", "OpenRouter response exceeded the output limit");
      if (!response.ok) throw wayfinderError("provider-unavailable", "decide", `OpenRouter returned HTTP ${response.status}`, { retryable: response.status === 429 || response.status >= 500 });
      const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw wayfinderError("provider-unavailable", "decide", "OpenRouter response omitted structured content");
      const choice = JSON.parse(content) as { operationChoiceId?: unknown; targetChoiceId?: unknown };
      const operationIds = new Set(request.operationChoices.map((item) => item.choiceId));
      const targetIds = new Set(request.targetChoices.map((item) => item.choiceId));
      if (typeof choice.operationChoiceId !== "string" || !operationIds.has(choice.operationChoiceId)) throw wayfinderError("provider-unavailable", "decide", "OpenRouter selected an operation outside the supplied choices");
      const targetChoiceId = choice.targetChoiceId === null ? null : typeof choice.targetChoiceId === "string" && targetIds.has(choice.targetChoiceId) ? choice.targetChoiceId : null;
      if (choice.targetChoiceId !== null && targetChoiceId === null) throw wayfinderError("provider-unavailable", "decide", "OpenRouter selected a target outside the supplied choices");
      return decisionResponseSchema.parse({ operationChoiceId: choice.operationChoiceId, targetChoiceId, operationProbabilities: null, targetProbabilities: null, confidence: null, providerModel: this.#options.model, latencyMs: 0 });
    } catch (error) {
      if (timeout.signal.aborted) throw wayfinderError(context.signal.aborted ? "cancelled" : "timed-out", "decide", context.signal.aborted ? "OpenRouter request cancelled" : "OpenRouter request timed out", { retryable: !context.signal.aborted });
      if (error && typeof error === "object" && "code" in error) throw error;
      throw wayfinderError("provider-unavailable", "decide", "OpenRouter returned invalid JSON");
    } finally { clearTimeout(timer); context.signal.removeEventListener("abort", abort); }
  }
}
