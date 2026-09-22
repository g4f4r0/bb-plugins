import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const providerIdSchema = z.enum(["jev", "openrouter"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

/** Never carries a key value — only whether one currently resolves at the verified scope. */
export const keyStatusSchema = z.enum(["configured", "missing", "unknown"]);

export const wayfinderSettingsStateSchema = z.object({
  provider: providerIdSchema,
  model: z.string(),
  keyStatus: keyStatusSchema,
  lastTest: z.object({ ok: z.boolean(), message: z.string(), testedAt: z.number() }).strict().nullable(),
}).strict();
export type WayfinderSettingsState = z.infer<typeof wayfinderSettingsStateSchema>;

export const wayfinderSettingsRpcContract = defineRpcContract({
  "settings.get": { input: z.object({}).strict(), output: wayfinderSettingsStateSchema },
  "settings.saveProvider": {
    input: z.object({ provider: providerIdSchema, model: z.string().min(1).max(200) }).strict(),
    output: wayfinderSettingsStateSchema,
  },
});
