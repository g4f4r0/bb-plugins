// Shared by server.ts and host.ts: the model list, the host RPC contract, and
// the HTTP calls to the speech server (local or external).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Every model is multilingual. */
export const MODELS = ["parakeet-v3", "whisper-small", "whisper-large-v3-turbo"] as const;
export type Model = (typeof MODELS)[number];

export const MODEL_LABELS: Readonly<Record<Model, string>> = {
  "parakeet-v3": "Parakeet v3",
  "whisper-small": "Whisper small",
  "whisper-large-v3-turbo": "Whisper large v3 turbo",
};

/** Base64 grows audio by a third; host RPC input is capped at 32 MiB. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** One live-dictation chunk: about 4 s of 16 kHz int16 PCM, with headroom. */
export const MAX_STREAM_CHUNK_BYTES = 512 * 1024;
export const MAX_DICTATION_MINUTES = 20;

export const phaseSchema = z.enum(["idle", "installing", "starting", "ready", "failed", "unsupported"]);
export type Phase = z.infer<typeof phaseSchema>;

export const desiredSchema = z
  .object({
    model: z.enum(MODELS),
    /** Whisper only: ISO 639-1 code such as "en", or "auto". */
    language: z.string().regex(/^(auto|[a-z]{2,3})$/),
    /** Free the model's memory after this many idle minutes; 0 keeps it loaded. */
    unloadAfterMinutes: z.number().int().min(0).max(1_440),
  })
  .strict();
export type Desired = z.infer<typeof desiredSchema>;

export const hostStateSchema = z
  .object({
    phase: phaseSchema,
    /** What the host is doing now, or why it stopped. */
    message: z.string(),
    config: desiredSchema.nullable(),
    port: z.number().int().nullable(),
    /**
     * Restarting a server that already served (a setting changed or it
     * crashed); a recording sent now waits for it instead of failing.
     */
    reloading: z.boolean(),
    dataDir: z.string(),
    platform: z.string(),
  })
  .strict();
export type HostState = z.infer<typeof hostStateSchema>;

const streamId = z.string().regex(/^[a-f0-9]{32}$/);
export const streamResultSchema = z.object({ text: z.string(), seconds: z.number() }).strict();
export type StreamResult = z.infer<typeof streamResultSchema>;

export const hostContract = defineRpcContract({
  "voiceTools.ensure": {
    experimental_description:
      "Install the local speech server if needed and keep it running with this configuration; returns the current state without waiting.",
    input: desiredSchema.extend({ action: z.enum(["ensure", "restart", "reinstall"]) }).strict(),
    output: hostStateSchema,
  },
  "voiceTools.transcribe": {
    input: z
      .object({
        audioBase64: z.string().min(1),
        filename: z.string().min(1).max(200),
        mimeType: z.string().max(200),
        hint: z.string().max(2_000).nullable(),
      })
      .strict(),
    output: z.object({ text: z.string() }).strict(),
  },
  "voiceTools.stream.start": {
    input: z.object({}).strict(),
    output: z.object({ id: streamId }).strict(),
  },
  "voiceTools.stream.audio": {
    input: z.object({ id: streamId, pcmBase64: z.string().min(1) }).strict(),
    output: streamResultSchema,
  },
  "voiceTools.stream.finish": {
    input: z.object({ id: streamId }).strict(),
    output: streamResultSchema,
  },
  "voiceTools.stream.cancel": {
    input: z.object({ id: streamId }).strict(),
    output: z.object({}).strict(),
  },
  "voiceTools.stop": {
    experimental_description: "Stop the local speech server (cloud transcription is on).",
    input: z.object({}).strict(),
    output: hostStateSchema,
  },
  "voiceTools.logs": {
    input: z.object({ lines: z.number().int().min(1).max(500) }).strict(),
    output: z.object({ text: z.string() }).strict(),
  },
});

/** Pull a readable message out of a failed speech-server response. */
async function failure(response: Response, fallback: string): Promise<Error> {
  if (response.status === 401 || response.status === 403) {
    return new Error("The cloud API rejected the API key. Check it in Settings → Plugins → Voice tools.");
  }
  const raw = (await response.text()).slice(0, 2_000);
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === "object" && body !== null && "detail" in body && typeof body.detail === "string") {
      return new Error(body.detail.trim().slice(0, 500));
    }
    // OpenAI and OpenRouter: { "error": { "message": "…" } }
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return new Error(`${fallback}: ${message.trim().slice(0, 300)}`);
    }
  } catch {}
  if (response.status === 413) return new Error("The recording is too long or too large.");
  return new Error(`${fallback} (HTTP ${response.status})`);
}

/**
 * POST one recording to an OpenAI-compatible `<base>/audio/transcriptions`
 * endpoint; `baseUrl` includes the version segment (`…/v1`).
 */
export async function requestTranscription(
  baseUrl: string,
  audio: Blob,
  filename: string,
  options: { signal: AbortSignal; hint: string | null; model?: string; language?: string; apiKey?: string },
): Promise<string> {
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", options.model ?? "whisper-1");
  form.append("response_format", "json");
  if (options.language && options.language !== "auto") form.append("language", options.language);
  // Whisper treats the prompt as preceding text, which nudges spelling of names.
  if (options.hint) form.append("prompt", options.hint.slice(0, 1_000));
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    body: form,
    headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : undefined,
    signal: options.signal,
  });
  if (!response.ok) throw await failure(response, "Transcription failed. Try again");
  const body: unknown = await response.json();
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw new Error("The speech server returned no text");
  return text;
}

/** Live-dictation calls to the local speech server (speech_server.py). */
export async function streamRequest(
  baseUrl: string,
  path: string,
  init: { method: "POST" | "DELETE"; body?: Uint8Array<ArrayBuffer>; signal?: AbortSignal },
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    body: init.body,
    headers: init.body ? { "content-type": "application/octet-stream" } : undefined,
    signal: init.signal,
  });
  if (!response.ok) throw await failure(response, "Live dictation failed");
  return response.json();
}

/** Wrap 16 kHz mono int16 PCM in a WAV header, for servers that only take files. */
export function pcmToWav(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  header.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, 16_000, true);
  header.setUint32(28, 32_000, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, pcm.byteLength, true);
  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(new Uint8Array(header.buffer), 0);
  wav.set(pcm, 44);
  return wav;
}
