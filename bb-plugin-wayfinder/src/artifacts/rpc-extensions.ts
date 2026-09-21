import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  artifactRecordSchema,
  artifactShareRecordSchema,
  createArtifactShareOutputSchema,
} from "../contracts/artifact.js";
import { entityIdSchema } from "../contracts/primitives.js";

/**
 * PROPOSED additions to `wayfinderRpcContract` for the integration phase.
 * The UI depends on them; Step 4 moves them into `src/contracts/api.ts`.
 *
 * - `artifacts.get`: thread-scoped single lookup for inline cards (a foreign
 *   thread gets `not-found`), so cards need not page through `artifacts.list`.
 * - `artifacts.shareStatus`: tells the UI whether Share can work before it is
 *   shown as enabled, and lists the run's existing shares for revocation.
 * - `artifacts.createShare`/`revokeShare` need the caller's thread for
 *   scoping; the current contract carries only run/share IDs. The scoped
 *   variants below add `threadId` and can replace the originals.
 */
export const artifactRpcExtensions = defineRpcContract({
  "artifacts.get": {
    input: z.object({ threadId: entityIdSchema, artifactId: entityIdSchema }).strict(),
    output: artifactRecordSchema,
  },
  "artifacts.shareStatus": {
    input: z.object({ threadId: entityIdSchema, runId: entityIdSchema }).strict(),
    output: z
      .object({
        external: z.discriminatedUnion("state", [
          z.object({ state: z.literal("ready") }).strict(),
          z.object({ state: z.literal("disabled"), reason: z.string().min(1).max(500) }).strict(),
        ]),
        shares: z.array(artifactShareRecordSchema).max(200),
      })
      .strict(),
  },
  "artifacts.createShareScoped": {
    input: z
      .object({
        threadId: entityIdSchema,
        runId: entityIdSchema,
        artifactIds: z.array(entityIdSchema).min(1).max(32),
        expiresInSeconds: z.number().int().min(60).max(604_800),
        audience: z.literal("anyone-with-link"),
      })
      .strict(),
    output: createArtifactShareOutputSchema,
  },
  "artifacts.revokeShareScoped": {
    input: z.object({ threadId: entityIdSchema, shareId: entityIdSchema }).strict(),
    output: artifactShareRecordSchema,
  },
});
