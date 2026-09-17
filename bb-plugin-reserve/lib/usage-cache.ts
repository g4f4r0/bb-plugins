/** Single-flight, one-entry cache. Failed refreshes back off even across clients. */
export function createCachedLoader<T>(options: {
  load: () => Promise<T>;
  ttlMs: (value: T) => number;
  now?: () => number;
}) {
  let cached: { value: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  let disposed = false;
  let generation = 0;
  let failures = 0;
  let retryAt = 0;
  let lastError: unknown;
  const now = options.now ?? Date.now;

  function live(): Promise<T> {
    if (disposed) return Promise.reject(new Error('Reserve was disposed.'));
    if (inflight !== null) return inflight;
    if (now() < retryAt) return cached ? Promise.resolve(cached.value) : Promise.reject(lastError);
    const startedGeneration = generation;
    inflight = Promise.resolve().then(options.load).then((value) => {
      if (!disposed && startedGeneration !== generation) throw new Error("Usage changed while refreshing; retry.");
      if (!disposed && startedGeneration === generation) {
        cached = { value, at: now() };
        failures = 0;
        retryAt = now() + 2000;
      }
      return value;
    }).catch((error: unknown) => {
      if (!disposed && startedGeneration === generation) {
        lastError = error;
        failures = Math.min(failures + 1, 5);
        retryAt = now() + Math.min(60_000, 5000 * 2 ** (failures - 1));
      }
      throw error;
    }).finally(() => { inflight = null; });
    return inflight;
  }

  return {
    hydrate(value: T, at: number) {
      if (!disposed && cached === null) cached = { value, at };
    },
    get(force = false): Promise<T> {
      if (disposed) return Promise.reject(new Error('Reserve was disposed.'));
      if (force) return live();
      if (cached !== null) {
        if (now() - cached.at >= options.ttlMs(cached.value)) void live().catch(() => {});
        return Promise.resolve(cached.value);
      }
      return live();
    },
    invalidate() { generation++; cached = null; retryAt = 0; failures = 0; },
    dispose() { disposed = true; generation++; cached = null; lastError = undefined; },
  };
}
