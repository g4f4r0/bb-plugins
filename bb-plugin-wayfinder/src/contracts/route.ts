import { z } from "zod";

import { capturePolicySchema } from "./media.js";
import {
  absolutePathSchema,
  allowedOriginSchema,
  entityIdSchema,
  httpOriginSchema,
  jsonScalarSchema,
  relativePathSchema,
  sha256Schema,
} from "./primitives.js";

export const dataReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("synthetic-literal"),
      value: z.string().max(4_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("protected-ref"),
      dataRefId: entityIdSchema,
    })
    .strict(),
]);

export const targetQuerySchema = z
  .object({
    surface: z.enum(["browser", "desktop"]),
    role: z.string().min(1).max(80),
    name: z.string().min(1).max(300),
    match: z.enum(["exact", "contains"]),
    appId: entityIdSchema.nullable(),
  })
  .strict();

const urlCheckpointSchema = z
  .object({
    checkpointId: entityIdSchema,
    kind: z.literal("url"),
    timing: z.enum(["historical", "final"]),
    origin: httpOriginSchema,
    pathname: z.string().min(1).max(2_048).startsWith("/"),
    match: z.enum(["exact", "prefix"]),
  })
  .strict();

const visibleTextCheckpointSchema = z
  .object({
    checkpointId: entityIdSchema,
    kind: z.literal("visible-text"),
    timing: z.enum(["historical", "final"]),
    surface: z.enum(["browser", "desktop"]),
    text: z.string().min(1).max(2_000),
    match: z.enum(["exact", "contains"]),
    caseSensitive: z.boolean(),
  })
  .strict();

const controlStateCheckpointSchema = z
  .object({
    checkpointId: entityIdSchema,
    kind: z.literal("control-state"),
    timing: z.enum(["historical", "final"]),
    target: targetQuerySchema,
    state: z.enum(["visible", "hidden", "enabled", "disabled", "checked", "unchecked", "selected"]),
  })
  .strict();

const fieldValueCheckpointSchema = z
  .object({
    checkpointId: entityIdSchema,
    kind: z.literal("field-value"),
    timing: z.enum(["historical", "final"]),
    target: targetQuerySchema,
    expected: dataReferenceSchema,
    comparison: z.enum(["equals", "contains"]),
  })
  .strict();

const structuredValueCheckpointSchema = z
  .object({
    checkpointId: entityIdSchema,
    kind: z.literal("structured-value"),
    timing: z.enum(["historical", "final"]),
    source: z.enum(["browser-dom", "browser-network", "desktop-accessibility"]),
    path: z.array(z.union([z.string().min(1).max(128), z.number().int().nonnegative()])).min(1).max(32),
    comparison: z.enum(["equals", "contains", "greater-than", "less-than"]),
    expected: jsonScalarSchema,
  })
  .strict();

const networkOutcomeCheckpointSchema = z
  .object({
    checkpointId: entityIdSchema,
    kind: z.literal("network-outcome"),
    timing: z.enum(["historical", "final"]),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
    origin: httpOriginSchema,
    pathname: z.string().min(1).max(2_048).startsWith("/"),
    status: z.number().int().min(100).max(599),
  })
  .strict();

const filesystemAssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exists"), entryType: z.enum(["file", "directory", "either"]) }).strict(),
  z.object({ kind: z.literal("missing") }).strict(),
  z.object({ kind: z.literal("sha256"), sha256: sha256Schema }).strict(),
  z.object({ kind: z.literal("content"), expected: dataReferenceSchema, comparison: z.enum(["equals", "contains"]) }).strict(),
]);

const filesystemCheckpointSchema = z
  .object({
    checkpointId: entityIdSchema,
    kind: z.literal("filesystem"),
    timing: z.enum(["historical", "final"]),
    rootId: entityIdSchema,
    relativePath: relativePathSchema,
    assertion: filesystemAssertionSchema,
  })
  .strict();

export const checkpointSchema = z.discriminatedUnion("kind", [
  urlCheckpointSchema,
  visibleTextCheckpointSchema,
  controlStateCheckpointSchema,
  fieldValueCheckpointSchema,
  structuredValueCheckpointSchema,
  networkOutcomeCheckpointSchema,
  filesystemCheckpointSchema,
]);

export const allowedActionSchema = z.enum([
  "browser.navigate",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.download",
  "desktop.activate",
  "desktop.click",
  "desktop.type",
  "desktop.scroll",
  "desktop.shortcut",
  "desktop.invoke-menu",
  "filesystem.read",
  "filesystem.list",
  "filesystem.verify",
  "wait",
]);

export const routeSchema = z
  .object({
    schemaVersion: z.literal(1),
    goal: z.string().trim().min(1).max(4_000),
    hostSelection: z.enum(["thread", "any"]).optional(),
    identity: z
      .object({
        hostId: entityIdSchema,
        threadId: entityIdSchema,
        projectId: entityIdSchema.nullable(),
        environmentId: entityIdSchema.nullable(),
      })
      .strict(),
    browser: z
      .object({
        navigationOrigins: z.array(allowedOriginSchema).max(32),
        resourceOrigins: z.array(allowedOriginSchema).max(64),
        allowPopups: z.boolean(),
        allowDownloads: z.boolean(),
      })
      .strict(),
    decisionProvider: z
      .object({
        provider: z.enum(["fixture", "jev", "openrouter"]),
        model: z.string().min(1).max(200).nullable(),
        endpoint: z.string().url().max(2_048).nullable(),
      })
      .strict()
      .optional(),
    desktop: z
      .object({
        applications: z
          .array(
            z
              .object({
                appId: entityIdSchema,
                executable: z.string().min(1).max(255),
                windowTitle: z.string().min(1).max(300),
                titleMatch: z.enum(["exact", "prefix"]),
              })
              .strict(),
          )
          .max(16),
      })
      .strict(),
    filesystem: z
      .object({
        roots: z
          .array(
            z
              .object({
                rootId: entityIdSchema,
                kind: z.enum(["fixture", "output"]),
                absolutePath: absolutePathSchema,
                access: z.enum(["read-verify", "owned-output"]),
              })
              .strict(),
          )
          .max(16),
      })
      .strict(),
    allowedActions: z.array(allowedActionSchema).min(1).max(32),
    checkpoints: z.array(checkpointSchema).min(1).max(32),
    capture: capturePolicySchema,
    limits: z
      .object({
        maxRuntimeMs: z.number().int().min(1_000).max(1_800_000),
        maxActions: z.number().int().min(1).max(200),
        maxDecisions: z.number().int().min(1).max(400),
        maxProviderCalls: z.number().int().min(1).max(400),
        maxProviderTokens: z.number().int().min(1).max(2_000_000),
        maxProviderSpendMicrousd: z.number().int().nonnegative().max(100_000_000),
        maxNoProgressRounds: z.number().int().min(1).max(20),
        maxRequestRetries: z.number().int().nonnegative().max(5),
        maxArtifacts: z.number().int().min(1).max(200),
        maxArtifactBytes: z.number().int().min(65_536).max(536_870_912),
        maxCaptureBufferBytes: z.number().int().min(65_536).max(134_217_728),
      })
      .strict(),
  })
  .strict()
  .superRefine((route, context) => {
    if (new Set(route.allowedActions).size !== route.allowedActions.length) {
      context.addIssue({ code: "custom", path: ["allowedActions"], message: "allowedActions must be unique" });
    }
    const rootIds = new Set(route.filesystem.roots.map((root) => root.rootId));
    const duplicateRoot = rootIds.size !== route.filesystem.roots.length;
    if (duplicateRoot) {
      context.addIssue({ code: "custom", path: ["filesystem", "roots"], message: "rootId values must be unique" });
    }
    const checkpointIds = new Set(route.checkpoints.map((checkpoint) => checkpoint.checkpointId));
    if (checkpointIds.size !== route.checkpoints.length) {
      context.addIssue({ code: "custom", path: ["checkpoints"], message: "checkpointId values must be unique" });
    }
    for (const [index, checkpoint] of route.checkpoints.entries()) {
      if (checkpoint.kind === "filesystem" && !rootIds.has(checkpoint.rootId)) {
        context.addIssue({
          code: "custom",
          path: ["checkpoints", index, "rootId"],
          message: "Filesystem checkpoint refers to an undeclared root",
        });
      }
    }
  });

export type DataReference = z.infer<typeof dataReferenceSchema>;
export type TargetQuery = z.infer<typeof targetQuerySchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type WayfinderRoute = z.infer<typeof routeSchema>;
