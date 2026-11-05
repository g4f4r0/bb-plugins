// Live dictation in the browser: capture the microphone, downsample to
// 16 kHz mono int16, and send it to the plugin server about once a second
// while the user talks. The server transcribes as audio arrives, so stopping
// only waits for the last moment of speech.

/** Server calls a dictation needs; implemented over the plugin RPC. */
export interface DictationTransport {
  start(): Promise<{ id: string }>;
  audio(id: string, pcmBase64: string): Promise<{ text: string; seconds: number }>;
  finish(id: string): Promise<{ text: string; seconds: number }>;
  cancel(id: string): Promise<void>;
}

export type DictationPhase = "idle" | "starting" | "recording" | "finishing";

export interface DictationSnapshot {
  phase: DictationPhase;
  /** Seconds recorded so far. */
  seconds: number;
  /** Text recognized so far (live mode). */
  liveText: string;
  /** The microphone stream while recording, for bb's waveform. */
  stream: MediaStream | null;
}

const TARGET_RATE = 16_000;
const SEND_EVERY_SAMPLES = TARGET_RATE; // ~1 s
export const MAX_DICTATION_SECONDS = 20 * 60;

/**
 * Box-filter downsampler from the AudioContext rate to 16 kHz. Keeps the
 * fractional read position between calls so chunk edges add no clicks.
 */
export class Downsampler {
  private carry = new Float32Array(0);
  private position = 0;
  private readonly ratio: number;

  constructor(inputRate: number) {
    this.ratio = inputRate / TARGET_RATE;
  }

  /** Float samples in [-1, 1] at the input rate → int16 samples at 16 kHz. */
  push(input: Float32Array): Int16Array {
    const buffer = new Float32Array(this.carry.length + input.length);
    buffer.set(this.carry, 0);
    buffer.set(input, this.carry.length);
    const out = new Int16Array(Math.max(0, Math.floor((buffer.length - this.position) / this.ratio)));
    let written = 0;
    let pos = this.position;
    while (pos + this.ratio <= buffer.length && written < out.length) {
      const start = Math.floor(pos);
      const end = Math.max(start + 1, Math.floor(pos + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += buffer[i]!;
      const sample = Math.max(-1, Math.min(1, sum / (end - start)));
      out[written++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      pos += this.ratio;
    }
    const keepFrom = Math.floor(pos);
    this.carry = buffer.slice(keepFrom);
    this.position = pos - keepFrom;
    return out.subarray(0, written);
  }
}

export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** One dictation, from pressing the mic to inserting the text. */
export class Dictation {
  private snapshot: DictationSnapshot = { phase: "idle", seconds: 0, liveText: "", stream: null };
  private readonly listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private totalSamples = 0;
  private id: Promise<string> | null = null;
  /** Sends run one at a time, in order. */
  private sending: Promise<void> = Promise.resolve();
  private failure: Error | null = null;

  private readonly transport: DictationTransport;

  constructor(transport: DictationTransport) {
    this.transport = transport;
  }

  get state(): DictationSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start recording. Audio captured before the server answers is kept. */
  async start(): Promise<void> {
    if (this.snapshot.phase !== "idle") return;
    this.update({ phase: "starting", seconds: 0, liveText: "", stream: null });
    const started = this.transport.start();
    this.id = started.then((result) => result.id);
    this.id.catch(() => {});
    try {
      this.stream = await openMicrophone();
      // The context runs at the device rate; Firefox cannot connect a mic to
      // a context at another rate, so downsampling happens here instead.
      this.context = new AudioContext();
      const source = this.context.createMediaStreamSource(this.stream);
      const downsampler = new Downsampler(this.context.sampleRate);
      // ScriptProcessorNode is deprecated but works in every browser without
      // loading a worklet module (which a strict CSP can block).
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (event) => {
        const phase = this.snapshot.phase;
        if (phase !== "recording" && phase !== "starting") return;
        this.collect(downsampler.push(event.inputBuffer.getChannelData(0)));
        this.snapshot = { ...this.snapshot, seconds: this.totalSamples / TARGET_RATE };
        if (this.totalSamples >= MAX_DICTATION_SECONDS * TARGET_RATE) void this.stopCapture();
      };
      source.connect(this.processor);
      this.processor.connect(this.context.destination);
      if (this.context.state === "suspended") await this.context.resume();
      await started; // surface "not ready" before showing the recording UI
      this.update({ phase: "recording", stream: this.stream });
    } catch (error) {
      await this.teardown();
      this.id?.then((id) => this.transport.cancel(id)).catch(() => {});
      this.reset();
      throw asError(error);
    }
  }

  /** Stop recording and return the full transcript. */
  async stop(): Promise<string> {
    if (this.snapshot.phase !== "recording") return "";
    this.update({ phase: "finishing" });
    try {
      await this.stopCapture();
      await this.sending;
      if (this.failure) throw this.failure;
      const id = await this.id!;
      const { text } = await this.transport.finish(id);
      return text.trim();
    } finally {
      this.reset();
    }
  }

  /** Discard the recording. */
  async cancel(): Promise<void> {
    if (this.snapshot.phase === "idle") return;
    await this.teardown();
    const id = this.id;
    this.reset();
    if (id) void id.then((value) => this.transport.cancel(value)).catch(() => {});
  }

  private collect(samples: Int16Array): void {
    if (samples.length === 0) return;
    this.pending.push(samples.slice());
    this.pendingSamples += samples.length;
    this.totalSamples += samples.length;
    if (this.pendingSamples >= SEND_EVERY_SAMPLES) this.flush();
  }

  private flush(): void {
    if (this.pendingSamples === 0) return;
    const merged = new Int16Array(this.pendingSamples);
    let offset = 0;
    for (const part of this.pending) {
      merged.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    this.pendingSamples = 0;
    const payload = int16ToBase64(merged);
    this.sending = this.sending.then(async () => {
      if (this.failure || this.id === null) return;
      try {
        const id = await this.id;
        const result = await this.transport.audio(id, payload);
        if (this.snapshot.phase !== "idle") this.update({ liveText: result.text });
      } catch (error) {
        this.failure = asError(error);
      }
    });
  }

  private async stopCapture(): Promise<void> {
    await this.teardown();
    this.flush();
  }

  private async teardown(): Promise<void> {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    const context = this.context;
    this.context = null;
    await context?.close().catch(() => {});
  }

  private reset(): void {
    this.pending = [];
    this.pendingSamples = 0;
    this.totalSamples = 0;
    this.id = null;
    this.sending = Promise.resolve();
    this.failure = null;
    this.update({ phase: "idle", seconds: 0, liveText: "", stream: null });
  }

  private update(patch: Partial<DictationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

// ── microphone choice (per browser) ──────────────────────────────────────

const MIC_KEY = "voice-tools.microphoneId";
/** bb's own choice in its voice preferences, used until one is picked here. */
const BB_MIC_KEY = "bb.voiceInput.audioInputDeviceId";

function readStoredId(key: string): string | null {
  try {
    let value = localStorage.getItem(key);
    if (value && value.startsWith('"')) value = JSON.parse(value) as string;
    return value && value !== "default" ? value : null;
  } catch {
    return null;
  }
}

/** The chosen microphone's device id, or null for the system default. */
export function chosenMicrophone(): string | null {
  const own = localStorage.getItem(MIC_KEY);
  if (own !== null) return own === "" ? null : own;
  return readStoredId(BB_MIC_KEY);
}

export function chooseMicrophone(deviceId: string | null): void {
  localStorage.setItem(MIC_KEY, deviceId ?? "");
}

export interface Microphone {
  deviceId: string;
  label: string;
}

/** Microphones the browser exposes; labels are empty until access was granted once. */
export async function listMicrophones(): Promise<{ microphones: Microphone[]; labelled: boolean }> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default");
  const seen = new Set<string>();
  const microphones: Microphone[] = [];
  for (const d of inputs) {
    if (seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    microphones.push({ deviceId: d.deviceId, label: d.label.trim() || `Microphone ${microphones.length + 1}` });
  }
  return { microphones, labelled: inputs.some((d) => d.label.trim().length > 0) };
}

/** Ask for microphone access once so device names become visible. */
export async function allowMicrophoneAccess(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
}

const AUDIO = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const;

/** Open the chosen microphone, falling back to the default if it is gone. */
async function openMicrophone(): Promise<MediaStream> {
  const id = chosenMicrophone();
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO, deviceId: { exact: id } } });
    } catch (error) {
      const gone = error instanceof DOMException && ["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(error.name);
      if (!gone) throw error;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: AUDIO });
}

function asError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return new Error("Microphone access was denied. Allow it in your browser's site settings.");
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return new Error("No microphone was found.");
  }
  return error instanceof Error ? error : new Error(String(error));
}
