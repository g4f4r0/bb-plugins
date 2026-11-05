// Voice tools configuration: where speech is recognized, with which model,
// in which language. Edited on the plugin's settings page (app.tsx) through
// the `config.*` RPC; the cloud API key is kept separately (see server.ts).
import { z } from "zod";
import type { Model as LocalModelId } from "./contract.js";

export interface ModelOption {
  id: string;
  label: string;
}

export const LOCAL_MODELS: readonly ModelOption[] = [
  { id: "parakeet-v3", label: "Parakeet v3" },
  { id: "whisper-small", label: "Whisper small" },
  { id: "whisper-large-v3-turbo", label: "Whisper large v3 turbo" },
];

/**
 * OpenRouter models worth offering, from a Nov 2026 benchmark on Multilingual
 * LibriSpeech (Spanish) and LibriSpeech test-clean (English), 10 clips each:
 * word error rate es / en, median seconds per clip.
 *   Voxtral Mini Transcribe 3   1.2% / 0.4%   0.8 s
 *   Parakeet v3                 1.7% / 0.8%   1.0 s (also handles long audio)
 *   ElevenLabs Scribe v2        1.2% / 0.8%   1.3 s
 * Left out: Whisper large v3 turbo (11.9% Spanish), Deepgram Nova-3 (no
 * Spanish without a fixed language), slower or costlier models.
 */
export const CLOUD_MODELS: readonly ModelOption[] = [
  { id: "mistralai/voxtral-mini-transcribe-3-0", label: "Voxtral Mini Transcribe 3" },
  { id: "nvidia/parakeet-tdt-0.6b-v3", label: "Parakeet v3" },
  { id: "elevenlabs/scribe-v2", label: "ElevenLabs Scribe v2" },
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
  return list.find((m) => m.id === id) ?? { id, label: id };
}
