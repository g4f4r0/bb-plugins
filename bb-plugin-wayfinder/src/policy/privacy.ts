import type { AdapterObservation, DecisionRequest } from "../contracts/adapter.js";

const SENSITIVE_LABEL = /(?:pass(?:word|code)?|secret|token|api[ _-]?key|private[ _-]?key|credential|auth(?:entication|orization)?)/iu;
const SENSITIVE_TEXT = /(?:bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/giu;

export function isSensitiveLabel(value: string): boolean {
  return SENSITIVE_LABEL.test(value);
}

export function redactModelText(value: string, maxLength: number): string {
  return value.replace(SENSITIVE_TEXT, "[REDACTED]").slice(0, maxLength);
}

export function sanitizeObservationForProvider(observation: AdapterObservation): AdapterObservation {
  return {
    ...observation,
    title: redactModelText(observation.title, 500),
    location: observation.location === null ? null : redactModelText(observation.location, 2_048),
    text: redactModelText(observation.text, 32_000),
    targets: observation.targets.map((target) => ({
      ...target,
      name: redactModelText(target.name, 300),
      valueSummary: target.valueSummary === null || isSensitiveLabel(target.name)
        ? null
        : redactModelText(target.valueSummary, 500),
    })),
  };
}

export function sanitizeDecisionRequest(request: DecisionRequest): DecisionRequest {
  return {
    ...request,
    goal: redactModelText(request.goal, 4_000),
    observation: sanitizeObservationForProvider(request.observation),
    recentOutcomeSummaries: request.recentOutcomeSummaries.map((value) => redactModelText(value, 500)),
  };
}
