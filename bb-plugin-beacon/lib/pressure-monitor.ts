import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MONITOR_INTERVAL_MS, PRESSURE_CHANNEL, freshPressureState, stepPressure, type PressureState } from "./pressure.ts";
import { createMonitorStore, type LogEntry } from "./monitor-store.ts";

export interface LightSample { cpu: number | null; memory: number | null; load1: number; rssBytes: number; heapUsedBytes: number; availableBytes: number | null; totalBytes: number }
export function createPressureMonitor(bb: BbPluginApi, read: (signal: AbortSignal) => Promise<LightSample>, reset: () => void) {
  let enabled = false;
  let notifications = true;
  let store: ReturnType<typeof createMonitorStore> | undefined;
  const getStore = () => store ??= createMonitorStore(bb);
  let state: PressureState | undefined;
  let wake: (() => void) | undefined;
  let revision = 0;
  let lastSummary = -Infinity;
  let lastError = -Infinity;
  let cpuPeak: number | null = null;
  let memoryPeak: number | null = null;
  let runController: AbortController | undefined;
  let disposed = false;
  let configured = false;

  function configure(nextEnabled: boolean, nextNotifications: boolean) {
    if (disposed) return;
    notifications = nextNotifications;
    const restore = !configured && nextEnabled;
    configured = true;
    if (enabled === nextEnabled) {
      if (!enabled) state = freshPressureState();
      return;
    }
    enabled = nextEnabled;
    revision++;
    runController?.abort();
    state = restore ? undefined : freshPressureState();
    reset();
    cpuPeak = memoryPeak = null;
    lastSummary = -Infinity;
    if (!enabled) {
      try { getStore().write([{ type: "monitor_disabled", timestamp: Date.now() }], freshPressureState()); }
      catch { bb.log.warn("Beacon could not record that background monitoring was disabled."); }
    }
    wake?.();
  }

  function wait(signal: AbortSignal, milliseconds?: number) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); if (wake === done) wake = undefined; resolve(); };
      wake = done;
      if (milliseconds !== undefined) { timer = setTimeout(done, milliseconds); timer.unref(); }
      signal.addEventListener("abort", done, { once: true });
    });
  }

  async function tick(signal: AbortSignal) {
    const generation = revision;
    const begin = performance.now();
    const storage = getStore();
    state ??= storage.state();
    const sample = await read(signal);
    if (signal.aborted || !enabled || generation !== revision) return;
    const now = Date.now();
    const result = stepPressure(state, { cpu: sample.cpu, memory: sample.memory }, now);
    cpuPeak = sample.cpu === null ? cpuPeak : Math.max(cpuPeak ?? 0, sample.cpu);
    memoryPeak = sample.memory === null ? memoryPeak : Math.max(memoryPeak ?? 0, sample.memory);
    const records: LogEntry[] = result.events.map((event) => ({ ...event }));
    const summaryDue = begin - lastSummary >= 60_000;
    if (summaryDue) records.push({ type: "summary", timestamp: now, cpuPercent: sample.cpu, memoryPercent: sample.memory, cpuPeak, memoryPeak, load1: sample.load1, rssBytes: sample.rssBytes, heapUsedBytes: sample.heapUsedBytes, availableBytes: sample.availableBytes, totalBytes: sample.totalBytes, sampleDurationMs: Math.round((performance.now() - begin) * 100) / 100 });
    // Even a quiet sample can break a confirmation streak. Persist every monitor
    // step so a reload cannot restore a streak that a later sample already broke.
    const saved = storage.write(records, result.state);
    state = result.state;
    if (summaryDue) { lastSummary = begin; cpuPeak = memoryPeak = null; }
    if (notifications) for (const event of saved) if (event.type === "incident" || event.type === "recovery") bb.realtime.publish(PRESSURE_CHANNEL, event);
  }

  async function start(signal: AbortSignal) {
    const abort = () => runController?.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (!signal.aborted && !disposed) {
        if (!enabled) { await wait(signal); continue; }
        runController = new AbortController();
        try { await tick(runController.signal); }
        catch (cause) {
          if (signal.aborted || runController.signal.aborted) continue;
          reset();
          // Don't claim continuous overload across failures; retain active incidents.
          const interrupted = state && (["cpu", "memory"] as const).some((metric) =>
            (!state![metric].active && state![metric].since !== null) || state![metric].recoveringSince !== null);
          if (state) {
            // A failed attempt breaks streaks but cannot refresh an old incident.
            const lastSampleAt = state.lastSampleAt;
            state = { ...stepPressure(state, { cpu: null, memory: null }, Date.now()).state, lastSampleAt };
          }
          const now = performance.now();
          const records: LogEntry[] = [];
          if (now - lastError >= 300_000) {
            lastError = now;
            records.push({ type: "error", timestamp: Date.now(), message: "Pressure sampling or log storage failed", errorType: cause instanceof Error ? cause.name.slice(0, 64) : "UnknownError" });
            bb.log.warn("Beacon pressure monitor could not sample or store diagnostics; retrying in 30 seconds.");
          }
          // Persist broken streaks even when the error log is throttled. Otherwise a
          // reload can restore an old candidate and falsely count the failed interval.
          // A locked/full/unavailable database cannot store its own failure in the
          // same turn. Avoid a second synchronous busy wait; keep the host warning
          // and retry storage at the next normal sample. Read failures still persist
          // broken confirmation streaks immediately when storage is available.
          const storageUnavailable = cause instanceof Error && "code" in cause &&
            typeof cause.code === "string" && /^SQLITE_(BUSY|LOCKED|FULL|IOERR|READONLY|CANTOPEN|CORRUPT|NOTADB)(_|$)/.test(cause.code);
          if (!storageUnavailable && (records.length || interrupted)) {
            try { getStore().write(records, state); } catch { /* No unbounded retries or queues on disk failure. */ }
          }
        } finally { runController = undefined; }
        if (!signal.aborted && enabled) await wait(signal, MONITOR_INTERVAL_MS);
      }
    } finally { signal.removeEventListener("abort", abort); reset(); state = undefined; }
  }

  return {
    configure,
    start,
    status() {
      if (!enabled) return { enabled, notifications, cursor: 0, active: [], recent: [] };
      const storage = getStore();
      const recent = storage.alerts();
      const latest = state ?? storage.state();
      const fresh = latest.lastSampleAt !== null && Date.now() - latest.lastSampleAt < 90_000 && Date.now() >= latest.lastSampleAt;
      return { enabled, notifications, cursor: storage.cursor(), active: fresh ? storage.currentNotices().filter((event) => event.type === "incident" && latest[event.metric].active).map((event) => ({ ...event, peak: latest[event.metric].peak })) : [], recent: recent.filter((event) => Date.now() - event.timestamp < 300_000 && Date.now() >= event.timestamp) };
    },
    logs(limit: number) { return getStore().read(limit); },
    dispose() { disposed = true; revision++; enabled = false; runController?.abort(); wake?.(); state = undefined; reset(); },
  };
}
