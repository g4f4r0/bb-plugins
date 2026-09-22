import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  artifactRecordSchema,
  artifactShareRecordSchema,
  createArtifactShareInputSchema,
  createArtifactShareOutputSchema,
} from "./artifact.js";
import { entityIdSchema } from "./primitives.js";
import {
  computerSnapshotSchema,
  humanInputSchema,
  runRecordSchema,
  startRunInputSchema,
  startRunOutputSchema,
} from "./run.js";

export const wayfinderRpcContract = defineRpcContract({
  "runs.start": {
    input: startRunInputSchema,
    output: startRunOutputSchema,
  },
  "runs.status": {
    input: z.object({ runId: entityIdSchema }).strict(),
    output: runRecordSchema,
  },
  "runs.cancel": {
    input: z.object({ runId: entityIdSchema, reason: z.string().min(1).max(500) }).strict(),
    output: runRecordSchema,
  },
  "computer.snapshot": {
    input: z.object({ hostId: entityIdSchema, selectedRunId: entityIdSchema.nullable() }).strict(),
    output: computerSnapshotSchema,
  },
  "computer.control.acquire": {
    input: z.object({ hostId: entityIdSchema, runId: entityIdSchema, clientId: entityIdSchema }).strict(),
    output: z.object({ state: z.enum(["human", "busy"]) }).strict(),
  },
  "computer.control.release": {
    input: z.object({ hostId: entityIdSchema, runId: entityIdSchema, clientId: entityIdSchema }).strict(),
    output: z.object({ released: z.boolean() }).strict(),
  },
  "computer.control.input": {
    input: z.object({ hostId: entityIdSchema, runId: entityIdSchema, clientId: entityIdSchema, input: humanInputSchema }).strict(),
    output: z.object({ accepted: z.literal(true) }).strict(),
  },
  "artifacts.list": {
    input: z
      .object({
        threadId: entityIdSchema,
        runId: entityIdSchema.nullable(),
        cursor: entityIdSchema.nullable(),
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    output: z
      .object({
        artifacts: z.array(artifactRecordSchema).max(100),
        nextCursor: entityIdSchema.nullable(),
      })
      .strict(),
  },
  "artifacts.createShare": {
    input: createArtifactShareInputSchema,
    output: createArtifactShareOutputSchema,
  },
  "artifacts.revokeShare": {
    input: z.object({ shareId: entityIdSchema }).strict(),
    output: artifactShareRecordSchema,
  },
});
