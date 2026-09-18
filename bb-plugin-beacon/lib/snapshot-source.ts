/** One bounded server view per app bundle. No timers and no thread keys. */
export function createSnapshotSource<T>(intervalMs: (value: T) => number) {
  let snapshot: T | null = null;
  let pending: Promise<T> | null = null;
  let nextAttemptAt = 0;
  let failures = 0;
  let error: unknown;
  return {
    snapshot: () => snapshot,
    load(collect: () => Promise<T>, force = false): Promise<T> {
      if (pending) return pending;
      if (!force && Date.now() < nextAttemptAt) {
        if (failures) return Promise.reject(error);
        if (snapshot !== null) return Promise.resolve(snapshot);
      }
      pending = Promise.resolve().then(collect).then((value) => {
        snapshot = value;
        failures = 0;
        error = undefined;
        nextAttemptAt = Date.now() + Math.min(60_000, Math.max(2000, intervalMs(value) || 5000));
        return value;
      }, (cause: unknown) => {
        // Do not retain transport errors, which may carry a response or request.
        error = new Error(cause instanceof Error ? cause.message.slice(0, 500) : "Server unavailable");
        failures = Math.min(5, failures + 1);
        nextAttemptAt = Date.now() + Math.min(60_000, 5000 * 2 ** (failures - 1));
        throw error;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
