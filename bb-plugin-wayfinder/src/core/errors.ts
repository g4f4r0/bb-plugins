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
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown failure";
}

export function abortedError(signal: AbortSignal, phase: WayfinderError["phase"]): WayfinderError {
  const timedOut = signal.reason === "timeout";
  return wayfinderError(
    timedOut ? "timed-out" : "cancelled",
    phase,
    timedOut ? "The bounded operation timed out" : "The operation was cancelled",
  );
}
