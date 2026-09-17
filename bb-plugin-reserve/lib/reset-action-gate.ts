import { randomBytes, randomUUID } from "node:crypto";

const RESET_CONFIRMATION_TTL_MS = 2 * 60_000;
const MAX_PENDING_ATTEMPTS = 128;

export type ResetConsumptionOutcome =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed";

export type ResetPrepareResult =
  | {
      outcome: "ready";
      confirmationToken: string;
      expiresAtMs: number;
      availableCount: number;
    }
  | {
      outcome: "unavailable" | "no-credit";
      message: string;
    };

export interface ResetActionGate {
  dispose(): void;
  readonly availableCount: number | null;
  /** `readStartedAtMs` drops counts read before the latest spend started. */
  setAvailableCount(availableCount: number | null, readStartedAtMs?: number): void;
  prepare(): ResetPrepareResult;
  consume(confirmationToken: string): Promise<
    ResetConsumptionOutcome | "confirmation-invalid" | "confirmation-expired"
  >;
}

interface ResetAttempt {
  idempotencyKey: string;
  expiresAtMs: number;
  result?: ResetConsumptionOutcome;
  inFlight?: Promise<ResetConsumptionOutcome>;
}

export function createResetActionGate(
  consumeReset: (idempotencyKey: string) => Promise<ResetConsumptionOutcome>,
  now: () => number = Date.now,
): ResetActionGate {
  let disposed = false;
  let availableCount: number | null = null;
  let lastSpendStartedAtMs = -Infinity;
  const attempts = new Map<string, ResetAttempt>();

  const pruneAttempts = (timestamp: number): void => {
    for (const [token, attempt] of attempts) {
      if (attempt.inFlight === undefined && attempt.expiresAtMs <= timestamp) {
        attempts.delete(token);
      }
    }
  };

  return {
    dispose() { disposed = true; availableCount = null; attempts.clear(); },
    get availableCount() {
      return availableCount;
    },

    setAvailableCount(nextAvailableCount, readStartedAtMs = Infinity) {
      if (disposed) return;
      if (nextAvailableCount !== null && readStartedAtMs <= lastSpendStartedAtMs) return;
      availableCount = nextAvailableCount;
    },

    prepare() {
      const timestamp = Math.trunc(now());
      pruneAttempts(timestamp);
      if (availableCount === null) {
        return {
          outcome: "unavailable",
          message: "Usage reset availability is unavailable.",
        };
      }
      if (availableCount === 0) {
        return {
          outcome: "no-credit",
          message: "No usage resets are available.",
        };
      }

      if (attempts.size >= MAX_PENDING_ATTEMPTS) {
        return {
          outcome: "unavailable",
          message: "A usage reset confirmation is already pending.",
        };
      }

      const expiresAtMs = timestamp + RESET_CONFIRMATION_TTL_MS;
      const confirmationToken = randomBytes(32).toString("base64url");
      attempts.set(confirmationToken, {
        idempotencyKey: randomUUID(),
        expiresAtMs,
      });
      return {
        outcome: "ready",
        confirmationToken,
        expiresAtMs,
        availableCount,
      };
    },

    async consume(confirmationToken) {
      const timestamp = Math.trunc(now());
      const attempt = attempts.get(confirmationToken);
      if (attempt === undefined) return "confirmation-invalid";
      if (attempt.expiresAtMs <= timestamp && attempt.inFlight === undefined) {
        attempts.delete(confirmationToken);
        return "confirmation-expired";
      }
      if (attempt.result !== undefined) return attempt.result;
      if (attempt.inFlight !== undefined) return attempt.inFlight;
      // Another confirmation already spent (or is spending) the known credit.
      if (availableCount === null || availableCount <= 0) return "confirmation-invalid";

      availableCount = null;
      lastSpendStartedAtMs = timestamp;
      const request = consumeReset(attempt.idempotencyKey);
      attempt.inFlight = request;
      try {
        const result = await request;
        attempt.result = result;
        return result;
      } finally {
        attempt.inFlight = undefined;
      }
    },
  };
}
