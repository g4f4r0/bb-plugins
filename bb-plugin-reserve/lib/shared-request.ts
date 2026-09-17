/** One physical RPC with detachable waiters; abandoned views never stay attached
 * to an SDK promise that may not settle while the network is offline. */
export function createSharedRequest<T>() {
  let pending = false;
  const waiters = new Set<{ finish: (error: unknown, value?: T) => void }>();
  return {
    read(load: () => Promise<T>, signal: AbortSignal): Promise<T> {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (waiters.size >= 32) return Promise.reject(new Error('Too many pending usage views.'));
      return new Promise<T>((resolve, reject) => {
        const abort = () => waiter.finish(signal.reason ?? new Error("Usage request cancelled."));
        const waiter = { finish(error: unknown, value?: T) {
          waiters.delete(waiter);
          signal.removeEventListener('abort', abort);
          if (error !== null) reject(error);
          else resolve(value as T);
        } };
        waiters.add(waiter);
        signal.addEventListener('abort', abort, { once: true });
        if (pending) return;
        pending = true;
        const finish = (error: unknown, value?: T) => {
          pending = false;
          for (const waiter of [...waiters]) waiter.finish(error, value);
        };
        try {
          void load().then(value => finish(null, value), error => finish(error ?? new Error('Usage request failed.')));
        } catch (error) { finish(error ?? new Error('Usage request failed.')); }
      });
    },
    get waiterCount() { return waiters.size; },
  };
}
