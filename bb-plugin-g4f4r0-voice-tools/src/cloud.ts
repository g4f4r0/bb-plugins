// Cloud transcription: any OpenAI-compatible speech-to-text API (OpenRouter
// by default). Live dictation cuts the PCM stream at pauses, the same way the
// local speech server does, and sends each piece while the user keeps talking,
// so stopping only waits for the last piece.
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
const HOP = RATE / 100; // 10 ms energy frames
// Pieces this long keep whole sentences: 3-second pieces split them and hurt
// accuracy. Most dictations are one piece, sent when the user stops.
const MIN_PIECE_S = 20;
const MAX_PIECE_S = 40;
const MAX_IN_FLIGHT = 4;
const PIECE_TIMEOUT_MS = 60_000;

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

/** Mean power per 10 ms frame, smoothed over ~200 ms. */
export function frameEnergy(samples: Int16Array): Float32Array {
  const frames = Math.floor(samples.length / HOP);
  const raw = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) {
      const v = samples[i]! / 32768;
      sum += v * v;
    }
    raw[f] = sum / HOP;
  }
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, f - 10); k <= Math.min(frames - 1, f + 10); k++) {
      sum += raw[k]!;
      n++;
    }
    smooth[f] = sum / n;
  }
  return smooth;
}

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Runs of `quiet` frames as [start, end) pairs. */
function quietRuns(quiet: boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  quiet.forEach((q, i) => {
    if (q && start < 0) start = i;
    if (!q && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  });
  if (start >= 0) runs.push([start, quiet.length]);
  return runs;
}

/**
 * Where to cut `pending`, in samples, or null to keep listening: the longest
 * real pause (>= 0.5 s) once the piece is MIN_PIECE_S long, or the quietest
 * point once it reaches MAX_PIECE_S.
 */
export function findCut(pending: Int16Array, speechLevel: number): number | null {
  const energy = frameEnergy(pending);
  if (energy.length < MIN_PIECE_S * 100) return null;
  const quiet = Array.from(energy, (e) => e < 0.05 * speechLevel);
  const minFrame = MIN_PIECE_S * 100;
  const pauses = quietRuns(quiet).filter(([a, b]) => b - a >= 50 && (a + b) / 2 >= minFrame);
  if (pauses.length > 0) {
    const [a, b] = pauses.reduce((best, run) => (run[1] - run[0] > best[1] - best[0] ? run : best));
    return Math.floor((a + b) / 2) * HOP;
  }
  if (pending.length >= MAX_PIECE_S * RATE) {
    const lo = (MAX_PIECE_S / 2) * 100;
    let best = lo;
    for (let f = lo; f < energy.length; f++) if (energy[f]! < energy[best]!) best = f;
    return best * HOP;
  }
  return null;
}

/** One live dictation transcribed by the cloud API, piece by piece. */
export class CloudDictation {
  private pending = new Int16Array(0);
  private speechLevel = 1e-5;
  private totalSamples = 0;
  private readonly results: (string | undefined)[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private failure: Error | null = null;
  private readonly controller = new AbortController();
  touched = Date.now();

  private readonly config: CloudConfig;

  constructor(config: CloudConfig) {
    this.config = config;
  }

  get seconds(): number {
    return this.totalSamples / RATE;
  }

  /** Text of the pieces recognized so far, in order, up to the first unfinished one. */
  get text(): string {
    const done: string[] = [];
    for (const piece of this.results) {
      if (piece === undefined) break;
      if (piece) done.push(piece);
    }
    return done.join(" ");
  }

  async append(pcm: Buffer): Promise<void> {
    this.touched = Date.now();
    const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1)));
    this.totalSamples += samples.length;
    const energy = frameEnergy(samples);
    if (energy.length) this.speechLevel = Math.max(this.speechLevel, percentile(energy, 80));
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending, 0);
    merged.set(samples, this.pending.length);
    this.pending = merged;
    for (let cut = findCut(this.pending, this.speechLevel); cut !== null; cut = findCut(this.pending, this.speechLevel)) {
      await this.submit(this.pending.slice(0, cut));
      this.pending = this.pending.slice(cut);
    }
    if (this.failure) throw this.failure;
  }

  async finish(): Promise<string> {
    if (this.pending.length > 0) await this.submit(this.pending);
    this.pending = new Int16Array(0);
    await Promise.all(this.inFlight);
    if (this.failure) throw this.failure;
    return this.text;
  }

  cancel(): void {
    this.controller.abort();
  }

  private async submit(piece: Int16Array): Promise<void> {
    const energy = frameEnergy(piece);
    if (!energy.some((e) => e >= 0.05 * this.speechLevel)) return; // silence: skip the request
    while (this.inFlight.size >= MAX_IN_FLIGHT) await Promise.race(this.inFlight);
    const index = this.results.push(undefined) - 1;
    // Silence around the piece: the model drops a first word that starts at
    // sample 0 ("ask not" at a cut) and a last word cut off by the stop button.
    const lead = Math.round(0.3 * RATE);
    const padded = new Int16Array(lead + piece.length + Math.round(0.6 * RATE));
    padded.set(piece, lead);
    const wav = pcmToWav(new Uint8Array(padded.buffer));
    const job = cloudTranscribe(this.config, new Blob([wav], { type: "audio/wav" }), "dictation.wav", {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(PIECE_TIMEOUT_MS)]),
      hint: null,
    })
      .then((text) => {
        this.results[index] = text.trim();
      })
      .catch((error: unknown) => {
        this.results[index] = "";
        this.failure ??= error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => this.inFlight.delete(job));
    this.inFlight.add(job);
  }
}
