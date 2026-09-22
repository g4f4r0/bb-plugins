import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { artifactRangeSchema, artifactRecordSchema } from "./artifact.js";
import { base64Schema, entityIdSchema, sha256Schema, unixMsSchema } from "./primitives.js";
import { routeSchema } from "./route.js";
import { runRecordSchema } from "./run.js";

const capabilityStateSchema = z.enum(["ready", "setup-required", "unavailable"]);

export const hostCapabilitiesSchema = z
  .object({
    hostId: entityIdSchema,
    platform: z
      .object({
        os: z.string().min(1).max(100),
        arch: z.string().min(1).max(100),
        nodeVersion: z.string().min(1).max(50),
      })
      .strict(),
    browser: z
      .object({
        state: capabilityStateSchema,
        provider: z.literal("fortress-cdp"),
        instanceCount: z.number().int().nonnegative().max(32),
        detail: z.string().min(1).max(1_000).nullable(),
      })
      .strict(),
    desktop: z
      .object({
        state: capabilityStateSchema,
        provider: z.literal("cua-driver"),
        version: z.string().min(1).max(100).nullable(),
        daemonRunning: z.boolean(),
        accessibilityReady: z.boolean(),
        captureReady: z.boolean(),
        detail: z.string().min(1).max(1_000).nullable(),
      })
      .strict(),
    encoder: z
      .object({
        state: capabilityStateSchema,
        ffmpegVersion: z.string().min(1).max(200).nullable(),
        h264Encoders: z.array(z.string().min(1).max(100)).max(32),
        detail: z.string().min(1).max(1_000).nullable(),
      })
      .strict(),
    ocr: z
      .object({
        state: capabilityStateSchema,
        provider: z.string().min(1).max(100).nullable(),
        detail: z.string().min(1).max(1_000).nullable(),
      })
      .strict(),
    decisionProvider: z
      .object({
        state: capabilityStateSchema,
        provider: z.enum(["typesafe-jev", "openrouter", "deterministic-fixture"]),
        infisicalScopeVerified: z.boolean(),
        detail: z.string().min(1).max(1_000).nullable(),
      })
      .strict(),
    probedAt: unixMsSchema,
  })
  .strict();

export const hostContract = defineRpcContract({
  "capabilities.probe": {
    input: z.object({ expectedHostId: entityIdSchema, provider: z.enum(["fixture", "jev", "openrouter"]) }).strict(),
    output: hostCapabilitiesSchema,
  },
  "runs.start": {
    input: z
      .object({
        expectedHostId: entityIdSchema,
        runId: entityIdSchema,
        routeHash: sha256Schema,
        route: routeSchema,
      })
      .strict(),
    output: z.object({ accepted: z.literal(true), runId: entityIdSchema }).strict(),
  },
  "runs.status": {
    input: z.object({ expectedHostId: entityIdSchema, runId: entityIdSchema }).strict(),
    output: runRecordSchema,
  },
  "runs.cancel": {
    input: z.object({ expectedHostId: entityIdSchema, runId: entityIdSchema, reason: z.string().min(1).max(500) }).strict(),
    output: z.object({ accepted: z.boolean(), run: runRecordSchema }).strict(),
  },
  "media.latest": {
    input: z
      .object({
        expectedHostId: entityIdSchema,
        runId: entityIdSchema,
        afterSequence: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    output: z
      .object({
        frame: z
          .object({
            sequence: z.number().int().nonnegative(),
            capturedAt: unixMsSchema,
            mimeType: z.enum(["image/webp", "image/jpeg", "image/png"]),
            width: z.number().int().positive().max(1_920),
            height: z.number().int().positive().max(1_080),
            bytesBase64: base64Schema,
            state: z.enum(["live", "paused", "redacted", "disconnected"]),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  },
  "artifacts.list": {
    input: z
      .object({
        expectedHostId: entityIdSchema,
        threadId: entityIdSchema,
        runId: entityIdSchema.nullable(),
        cursor: entityIdSchema.nullable(),
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    output: z.object({ artifacts: z.array(artifactRecordSchema).max(100), nextCursor: entityIdSchema.nullable() }).strict(),
  },
  "artifacts.get": {
    input: z.object({ expectedHostId: entityIdSchema, threadId: entityIdSchema, artifactId: entityIdSchema }).strict(),
    output: artifactRecordSchema,
  },
  "artifacts.readRange": {
    input: z
      .object({
        expectedHostId: entityIdSchema,
        artifactId: entityIdSchema,
        range: artifactRangeSchema,
      })
      .strict(),
    output: z
      .object({
        artifact: artifactRecordSchema,
        bytesBase64: base64Schema,
        range: artifactRangeSchema,
        complete: z.boolean(),
      })
      .strict(),
  },
});

export const hostSignals = {
  runChanged: {
    payload: z.object({ runId: entityIdSchema, revision: z.number().int().nonnegative() }).strict(),
  },
  frameAvailable: {
    payload: z.object({ runId: entityIdSchema, sequence: z.number().int().nonnegative() }).strict(),
  },
  artifactChanged: {
    payload: z.object({ runId: entityIdSchema, artifactId: entityIdSchema }).strict(),
  },
} satisfies ExperimentalHostSignals;

export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;
