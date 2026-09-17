import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { UsageSnapshot, rpcContract } from "../server";
import { createSharedRequest } from "../lib/shared-request.ts";
import { createVisiblePoller } from "../lib/visible-poller.ts";

// Single bounded snapshot and transport lease across rapid remounts.
let lastUsage: UsageSnapshot | null = null;
const transport = createSharedRequest<UsageSnapshot>();

function stillFresh(snapshot: UsageSnapshot): boolean {
  const age = Date.now() - Date.parse(snapshot.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < snapshot.refreshIntervalMs;
}

export function useFleetSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const container = useRef<HTMLDivElement>(null);
  const pollerRef = useRef<ReturnType<typeof createVisiblePoller<UsageSnapshot>> | null>(null);
  const forceRefresh = useRef(false);
  const [active, setActive] = useState(false);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(lastUsage);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let intersecting = false;
    let pageHidden = false;
    const poller = createVisiblePoller({
      async load(signal) {
        const force = forceRefresh.current || (lastUsage !== null && !stillFresh(lastUsage));
        forceRefresh.current = false;
        if (!force && lastUsage !== null && stillFresh(lastUsage)) return lastUsage;
        setReloading(true);
        // SDK 0.4.87 has no frontend RPC AbortSignal: share its promise, then
        // let the poller's generation guard suppress detached deliveries.
        return transport.read(() => rpc.call("getUsage", force ? { force: true } : {}), signal);
      },
      receive(next) {
        lastUsage = next;
        setSnapshot(next);
        setError(null);
        setReloading(false);
      },
      error(cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setReloading(false);
      },
      clear() { setError(null); setReloading(false); },
      intervalMs: (next) => stillFresh(next) ? next.refreshIntervalMs : 2000,
    });
    pollerRef.current = poller;
    const update = () => {
      const visible = intersecting && !pageHidden && navigator.onLine !== false && document.visibilityState === "visible";
      poller.setActive(visible);
      setActive(visible);
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = Boolean(entry?.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
      update();
    });
    const hide = () => { pageHidden = true; update(); };
    const show = () => { pageHidden = false; update(); };
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    window.addEventListener("offline", update);
    window.addEventListener("online", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("offline", update);
      window.removeEventListener("online", update);
      poller.dispose();
      pollerRef.current = null;
    };
  }, [rpc]);

  const reload = useCallback(() => {
    forceRefresh.current = true;
    if (pollerRef.current?.refresh()) setReloading(true);
  }, []);
  return { container, active, snapshot, error, reloading, reload };
}
