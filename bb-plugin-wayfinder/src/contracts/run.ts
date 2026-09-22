import { z } from "zod";

import { entityIdSchema, sha256Schema, unixMsSchema } from "./primitives.js";
import { checkpointSchema, routeSchema } from "./route.js";

export const runStateSchema = z.enum([
  "queued",
  "running",
  "awaiting_confirmation",
  "verifying",
  "passed",
  "failed",
  "blocked",
  "cancelled",
  "timed_out",
  "interrupted",
]);

export const cleanupOutcomeSchema = z
  .object({
    state: z.enum(["not-required", "pending", "completed", "incomplete"]),
    message: z.string().min(1).max(1_000).nullable(),
    completedAt: unixMsSchema.nullable(),
  })
  .strict();

export const wayfinderErrorSchema = z
  .object({
    code: z.enum([
      "invalid-route",
      "policy-denied",
      "host-mismatch",
      "setup-required",
      "provider-unavailable",
      "ambiguous-target",
      "stale-observation",
      "uncertain-mutation",
      "verification-failed",
      "limit-exceeded",
      "cancelled",
      "timed-out",
      "interrupted",
      "cleanup-incomplete",
      "internal",
    ]),
    phase: z.enum(["queue", "observe", "decide", "act", "verify", "capture", "cleanup"]),
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
    details: z
      .array(z.object({ key: z.string().min(1).max(64), value: z.string().max(500) }).strict())
      .max(16),
  })
  .strict();

export const checkpointResultSchema = z
  .object({
    checkpoint: checkpointSchema,
    outcome: z.enum(["pass", "fail", "unknown"]),
    observedAt: unixMsSchema,
    summary: z.string().min(1).max(1_000),
    evidenceArtifactIds: z.array(entityIdSchema).max(16),
  })
  .strict();

export const approvalGrantSchema = z
  .object({
    approvalId: entityIdSchema,
    runId: entityIdSchema,
    actionId: entityIdSchema,
    targetId: entityIdSchema,
    targetGeneration: entityIdSchema,
    userId: entityIdSchema,
    routePolicyHash: sha256Schema,
    stateHash: sha256Schema,
    issuedAt: unixMsSchema,
    expiresAt: unixMsSchema,
    singleUse: z.literal(true),
  })
  .strict()
  .refine(({ issuedAt, expiresAt }) => expiresAt > issuedAt, {
    path: ["expiresAt"],
    message: "Approval must expire after it is issued",
  });

export const runRecordSchema = z
  .object({
    runId: entityIdSchema,
    routeHash: sha256Schema,
    route: routeSchema,
    state: runStateSchema,
    revision: z.number().int().nonnegative(),
    queuePosition: z.number().int().positive().nullable(),
    activeController: z.boolean(),
    currentActionId: entityIdSchema.nullable(),
    currentCheckpointId: entityIdSchema.nullable(),
    startedAt: unixMsSchema.nullable(),
    updatedAt: unixMsSchema,
    finishedAt: unixMsSchema.nullable(),
    deadlineAt: unixMsSchema,
    error: wayfinderErrorSchema.nullable(),
    cleanup: cleanupOutcomeSchema,
    checkpoints: z.array(checkpointResultSchema).max(32),
  })
  .strict();

export const startRunInputSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
    route: routeSchema,
  })
  .strict();

export const startRunOutputSchema = z
  .object({
    runId: entityIdSchema,
    routeHash: sha256Schema,
    deduplicated: z.boolean(),
  })
  .strict();

export const humanInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), x: z.number().finite().min(0).max(8_192), y: z.number().finite().min(0).max(8_192), button: z.enum(["left", "middle", "right"]) }).strict(),
  z.object({ kind: z.literal("wheel"), x: z.number().finite().min(0).max(8_192), y: z.number().finite().min(0).max(8_192), deltaX: z.number().finite().min(-3_000).max(3_000), deltaY: z.number().finite().min(-3_000).max(3_000) }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(10_000) }).strict(),
  z.object({ kind: z.literal("key"), key: z.string().min(1).max(100), code: z.string().max(100), modifiers: z.number().int().min(0).max(15) }).strict(),
]);

export const computerSnapshotSchema = z
  .object({
    hostId: entityIdSchema,
    readiness: z.enum(["ready", "setup-required", "offline", "degraded"]),
    readinessMessage: z.string().min(1).max(1_000).nullable(),
    activeRun: runRecordSchema.nullable(),
    queue: z
      .array(
        z
          .object({
            runId: entityIdSchema,
            threadId: entityIdSchema,
            position: z.number().int().positive(),
            enqueuedAt: unixMsSchema,
          })
          .strict(),
      )
      .max(100),
    selectedRun: runRecordSchema.nullable(),
    connectionState: z.enum(["connected", "reconnecting", "disconnected"]),
    frameSequence: z.number().int().nonnegative().nullable(),
    frameCapturedAt: unixMsSchema.nullable(),
    sampledAt: unixMsSchema,
  })
  .strict();

export type RunState = z.infer<typeof runStateSchema>;
export type WayfinderError = z.infer<typeof wayfinderErrorSchema>;
export type CheckpointResult = z.infer<typeof checkpointResultSchema>;
export type ApprovalGrant = z.infer<typeof approvalGrantSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type StartRunInput = z.infer<typeof startRunInputSchema>;
export type ComputerSnapshot = z.infer<typeof computerSnapshotSchema>;
export type HumanInput = z.infer<typeof humanInputSchema>;
