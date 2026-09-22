import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { entityIdSchema } from "./primitives.js";

export const providerIdSchema = z.enum(["jev", "openrouter"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const hostSummarySchema = z
  .object({
    hostId: entityIdSchema,
    name: z.string(),
    status: z.enum(["connected", "disconnected"]),
    phase: z.string(),
  })
  .strict();
export type HostSummary = z.infer<typeof hostSummarySchema>;

/** Never carries a key value — only whether one currently resolves at the verified scope. */
export const keyStatusSchema = z.enum(["configured", "missing", "unknown"]);

export const wayfinderSettingsStateSchema = z
  .object({
    selectedHostId: entityIdSchema.nullable(),
    provider: providerIdSchema,
    model: z.string(),
    keyStatus: keyStatusSchema,
    lastTest: z
      .object({ ok: z.boolean(), message: z.string(), testedAt: z.number() })
      .strict()
      .nullable(),
  })
  .strict();
export type WayfinderSettingsState = z.infer<typeof wayfinderSettingsStateSchema>;

export const wayfinderSettingsRpcContract = defineRpcContract({
  "settings.hosts": {
    input: z.object({}).strict(),
    output: z.array(hostSummarySchema).max(200),
  },
  "settings.get": {
    input: z.object({}).strict(),
    output: wayfinderSettingsStateSchema,
  },
  "settings.selectHost": {
    input: z.object({ hostId: entityIdSchema.nullable() }).strict(),
    output: wayfinderSettingsStateSchema,
  },
  "settings.models": {
    input: z.object({ provider: providerIdSchema }).strict(),
    output: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(300) }).strict()).max(2000),
  },
  "settings.saveProvider": {
    input: z.object({ provider: providerIdSchema, model: z.string().min(1).max(200) }).strict(),
    output: wayfinderSettingsStateSchema,
  },
});
