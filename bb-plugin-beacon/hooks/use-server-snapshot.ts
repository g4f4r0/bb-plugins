import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, ServerSnapshot } from "../server";
import { createSnapshotSource } from "../lib/snapshot-source.ts";
import { createVisiblePoller } from "../lib/visible-poller.ts";

// One server snapshot per app bundle, never keyed by thread. Survives disclosure
// remounts without timers; replaced on success and released with the bundle.
const source = createSnapshotSource<ServerSnapshot>((value) => value.refreshIntervalMs);

export function useServerSnapshot() {
  const rpc = useRpc<typeof rpcContract>();
  const container = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [snapshot, setSnapshot] = useState<ServerSnapshot | null>(source.snapshot);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let intersecting = false;
    let pageHidden = false;
    const poller = createVisiblePoller({
      load: () => source.load(() => rpc.call("metrics_snapshot")),
      receive(next) { setSnapshot(next); setError(null); },
      error(cause) { setError(cause instanceof Error ? cause.message : String(cause)); },
      intervalMs: (next) => next.refreshIntervalMs,
    });
    const update = () => {
      const visible = intersecting && !pageHidden && document.visibilityState === "visible" && element.getClientRects().length > 0;
      poller.setActive(visible);
      setActive(visible);
    };
    // Observe the persistent panel shell, not charts or a scrollable sentinel.
    // BB may retain a mounted panel while hiding it with display:none.
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
      update();
    });
    const hide = () => { pageHidden = true; update(); };
    const show = () => { pageHidden = false; update(); };
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      poller.dispose();
    };
  }, [rpc]);

  return { container, active, snapshot, error };
}
