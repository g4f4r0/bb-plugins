import type { Effect } from "effect";
import { z } from "zod";

import { entityIdSchema, rectSchema, relativePathSchema, sha256Schema, unixMsSchema } from "./primitives.js";
import { checkpointSchema, dataReferenceSchema } from "./route.js";
import { checkpointResultSchema, wayfinderErrorSchema } from "./run.js";

export const adapterKindSchema = z.enum(["browser", "desktop", "filesystem"]);

export const observationIdentitySchema = z
  .object({
    adapter: adapterKindSchema,
    hostId: entityIdSchema,
    resourceId: entityIdSchema,
    resourceGeneration: entityIdSchema,
    snapshotId: entityIdSchema,
    observedAt: unixMsSchema,
  })
  .strict();

export const observedTargetSchema = z
  .object({
    targetId: entityIdSchema,
    resourceGeneration: entityIdSchema,
    role: z.string().min(1).max(80),
    name: z.string().max(300),
    valueSummary: z.string().max(500).nullable(),
    bounds: rectSchema.nullable(),
    allowedOperations: z
      .array(z.enum(["click", "type", "select", "scroll", "activate", "invoke-menu"]))
      .min(1)
      .max(8),
  })
  .strict();

export const adapterObservationSchema = z
  .object({
    identity: observationIdentitySchema,
    title: z.string().max(500),
    location: z.string().max(2_048).nullable(),
    text: z.string().max(32_000),
    targets: z.array(observedTargetSchema).max(1_000),
    stateHash: sha256Schema,
    changedTargetIds: z.array(entityIdSchema).max(1_000),
    humanActivityDetected: z.boolean(),
  })
  .strict();

const targetReferenceSchema = z
  .object({
    targetId: entityIdSchema,
    resourceGeneration: entityIdSchema,
    snapshotId: entityIdSchema,
  })
  .strict();

export const adapterActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("browser.navigate"), url: z.string().url().max(2_048) }).strict(),
  z.object({ kind: z.literal("browser.click"), target: targetReferenceSchema }).strict(),
  z.object({ kind: z.literal("browser.type"), target: targetReferenceSchema, value: dataReferenceSchema }).strict(),
  z.object({ kind: z.literal("browser.select"), target: targetReferenceSchema, optionTarget: targetReferenceSchema }).strict(),
  z.object({ kind: z.literal("browser.scroll"), target: targetReferenceSchema.nullable(), direction: z.enum(["up", "down"]), amount: z.enum(["small", "page"]) }).strict(),
  z.object({ kind: z.literal("browser.back") }).strict(),
  z.object({ kind: z.literal("browser.download"), target: targetReferenceSchema, outputRootId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("desktop.activate"), appId: entityIdSchema, resourceGeneration: entityIdSchema }).strict(),
  z.object({ kind: z.literal("desktop.click"), target: targetReferenceSchema }).strict(),
  z.object({ kind: z.literal("desktop.type"), target: targetReferenceSchema, value: dataReferenceSchema }).strict(),
  z.object({ kind: z.literal("desktop.scroll"), target: targetReferenceSchema, direction: z.enum(["up", "down"]), amount: z.enum(["small", "page"]) }).strict(),
  z.object({ kind: z.literal("desktop.shortcut"), shortcutId: entityIdSchema }).strict(),
  z.object({ kind: z.literal("desktop.invoke-menu"), target: targetReferenceSchema }).strict(),
  z.object({ kind: z.literal("filesystem.read"), rootId: entityIdSchema, relativePath: relativePathSchema }).strict(),
  z.object({ kind: z.literal("filesystem.list"), rootId: entityIdSchema, relativePath: relativePathSchema }).strict(),
  z.object({ kind: z.literal("filesystem.verify"), checkpoint: checkpointSchema }).strict(),
  z.object({ kind: z.literal("wait"), reason: z.string().min(1).max(300), maxWaitMs: z.number().int().min(20).max(10_000) }).strict(),
]);

export const actionIntentSchema = z
  .object({
    actionId: entityIdSchema,
    runId: entityIdSchema,
    routePolicyHash: sha256Schema,
    observation: observationIdentitySchema,
    action: adapterActionSchema,
    intentRecordedAt: unixMsSchema,
  })
  .strict();

export const adapterOutcomeSchema = z
  .object({
    actionId: entityIdSchema,
    state: z.enum(["completed", "no-op", "uncertain", "blocked", "failed"]),
    dispatchedAt: unixMsSchema.nullable(),
    outcomeRecordedAt: unixMsSchema,
    summary: z.string().min(1).max(1_000),
    postObservation: adapterObservationSchema.nullable(),
    error: wayfinderErrorSchema.nullable(),
  })
  .strict();

const probabilitySchema = z
  .object({
    choiceId: entityIdSchema,
    probability: z.number().min(0).max(1),
  })
  .strict();

export const decisionRequestSchema = z
  .object({
    runId: entityIdSchema,
    goal: z.string().min(1).max(4_000),
    observation: adapterObservationSchema,
    operationChoices: z.array(z.object({ choiceId: entityIdSchema, label: z.string().min(1).max(300) }).strict()).min(1).max(32),
    targetChoices: z.array(z.object({ choiceId: entityIdSchema, targetId: entityIdSchema, label: z.string().min(1).max(500) }).strict()).max(1_000),
    recentOutcomeSummaries: z.array(z.string().max(500)).max(20),
  })
  .strict();

export const decisionResponseSchema = z
  .object({
    operationChoiceId: entityIdSchema,
    targetChoiceId: entityIdSchema.nullable(),
    operationProbabilities: z.array(probabilitySchema).max(32).nullable(),
    targetProbabilities: z.array(probabilitySchema).max(1_000).nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    providerModel: z.string().min(1).max(200),
    latencyMs: z.number().int().nonnegative().max(120_000),
  })
  .strict()
  .superRefine((response, context) => {
    for (const [field, entries] of [["operationProbabilities", response.operationProbabilities], ["targetProbabilities", response.targetProbabilities]] as const) {
      if (entries === null) continue;
      const ids = new Set(entries.map((entry) => entry.choiceId));
      const sum = entries.reduce((total, entry) => total + entry.probability, 0);
      if (ids.size !== entries.length || (entries.length > 0 && Math.abs(sum - 1) > 0.02)) context.addIssue({ code: "custom", path: [field], message: "Probabilities must be unique and sum to one" });
    }
    if (response.targetChoiceId === null && response.targetProbabilities !== null && response.targetProbabilities.length !== 0) context.addIssue({ code: "custom", path: ["targetProbabilities"], message: "A targetless choice cannot include target probabilities" });
  });

export interface AdapterExecutionContext {
  readonly signal: AbortSignal;
  readonly expectedHostId: string;
}

export type AdapterFailure = z.infer<typeof wayfinderErrorSchema>;
export type AdapterObservation = z.infer<typeof adapterObservationSchema>;
export type ActionIntent = z.infer<typeof actionIntentSchema>;
export type AdapterOutcome = z.infer<typeof adapterOutcomeSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;

export interface AutomationAdapter {
  readonly kind: z.infer<typeof adapterKindSchema>;
  observe(context: AdapterExecutionContext): Effect.Effect<AdapterObservation, AdapterFailure>;
  execute(intent: ActionIntent, context: AdapterExecutionContext): Effect.Effect<AdapterOutcome, AdapterFailure>;
  verify(
    checkpoint: z.infer<typeof checkpointSchema>,
    observation: AdapterObservation,
    context: AdapterExecutionContext,
  ): Effect.Effect<z.infer<typeof checkpointResultSchema>, AdapterFailure>;
  close(context: AdapterExecutionContext): Effect.Effect<void, AdapterFailure>;
}

export interface DecisionProvider {
  decide(request: DecisionRequest, context: AdapterExecutionContext): Effect.Effect<DecisionResponse, AdapterFailure>;
}
