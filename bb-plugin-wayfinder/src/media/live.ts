import { entityIdSchema } from "../contracts/primitives.js";
import { LIVE_FRAME_HEADERS } from "./routes.js";

export { LIVE_FRAME_HEADERS, liveHttpRoutes } from "./routes.js";

export type LiveFrameState = "live" | "paused" | "redacted" | "disconnected";
export type LiveFrameMimeType = "image/webp" | "image/jpeg" | "image/png";

export interface LiveFrame {
  readonly sequence: number;
  readonly capturedAt: number;
  readonly mimeType: LiveFrameMimeType;
  readonly width: number;
  readonly height: number;
  /** Null whenever the state is not `live`: stale pixels are never served. */
  readonly bytes: Uint8Array | null;
  readonly state: LiveFrameState;
}

export interface CapturedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: LiveFrameMimeType;
  readonly width: number;
  readonly height: number;
}

export interface LiveCaptureOptions {
  /** Captures only the bound browser viewport or app window, never the whole desktop. */
  readonly capture: (signal: AbortSignal) => Promise<CapturedImage>;
  readonly policy: { readonly enabled: boolean; readonly maxFps: number; readonly maxFrameBytes: number };
  /** True during protected-input intervals; capture is suspended, not masked. */
  readonly isProtected: () => boolean;
  readonly viewerTtlMs?: number;
  readonly now?: () => number;
}

export interface LiveCaptureStats {
  captured: number;
  droppedOversize: number;
  failures: number;
  idleWaits: number;
}

/**
 * One demand-driven preview feed per run (host side). It captures only while
 * a viewer lease is fresh, at most `maxFps`, one capture in flight. Oversized
 * frames are dropped; protected intervals publish a byte-less `redacted`
 * frame that replaces the previous pixels. Viewers read the latest frame and
 * can never slow capture or execution.
 */
export class LiveCaptureLoop {
  readonly stats: LiveCaptureStats = { captured: 0, droppedOversize: 0, failures: 0, idleWaits: 0 };
  readonly #options: LiveCaptureOptions;
  readonly #now: () => number;
  readonly #viewerTtlMs: number;
  readonly #viewers = new Map<string, number>();
  #latest: LiveFrame | null = null;
  #sequence = 0;
  #wake: (() => void) | null = null;

  constructor(options: LiveCaptureOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#viewerTtlMs = options.viewerTtlMs ?? 5_000;
  }

  /** Refreshes a viewer lease; the server relay touches it on each fetch. */
  touchViewer(viewerId: string): void {
    this.#viewers.set(viewerId, this.#now() + this.#viewerTtlMs);
    this.#wake?.();
  }

  activeViewerCount(): number {
    const now = this.#now();
    for (const [id, expiresAt] of this.#viewers) if (expiresAt <= now) this.#viewers.delete(id);
    return this.#viewers.size;
  }

  latest(afterSequence: number | null): LiveFrame | null {
    const frame = this.#latest;
    if (frame === null || (afterSequence !== null && frame.sequence <= afterSequence)) return null;
    return frame;
  }

  /** Marks the feed disconnected (run ended, window lost) and drops pixels. */
  disconnect(): void {
    this.#publishState("disconnected");
  }

  async run(signal: AbortSignal): Promise<void> {
    const { policy } = this.#options;
    const intervalMs = 1_000 / Math.min(12, Math.max(0.2, policy.maxFps));
    try {
      while (!signal.aborted) {
        if (!policy.enabled) {
          this.#publishState("paused");
          await waitForAbort(signal);
          break;
        }
        if (this.activeViewerCount() === 0) {
          this.stats.idleWaits += 1;
          await this.#waitForDemand(signal);
          continue;
        }
        const started = this.#now();
        if (this.#options.isProtected()) {
          this.#publishState("redacted");
        } else {
          try {
            const image = await this.#options.capture(signal);
            if (image.bytes.length > policy.maxFrameBytes) this.stats.droppedOversize += 1;
            else {
              this.stats.captured += 1;
              this.#publish({ ...image, state: "live", capturedAt: started });
            }
          } catch {
            if (signal.aborted) break;
            this.stats.failures += 1;
            this.#publishState("disconnected");
          }
        }
        await sleep(Math.max(0, intervalMs - (this.#now() - started)), signal);
      }
    } finally {
      this.#publishState("disconnected");
    }
  }

  #publishState(state: Exclude<LiveFrameState, "live">): void {
    if (this.#latest?.state === state) return;
    this.#publish({ bytes: null, mimeType: "image/webp", width: 1, height: 1, state, capturedAt: this.#now() });
  }

  #publish(frame: Omit<LiveFrame, "sequence">): void {
    this.#sequence += 1;
    this.#latest = { ...frame, sequence: this.#sequence };
  }

  #waitForDemand(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.#wake = null;
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.#wake = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

const waitForAbort = (signal: AbortSignal) => sleep(2 ** 31 - 1, signal);

/** Host `media.latest` frame shape (base64 over host RPC). */
export interface HostFrame {
  readonly sequence: number;
  readonly capturedAt: number;
  readonly mimeType: LiveFrameMimeType;
  readonly width: number;
  readonly height: number;
  readonly bytesBase64: string;
  readonly state: LiveFrameState;
}

export function toHostFrame(frame: LiveFrame): HostFrame {
  return {
    sequence: frame.sequence,
    capturedAt: frame.capturedAt,
    mimeType: frame.mimeType,
    width: frame.width,
    height: frame.height,
    bytesBase64: frame.bytes === null ? "" : Buffer.from(frame.bytes).toString("base64"),
    state: frame.state,
  };
}

export interface LiveFrameRelayOptions {
  readonly fetchLatest: (runId: string, afterSequence: number | null, signal: AbortSignal) => Promise<HostFrame | null>;
  /** Minimum spacing of host fetches per run, shared by every viewer. */
  readonly minFetchIntervalMs?: number;
  readonly fetchTimeoutMs?: number;
  readonly maxRuns?: number;
  readonly now?: () => number;
}

interface RelayEntry {
  frame: LiveFrame | null;
  fetchedAt: number;
  inflight: Promise<LiveFrame | null> | null;
}

/**
 * Server-side fan-out. Any number of viewers share one single-flight host
 * fetch per interval per run; a slow viewer only delays its own HTTP response.
 */
export class LiveFrameRelay {
  readonly #options: LiveFrameRelayOptions;
  readonly #now: () => number;
  readonly #entries = new Map<string, RelayEntry>();
  hostFetches = 0;

  constructor(options: LiveFrameRelayOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async latest(runId: string): Promise<LiveFrame | null> {
    let entry = this.#entries.get(runId);
    if (entry === undefined) {
      entry = { frame: null, fetchedAt: 0, inflight: null };
      this.#entries.set(runId, entry);
      this.#evict();
    }
    if (entry.inflight !== null) return entry.inflight;
    if (entry.frame !== null && this.#now() - entry.fetchedAt < (this.#options.minFetchIntervalMs ?? 83)) return entry.frame;
    const current = entry;
    current.inflight = (async () => {
      try {
        this.hostFetches += 1;
        const signal = AbortSignal.timeout(this.#options.fetchTimeoutMs ?? 3_000);
        const next = await this.#options.fetchLatest(runId, current.frame?.sequence ?? null, signal);
        if (next !== null) current.frame = fromHostFrame(next);
        current.fetchedAt = this.#now();
        return current.frame;
      } catch {
        current.frame = current.frame === null ? null : { ...current.frame, bytes: null, state: "disconnected" };
        current.fetchedAt = this.#now();
        return current.frame;
      } finally {
        current.inflight = null;
      }
    })();
    return current.inflight;
  }

  forget(runId: string): void {
    this.#entries.delete(runId);
  }

  #evict(): void {
    const max = this.#options.maxRuns ?? 8;
    while (this.#entries.size > max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

function fromHostFrame(frame: HostFrame): LiveFrame {
  const live = frame.state === "live" && frame.bytesBase64.length > 0;
  return {
    sequence: frame.sequence,
    capturedAt: frame.capturedAt,
    mimeType: frame.mimeType,
    width: frame.width,
    height: frame.height,
    bytes: live ? Buffer.from(frame.bytesBase64, "base64") : null,
    state: live ? "live" : frame.state === "live" ? "disconnected" : frame.state,
  };
}

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};

/**
 * Handler for `bb.http.route("GET", liveHttpRoutes.frame, …, { auth: "local" })`.
 * It never accepts share tokens: the live computer view is private to
 * authenticated BB clients and is never exported. `authorize` must confirm the
 * run exists on this host (read-only viewing; there is no input path).
 */
export function createLiveFrameHandler(options: {
  readonly relay: LiveFrameRelay;
  readonly authorize: (runId: string) => boolean | Promise<boolean>;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.searchParams.has("token") || url.searchParams.has("share")) return jsonResponse(400, { error: "live view is not shareable" });
    const runId = entityIdSchema.safeParse(url.searchParams.get("runId"));
    const rawAfter = url.searchParams.get("after");
    const after = rawAfter === null || rawAfter === "" ? null : Number(rawAfter);
    if (!runId.success || (after !== null && (!Number.isSafeInteger(after) || after < 0))) {
      return jsonResponse(400, { error: "invalid runId or after" });
    }
    if (!(await options.authorize(runId.data))) return jsonResponse(404, { error: "run not found" });
    const frame = await options.relay.latest(runId.data);
    if (frame === null) return new Response(null, { status: 204, headers: { ...PRIVATE_HEADERS, [LIVE_FRAME_HEADERS.state]: "none" } });
    const headers = {
      ...PRIVATE_HEADERS,
      [LIVE_FRAME_HEADERS.sequence]: String(frame.sequence),
      [LIVE_FRAME_HEADERS.state]: frame.state,
      [LIVE_FRAME_HEADERS.ageMs]: String(Math.max(0, now() - frame.capturedAt)),
    };
    if (after !== null && frame.sequence <= after) return new Response(null, { status: 204, headers });
    if (frame.state !== "live" || frame.bytes === null) return new Response(null, { status: 204, headers });
    return new Response(new Uint8Array(frame.bytes), {
      status: 200,
      headers: {
        ...headers,
        "content-type": frame.mimeType,
        [LIVE_FRAME_HEADERS.width]: String(frame.width),
        [LIVE_FRAME_HEADERS.height]: String(frame.height),
      },
    });
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...PRIVATE_HEADERS, "content-type": "application/json" } });
}
