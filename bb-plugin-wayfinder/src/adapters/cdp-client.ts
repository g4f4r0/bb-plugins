import { errorMessage, wayfinderError } from "../core/errors.js";

export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

export interface CdpTransport {
  command<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, signal: AbortSignal, sessionId?: string): Promise<T>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  close(): Promise<void>;
}

interface PendingCommand {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

export class WebSocketCdpTransport implements CdpTransport {
  readonly #socket: WebSocket;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  #nextId = 1;

  private constructor(socket: WebSocket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.addEventListener("message", (event) => this.#message(event.data));
    socket.addEventListener("close", () => this.#rejectAll(wayfinderError("provider-unavailable", "act", "CDP connection closed", { retryable: true })));
    socket.addEventListener("error", () => this.#rejectAll(wayfinderError("provider-unavailable", "act", "CDP connection failed", { retryable: true })));
  }

  static async connect(webSocketUrl: string, options: { timeoutMs?: number; signal: AbortSignal }): Promise<WebSocketCdpTransport> {
    const url = new URL(webSocketUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw wayfinderError("setup-required", "observe", "Fortress CDP endpoint must be a private WebSocket URL");
    }
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase();
    if (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost") {
      throw wayfinderError("policy-denied", "observe", "Fortress CDP must remain on a loopback endpoint on the selected host");
    }
    if (options.signal.aborted) throw wayfinderError("cancelled", "observe", "CDP connection cancelled");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(wayfinderError("provider-unavailable", "observe", "Timed out connecting to Fortress CDP")), options.timeoutMs ?? 5_000);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        socket.close();
        reject(wayfinderError("cancelled", "observe", "CDP connection cancelled"));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", () => { cleanup(); resolve(); }, { once: true });
      socket.addEventListener("error", () => { cleanup(); reject(wayfinderError("provider-unavailable", "observe", "Could not connect to Fortress CDP")); }, { once: true });
    });
    return new WebSocketCdpTransport(socket, options.timeoutMs ?? 10_000);
  }

  command<T>(method: string, params: Record<string, unknown>, signal: AbortSignal, sessionId?: string): Promise<T> {
    if (signal.aborted) return Promise.reject(wayfinderError("cancelled", "act", "CDP command cancelled"));
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(wayfinderError("provider-unavailable", "act", "Fortress CDP connection is not open", { retryable: true }));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending.get(id);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.#pending.delete(id);
        }
        reject(wayfinderError("cancelled", "act", "CDP command cancelled"));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        signal.removeEventListener("abort", abort);
        reject(wayfinderError("provider-unavailable", "act", `CDP command timed out: ${method}`, { retryable: true }));
      }, this.#timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        signal,
        abort,
      });
      try {
        this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
      } catch (error) {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.#pending.delete(id);
        reject(wayfinderError("provider-unavailable", "act", errorMessage(error), { retryable: true }));
      }
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#socket.close(1000, "wayfinder-close");
    this.#rejectAll(wayfinderError("interrupted", "cleanup", "CDP transport closed"));
  }

  #message(data: unknown): void {
    if (typeof data !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      pending.signal.removeEventListener("abort", pending.abort);
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(wayfinderError("provider-unavailable", "act", `CDP command failed: ${JSON.stringify(message.error).slice(0, 700)}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = {
        method: message.method,
        params: message.params !== null && typeof message.params === "object" ? message.params as Record<string, unknown> : {},
        ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
      };
      for (const listener of this.#listeners) listener(event);
    }
  }

  #rejectAll(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
