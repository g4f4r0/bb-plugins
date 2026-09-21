import { z } from "zod";

import { entityIdSchema, sha256Schema, unixMsSchema } from "./primitives.js";

export const capturePolicySchema = z
  .object({
    livePreview: z
      .object({
        enabled: z.boolean(),
        maxWidth: z.number().int().min(320).max(1_920),
        maxHeight: z.number().int().min(180).max(1_080),
        maxFps: z.number().min(0.2).max(12),
        maxFrameBytes: z.number().int().min(16_384).max(786_432),
      })
      .strict(),
    evidenceImages: z
      .object({
        enabled: z.boolean(),
        maxWidth: z.number().int().min(320).max(3_840),
        maxHeight: z.number().int().min(180).max(2_160),
        maxImages: z.number().int().min(1).max(200),
      })
      .strict(),
    recording: z
      .object({
        enabled: z.boolean(),
        maxDurationMs: z.number().int().min(1_000).max(1_800_000),
        maxBytes: z.number().int().min(65_536).max(536_870_912),
        codec: z.literal("h264"),
        pixelFormat: z.literal("yuv420p"),
      })
      .strict(),
    protectedIntervals: z.literal("suspend-all-model-visible-capture"),
  })
  .strict();

export const mediaKindSchema = z.enum([
  "image",
  "video",
  "report",
  "trail",
  "live-frame",
]);

export const mediaDescriptorSchema = z
  .object({
    mediaId: entityIdSchema,
    runId: entityIdSchema,
    threadId: entityIdSchema,
    kind: mediaKindSchema,
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(3).max(127).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u),
    sizeBytes: z.number().int().nonnegative().max(536_870_912),
    sha256: sha256Schema,
    createdAt: unixMsSchema,
    width: z.number().int().positive().max(7_680).nullable(),
    height: z.number().int().positive().max(4_320).nullable(),
    durationMs: z.number().int().nonnegative().max(1_800_000).nullable(),
    captureStartedAt: unixMsSchema.nullable(),
    captureEndedAt: unixMsSchema.nullable(),
    redacted: z.boolean(),
  })
  .strict();

export type CapturePolicy = z.infer<typeof capturePolicySchema>;
export type MediaDescriptor = z.infer<typeof mediaDescriptorSchema>;
