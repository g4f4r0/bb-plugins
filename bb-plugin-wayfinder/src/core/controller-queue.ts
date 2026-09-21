import { opaqueId } from "./hash.js";
import { wayfinderError } from "./errors.js";
import type { WayfinderError } from "../contracts/run.js";

export interface ControllerLease {
  readonly leaseId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  heartbeat(): void;
  release(): void;
}

export interface QueueSnapshot {
  readonly active: { readonly runId: string; readonly threadId: string; readonly expiresAt: number } | null;
  readonly queued: ReadonlyArray<{ readonly runId: string; readonly threadId: string; readonly enqueuedAt: number }>;
}

interface Pending {
  readonly runId: string;
  readonly threadId: string;
  readonly enqueuedAt: number;
  readonly resolve: (lease: ControllerLease) => void;
  readonly reject: (error: WayfinderError) => void;
  readonly signal: AbortSignal;
  abortListener: (() => void) | null;
}

interface ActiveLease {
  readonly leaseId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly acquiredAt: number;
  expiresAt: number;
}

export class SingleControllerQueue {
  readonly #leaseTtlMs: number;
  readonly #maxQueueLength: number;
  readonly #now: () => number;
  readonly #pending: Pending[] = [];
  #active: ActiveLease | null = null;
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(options: { leaseTtlMs?: number; maxQueueLength?: number; now?: () => number } = {}) {
    this.#leaseTtlMs = options.leaseTtlMs ?? 15_000;
    this.#maxQueueLength = options.maxQueueLength ?? 100;
    this.#now = options.now ?? Date.now;
  }

  acquire(runId: string, threadId: string, signal: AbortSignal): Promise<ControllerLease> {
    if (this.#closed) return Promise.reject(wayfinderError("interrupted", "queue", "Host controller queue is closed"));
    this.reapExpired();
    if (signal.aborted) return Promise.reject(wayfinderError("cancelled", "queue", "Run cancelled while queued"));
    if (this.#pending.length >= this.#maxQueueLength) {
      return Promise.reject(wayfinderError("limit-exceeded", "queue", "Host controller queue is full"));
    }
    if (this.#active?.runId === runId || this.#pending.some((entry) => entry.runId === runId)) {
      return Promise.reject(wayfinderError("policy-denied", "queue", "Run already owns or awaits the host controller"));
    }
    return new Promise<ControllerLease>((resolve, reject) => {
      const pending: Pending = {
        runId,
        threadId,
        enqueuedAt: this.#now(),
        resolve,
        reject,
        signal,
        abortListener: null,
      };
      pending.abortListener = () => {
        const index = this.#pending.indexOf(pending);
        if (index >= 0) this.#pending.splice(index, 1);
        reject(wayfinderError("cancelled", "queue", "Run cancelled while queued"));
      };
      signal.addEventListener("abort", pending.abortListener, { once: true });
      this.#pending.push(pending);
      this.#dispatch();
    });
  }

  reapExpired(): void {
    if (this.#active !== null && this.#active.expiresAt <= this.#now()) {
      this.#clearExpiry();
      this.#active = null;
      this.#dispatch();
    }
  }

  snapshot(): QueueSnapshot {
    this.reapExpired();
    return {
      active: this.#active === null ? null : {
        runId: this.#active.runId,
        threadId: this.#active.threadId,
        expiresAt: this.#active.expiresAt,
      },
      queued: this.#pending.map(({ runId, threadId, enqueuedAt }) => ({ runId, threadId, enqueuedAt })),
    };
  }

  #dispatch(): void {
    if (this.#active !== null) return;
    while (this.#pending.length > 0) {
      const pending = this.#pending.shift();
      if (pending === undefined) return;
      if (pending.abortListener !== null) pending.signal.removeEventListener("abort", pending.abortListener);
      if (pending.signal.aborted) {
        pending.reject(wayfinderError("cancelled", "queue", "Run cancelled while queued"));
        continue;
      }
      const acquiredAt = this.#now();
      const active: ActiveLease = {
        leaseId: opaqueId("lease"),
        runId: pending.runId,
        threadId: pending.threadId,
        acquiredAt,
        expiresAt: acquiredAt + this.#leaseTtlMs,
      };
      this.#active = active;
      this.#scheduleExpiry(active);
      let released = false;
      pending.resolve({
        leaseId: active.leaseId,
        runId: active.runId,
        threadId: active.threadId,
        acquiredAt,
        get expiresAt() { return active.expiresAt; },
        heartbeat: () => {
          if (released || this.#active?.leaseId !== active.leaseId) {
            throw wayfinderError("interrupted", "queue", "Controller lease is no longer active");
          }
          active.expiresAt = this.#now() + this.#leaseTtlMs;
          this.#scheduleExpiry(active);
        },
        release: () => {
          if (released) return;
          released = true;
          if (this.#active?.leaseId === active.leaseId) {
            this.#clearExpiry();
            this.#active = null;
            this.#dispatch();
          }
        },
      });
      return;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearExpiry();
    this.#active = null;
    for (const pending of this.#pending.splice(0)) {
      if (pending.abortListener !== null) pending.signal.removeEventListener("abort", pending.abortListener);
      pending.reject(wayfinderError("interrupted", "queue", "Host controller queue closed"));
    }
  }

  #scheduleExpiry(active: ActiveLease): void {
    this.#clearExpiry();
    this.#expiryTimer = setTimeout(() => {
      if (this.#active?.leaseId !== active.leaseId) return;
      this.#active = null;
      this.#expiryTimer = null;
      this.#dispatch();
    }, Math.max(0, active.expiresAt - this.#now()));
  }

  #clearExpiry(): void {
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
  }
}

const HOST_QUEUES = new Map<string, SingleControllerQueue>();

export function hostControllerQueue(hostId: string): SingleControllerQueue {
  let queue = HOST_QUEUES.get(hostId);
  if (queue === undefined) {
    queue = new SingleControllerQueue();
    HOST_QUEUES.set(hostId, queue);
  }
  return queue;
}

export function disposeHostControllerQueue(hostId: string): void {
  const queue = HOST_QUEUES.get(hostId);
  queue?.close();
  HOST_QUEUES.delete(hostId);
}
