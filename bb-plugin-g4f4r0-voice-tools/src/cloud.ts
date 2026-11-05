// Cloud transcription through OpenRouter. A composer dictation buffers its
// audio while the user talks and is transcribed whole when they stop: one pass
// keeps punctuation and wording consistent, which pieces transcribed
// separately did not.
import { pcmToWav, requestTranscription } from "./contract.js";

export interface CloudConfig {
  /** Base URL including the version segment, e.g. https://openrouter.ai/api/v1. */
  url: string;
  apiKey: string;
  model: string;
  /** ISO 639-1 code or "auto". */
  language: string;
}

const RATE = 16_000;
/** Generous: a long dictation is one request at stop. */
const REQUEST_TIMEOUT_MS = 120_000;

export function cloudTranscribe(
  config: CloudConfig,
  audio: Blob,
  filename: string,
  options: { signal: AbortSignal; hint: string | null },
): Promise<string> {
  return requestTranscription(config.url, audio, filename, {
    signal: options.signal,
    hint: options.hint,
    model: config.model,
    language: config.language,
    apiKey: config.apiKey,
  });
}

/** One composer dictation: audio buffered on the server, transcribed at stop. */
export class CloudDictation {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private readonly controller = new AbortController();
  touched = Date.now();

  private readonly config: CloudConfig;

  constructor(config: CloudConfig) {
    this.config = config;
  }

  get model(): string {
    return this.config.model;
  }

  get seconds(): number {
    return this.bytes / 2 / RATE;
  }

  append(pcm: Buffer): void {
    this.touched = Date.now();
    this.chunks.push(pcm);
    this.bytes += pcm.byteLength;
  }

  /** Transcribe the whole dictation with `model` (defaults to the configured one). */
  async finish(model = this.config.model): Promise<string> {
    if (this.bytes === 0) return "";
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    // Silence around the audio: the model drops a word cut off at the very
    // start or by the stop button.
    const lead = Math.round(0.3 * RATE) * 2;
    const tail = Math.round(0.6 * RATE) * 2;
    const padded = new Uint8Array(lead + (pcm.byteLength & ~1) + tail);
    padded.set(pcm.subarray(0, pcm.byteLength & ~1), lead);
    const wav = pcmToWav(padded);
    const text = await cloudTranscribe({ ...this.config, model }, new Blob([wav], { type: "audio/wav" }), "dictation.wav", {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      hint: null,
    });
    return text.trim();
  }

  cancel(): void {
    this.controller.abort();
  }
}
