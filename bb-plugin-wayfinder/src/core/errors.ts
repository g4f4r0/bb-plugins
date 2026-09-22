import type { WayfinderError } from "../contracts/run.js";

export function wayfinderError(
  code: WayfinderError["code"],
  phase: WayfinderError["phase"],
  message: string,
  options: {
    retryable?: boolean;
    details?: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  } = {},
): WayfinderError {
  return {
    code,
    phase,
    message: message.slice(0, 1_000) || "Wayfinder operation failed",
    retryable: options.retryable ?? false,
    details: (options.details ?? []).slice(0, 16).map(({ key, value }) => ({
      key: key.slice(0, 64) || "detail",
      value: value.slice(0, 500),
    })),
  };
}

export function errorMessage(error: unknown): string {
  const seen = new Set<unknown>();
  const extract = (value: unknown): string | null => {
    if (typeof value === "string") return value.trim() || null;
    if (value === null || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error", "cause"]) {
      const message = extract(record[key]);
      if (message !== null) return message;
    }
    return null;
  };
  return extract(error) ?? "Unknown failure";
}

export function abortedError(signal: AbortSignal, phase: WayfinderError["phase"]): WayfinderError {
  const timedOut = signal.reason === "timeout";
  return wayfinderError(
    timedOut ? "timed-out" : "cancelled",
    phase,
    timedOut ? "The bounded operation timed out" : "The operation was cancelled",
  );
}
