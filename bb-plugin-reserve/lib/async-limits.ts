import { setMaxListeners } from "node:events";
/** Deadline owns its timer/listener; also bounds SDK calls that ignore abort. */
export async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  setMaxListeners(32, controller.signal);
  const abort = () => controller.abort(parent?.reason ?? new Error('Reserve disposed.'));
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Usage request timed out.')), ms);
  let rejectAbort: () => void = () => {};
  try {
    controller.signal.throwIfAborted();
    const stopped = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    return await Promise.race([stopped, work(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

export async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await work(items[index]!);
    }
  }));
  return result;
}

/** Stops queued work at a fleet deadline while preserving already completed hosts. */
export async function withTimeBudget<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  setMaxListeners(32, controller.signal);
  const abort = () => controller.abort(parent?.reason ?? new Error('Reserve disposed.'));
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Fleet refresh timed out.')), ms);
  try { return await work(controller.signal); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}
