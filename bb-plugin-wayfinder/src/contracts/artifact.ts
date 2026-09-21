import { z } from "zod";

import { mediaDescriptorSchema } from "./media.js";
import { entityIdSchema, relativePathSchema, sha256Schema, unixMsSchema } from "./primitives.js";

export const artifactRecordSchema = z
  .object({
    artifactId: entityIdSchema,
    runId: entityIdSchema,
    threadId: entityIdSchema,
    projectId: entityIdSchema.nullable(),
    media: mediaDescriptorSchema,
    storage: z
      .object({
        kind: z.literal("host-private"),
        relativePath: relativePathSchema,
        immutableSha256: sha256Schema,
      })
      .strict(),
    sanitized: z.boolean(),
    retentionExpiresAt: unixMsSchema,
  })
  .strict();

export const artifactShareRecordSchema = z
  .object({
    shareId: entityIdSchema,
    artifactIds: z.array(entityIdSchema).min(1).max(32),
    runId: entityIdSchema,
    threadId: entityIdSchema,
    createdByUserId: entityIdSchema,
    createdAt: unixMsSchema,
    expiresAt: unixMsSchema,
    revokedAt: unixMsSchema.nullable(),
    state: z.enum(["active", "expired", "revoked"]),
    audience: z.literal("anyone-with-link"),
    manifestSha256: sha256Schema,
  })
  .strict();

export const createArtifactShareInputSchema = z
  .object({
    runId: entityIdSchema,
    artifactIds: z.array(entityIdSchema).min(1).max(32),
    expiresInSeconds: z.number().int().min(60).max(604_800),
    audience: z.literal("anyone-with-link"),
  })
  .strict()
  .refine(({ artifactIds }) => new Set(artifactIds).size === artifactIds.length, {
    path: ["artifactIds"],
    message: "artifactIds must be unique",
  });

export const createArtifactShareOutputSchema = z
  .object({
    share: artifactShareRecordSchema,
    url: z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "External share URLs must use HTTPS"),
  })
  .strict();

export const artifactRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    endInclusive: z.number().int().nonnegative(),
  })
  .strict()
  .refine(({ start, endInclusive }) => endInclusive >= start && endInclusive - start < 1_048_576, {
    message: "Artifact ranges are inclusive and limited to 1 MiB",
  });

export const artifactHttpRoutes = {
  download: "/v1/artifacts/download",
  inline: "/v1/artifacts/inline",
  sharedExport: "/v1/exports/read",
} as const;

export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
export type ArtifactShareRecord = z.infer<typeof artifactShareRecordSchema>;
