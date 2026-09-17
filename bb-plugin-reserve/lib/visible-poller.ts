/** Serialized polling with stale-response protection across hide/show and disposal. */
export function createVisiblePoller<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  receive: (value: T) => void;
  error: (error: unknown) => void;
  clear: () => void;
  intervalMs: (value: T) => number;
}) {
  let active = false;
  let disposed = false;
  let generation = 0;
  let pending = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cancelWait: (() => void) | undefined;

  async function poll() {
    if (!active || disposed || pending) return;
    pending = true;
    const requestGeneration = generation;
    let delay = 5000;
    try {
      const request = new AbortController();
      const stopped = new Promise<never>((_, reject) => {
        cancelWait = () => {
          const error = new Error("Usage request timed out or was hidden.");
          request.abort(error);
          reject(error);
        };
      });
      deadline = setTimeout(() => cancelWait?.(), 20_000);
      const value = await Promise.race([options.load(request.signal), stopped]);
      if (!active || disposed || requestGeneration !== generation) return;
      failures = 0;
      delay = Math.min(300_000, Math.max(2000, options.intervalMs(value) || 5000));
      options.receive(value);
    } catch (error) {
      if (!active || disposed || requestGeneration !== generation) return;
      failures = Math.min(failures + 1, 5);
      delay = Math.min(60_000, 5000 * 2 ** (failures - 1));
      options.error(error);
    } finally {
      clearTimeout(deadline);
      deadline = undefined;
      cancelWait = undefined;
      pending = false;
      if (active && !disposed) {
        timer = setTimeout(() => { timer = undefined; void poll(); }, requestGeneration === generation ? delay : 0);
      }
    }
  }

  return {
    setActive(next: boolean) {
      if (disposed || next === active) return;
      active = next;
      generation++;
      clearTimeout(timer);
      timer = undefined;
      if (active) void poll();
      else { clearTimeout(deadline); cancelWait?.(); options.clear(); }
    },
    refresh() {
      if (disposed || !active) return false;
      generation++;
      clearTimeout(timer);
      timer = undefined;
      if (!pending) void poll();
      return true;
    },
    dispose() {
      disposed = true;
      clearTimeout(deadline);
      cancelWait?.();
      active = false;
      generation++;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
