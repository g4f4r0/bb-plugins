// Voice tools configuration: where speech is recognized, with which model,
// in which language. Edited on the plugin's settings page (app.tsx) through
// the `config.*` RPC; the cloud API key is kept separately (see server.ts).
import { z } from "zod";
import type { Model as LocalModelId } from "./contract.js";

export interface ModelOption {
  id: string;
  label: string;
  /** One short line shown under the dropdown. */
  detail: string;
}

export const LOCAL_MODELS: readonly ModelOption[] = [
  { id: "parakeet-v3", label: "Parakeet v3", detail: "Fastest here. 25 European languages." },
  { id: "whisper-small", label: "Whisper small", detail: "Every language. Slower than Parakeet." },
  {
    id: "whisper-large-v3-turbo",
    label: "Whisper large v3 turbo",
    detail: "Every language, most accurate. Slow without a GPU.",
  },
];

/** OpenRouter speech models; all multilingual. Timed on a 9 s clip, Nov 2026. */
export const CLOUD_MODELS: readonly ModelOption[] = [
  { id: "mistralai/voxtral-mini-transcribe-3-0", label: "Voxtral Mini Transcribe 3", detail: "Fastest, about 0.6 s per clip." },
  { id: "nvidia/parakeet-tdt-0.6b-v3", label: "Parakeet v3", detail: "Same model as local, on a GPU. 25 European languages." },
  { id: "openai/whisper-large-v3-turbo", label: "Whisper large v3 turbo", detail: "Every language." },
  { id: "elevenlabs/scribe-v2", label: "ElevenLabs Scribe v2", detail: "Best punctuation. Costs more." },
];

export const LANGUAGES: readonly { id: string; label: string }[] = [
  { id: "auto", label: "Detect automatically" },
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "pt", label: "Portuguese" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "nl", label: "Dutch" },
  { id: "pl", label: "Polish" },
  { id: "ru", label: "Russian" },
  { id: "uk", label: "Ukrainian" },
  { id: "tr", label: "Turkish" },
  { id: "ar", label: "Arabic" },
  { id: "hi", label: "Hindi" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "zh", label: "Chinese" },
];

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export const configSchema = z
  .object({
    source: z.enum(["local", "cloud"]),
    localModel: z.enum(LOCAL_MODELS.map((m) => m.id) as [LocalModelId, ...LocalModelId[]]),
    cloudModel: z.string().min(1).max(200),
    language: z.enum(LANGUAGES.map((l) => l.id) as [string, ...string[]]),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Config = {
  source: "local",
  localModel: "parakeet-v3",
  cloudModel: CLOUD_MODELS[0]!.id,
  language: "auto",
};

/** The model the current source uses. */
export function activeModel(config: Config): ModelOption {
  const list = config.source === "cloud" ? CLOUD_MODELS : LOCAL_MODELS;
  const id = config.source === "cloud" ? config.cloudModel : config.localModel;
  return list.find((m) => m.id === id) ?? { id, label: id, detail: "" };
}
