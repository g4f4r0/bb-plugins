import { Effect } from "effect";

import type { WayfinderError } from "../contracts/run.js";
import { errorMessage, wayfinderError } from "../core/errors.js";

export function adapterEffect<A>(
  phase: WayfinderError["phase"],
  operation: () => Promise<A>,
): Effect.Effect<A, WayfinderError> {
  return Effect.tryPromise({
    try: operation,
    catch: (error) => {
      if (isWayfinderError(error)) return error;
      return wayfinderError("internal", phase, errorMessage(error));
    },
  });
}

export function isWayfinderError(value: unknown): value is WayfinderError {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<WayfinderError>;
  return typeof candidate.code === "string" && typeof candidate.phase === "string" && typeof candidate.message === "string";
}

export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw wayfinderError("cancelled", "act", "Operation cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(wayfinderError("cancelled", "act", "Operation cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
