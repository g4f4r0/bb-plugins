import { useEffect, useRef } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { PRESSURE_CHANNEL } from "../lib/pressure";
import { createAlertReceiver } from "../lib/alert-receiver";
import { pressureAlertCopy, TEST_ALERT_COPY } from "../lib/alert-copy";

const CURSOR_KEY = "beacon-pressure-cursor-v2";
let openStatus = () => {};
export function bindStatusOpener(open: () => void) {
  openStatus = open;
}

function ActiveNotifications() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const pageHidden = useRef(false);
  const previousConnection = useRef(connection);
  const receiver = useRef<ReturnType<typeof createAlertReceiver> | null>(null);
  const sync = useRef<() => void>(() => {});
  useRealtime(PRESSURE_CHANNEL, (value) => {
    if (pageHidden.current || document.visibilityState !== "visible") return;
    if (value && typeof value === "object" && "type" in value && value.type === "test") {
      toast.warning(TEST_ALERT_COPY.title, {
        id: "beacon-pressure-test", description: TEST_ALERT_COPY.description,
        duration: 20_000, closeButton: true,
        action: { label: "Open Status", onClick: () => openStatus() },
      });
      return;
    }
    receiver.current?.receive(value);
  });

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let repeat = false;
    let generation = 0;
    let saved: unknown = null;
    try { saved = JSON.parse(sessionStorage.getItem(CURSOR_KEY) ?? "null"); } catch { /* Storage may be disabled. */ }
    const nextReceiver = createAlertReceiver(saved, (notice) => {
      const recovered = notice.type === "recovery";
      const { title, description } = pressureAlertCopy(notice);
      (recovered ? toast.success : toast.warning)(title, {
        id: `beacon-pressure-${notice.metric}`, description, duration: 12_000,
        action: { label: "Open Status", onClick: () => openStatus() },
      });
    }, (cursor) => { try { sessionStorage.setItem(CURSOR_KEY, JSON.stringify(cursor)); } catch { /* In-memory deduplication still applies. */ } });
    receiver.current = nextReceiver;
    const reconcile = async () => {
      if (disposed || pageHidden.current || document.visibilityState !== "visible") return;
      if (pending) { repeat = true; return; }
      pending = true;
      const requestGeneration = generation;
      try {
        const status = await rpc.call("monitor_status");
        if (!disposed && !pageHidden.current && requestGeneration === generation && document.visibilityState === "visible") nextReceiver.reconcile(status);
      } catch { /* Reconcile at the next reconnect/visibility event, never in a retry loop. */ }
      finally {
        pending = false;
        if (repeat && !disposed) { repeat = false; void reconcile(); }
      }
    };
    // A response from before hide/show or reconnect can contain an incident that
    // has since recovered. Discard it before advancing cursors or showing toasts.
    sync.current = () => { generation++; void reconcile(); };
    const visible = () => { generation++; if (document.visibilityState === "visible") void reconcile(); };
    const hide = () => { pageHidden.current = true; generation++; };
    const show = () => { pageHidden.current = false; visible(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    void reconcile();
    return () => {
      disposed = true;
      receiver.current = null;
      sync.current = () => {};
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      toast.dismiss("beacon-pressure-cpu");
      toast.dismiss("beacon-pressure-memory");
      toast.dismiss("beacon-pressure-test");
    };
  }, [rpc]);

  useEffect(() => {
    if (connection === "connected" && previousConnection.current !== "connected") sync.current();
    previousConnection.current = connection;
  }, [connection]);
  return null;
}

export function PressureNotifications() {
  const { values } = useSettings();
  return values?.backgroundMonitoring === true && values?.pressureNotifications === true ? <ActiveNotifications /> : null;
}
