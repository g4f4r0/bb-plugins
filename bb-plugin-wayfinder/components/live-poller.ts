import { LIVE_FRAME_HEADERS } from "../src/media/routes.js";
import { liveFrameUrl } from "./urls.js";

export type LiveViewStatus = "connecting" | "live" | "paused" | "redacted" | "disconnected" | "no-frame" | "not-found";

export interface LiveViewState {
  readonly status: LiveViewStatus;
  readonly imageUrl: string | null;
  readonly sequence: number | null;
  /** Server-measured frame age at receipt. */
  readonly frameAgeMs: number | null;
  readonly receivedAt: number | null;
}

export const INITIAL_LIVE_STATE: LiveViewState = {
  status: "connecting",
  imageUrl: null,
  sequence: null,
  frameAgeMs: null,
  receivedAt: null,
};

export interface LiveFramePollerOptions {
  readonly runId: string;
  readonly onState: (state: LiveViewState) => void;
  readonly fetch?: typeof fetch;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly isHidden?: () => boolean;
  readonly minIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxBackoffMs?: number;
  readonly now?: () => number;
}

/**
 * Read-only live view client. One request in flight; the next starts only
 * after the previous finished, so a slow connection lowers its own frame rate
 * instead of queueing. Hidden tabs stop polling, which lets the host viewer
 * lease expire and preview capture stop. The last safe frame remains visible
 * after disconnect; paused/redacted states still replace it explicitly.
 */
export class LiveFramePoller {
  readonly #options: LiveFramePollerOptions;
  readonly #fetch: typeof fetch;
  #state: LiveViewState = INITIAL_LIVE_STATE;
  #controller: AbortController | null = null;
  #failures = 0;

  constructor(options: LiveFramePollerOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  start(): void {
    if (this.#controller !== null) return;
    const controller = new AbortController();
    this.#controller = controller;
    void this.#loop(controller.signal);
  }

  stop(): void {
    this.#controller?.abort();
    this.#controller = null;
    this.#setImage(null);
  }

  async #loop(signal: AbortSignal): Promise<void> {
    const now = this.#options.now ?? Date.now;
    const minInterval = this.#options.minIntervalMs ?? 250;
    while (!signal.aborted) {
      if (this.#options.isHidden?.() ?? (typeof document !== "undefined" && document.visibilityState === "hidden")) {
        await delay(1_000, signal);
        continue;
      }
      const started = now();
      let wait = minInterval;
      try {
        await this.#pollOnce(signal);
        this.#failures = 0;
        if (this.#state.status === "not-found") wait = 10_000;
        else if (this.#state.status !== "live") wait = Math.max(minInterval, 1_000);
      } catch {
        if (signal.aborted) return;
        this.#failures += 1;
        this.#update({ status: "disconnected" });
        wait = Math.min(this.#options.maxBackoffMs ?? 5_000, 500 * 2 ** Math.min(this.#failures, 4));
      }
      await delay(Math.max(0, wait - (now() - started)), signal);
    }
  }

  async #pollOnce(signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.#options.requestTimeoutMs ?? 5_000);
    const response = await this.#fetch(liveFrameUrl(this.#options.runId, this.#state.sequence), {
      signal: AbortSignal.any([signal, timeout]),
      cache: "no-store",
      credentials: "same-origin",
    });
    const now = (this.#options.now ?? Date.now)();
    if (response.status === 404) {
      this.#setImage(null);
      this.#update({ status: "not-found", sequence: null, frameAgeMs: null, receivedAt: now });
      return;
    }
    if (response.status !== 200 && response.status !== 204) throw new Error(`Live frame request failed (${response.status})`);
    const state = response.headers.get(LIVE_FRAME_HEADERS.state);
    const sequence = parseHeaderInt(response.headers.get(LIVE_FRAME_HEADERS.sequence));
    const ageMs = parseHeaderInt(response.headers.get(LIVE_FRAME_HEADERS.ageMs));
    if (response.status === 200) {
      const blob = await response.blob();
      this.#setImage(blob);
      const frameStatus: LiveViewStatus = state === "paused" || state === "redacted" || state === "disconnected" ? state : "live";
      this.#update({ status: frameStatus, sequence, frameAgeMs: ageMs, receivedAt: now });
      return;
    }
    if (state === "live" && this.#state.imageUrl !== null) {
      // Unchanged frame: keep pixels, refresh the measured age.
      this.#update({ frameAgeMs: ageMs, receivedAt: now });
      return;
    }
    const status: LiveViewStatus =
      state === "paused" || state === "redacted" || state === "disconnected" ? state : "no-frame";
    if (status !== "disconnected") this.#setImage(null);
    this.#update({ status, sequence, frameAgeMs: ageMs, receivedAt: now });
  }

  #setImage(blob: Blob | null): void {
    const previous = this.#state.imageUrl;
    const next = blob === null ? null : (this.#options.createObjectURL ?? URL.createObjectURL)(blob);
    if (previous !== null) (this.#options.revokeObjectURL ?? URL.revokeObjectURL)(previous);
    this.#state = { ...this.#state, imageUrl: next };
    if (previous !== next) this.#options.onState(this.#state);
  }

  #update(patch: Partial<LiveViewState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#options.onState(this.#state);
  }
}

function parseHeaderInt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
