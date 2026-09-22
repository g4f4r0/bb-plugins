import {
  experimental_Icon as Icon,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { entityIdSchema } from "../src/contracts/primitives.js";
import type { ComputerSnapshot } from "../src/contracts/run.js";
import type { wayfinderSettingsRpcContract } from "../src/contracts/settings.js";
import { errorMessage, RUN_STATE_LABEL } from "./format.js";
import { LiveView } from "./live-view.js";
import { COMPUTER_REALTIME_CHANNEL, type UiRpcContract } from "./rpc.js";

type SettingsRpcContract = typeof wayfinderSettingsRpcContract;
const SNAPSHOT_INTERVAL_MS = 2_000;

export function selectedRunFromParams(params: unknown): string | null {
  const parsed = entityIdSchema.safeParse(params && typeof params === "object" && "runId" in params ? params.runId : null);
  return parsed.success ? parsed.data : null;
}

export function ComputerPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<UiRpcContract>();
  const settingsRpc = useRpc<SettingsRpcContract>();
  const connection = useRealtimeConnectionState();
  const selectedRunId = selectedRunFromParams(params);
  const [hostId, setHostId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([settingsRpc.call("settings.hostForThread", { threadId }), settingsRpc.call("settings.get", {})])
      .then(([resolved, settings]) => {
        if (!cancelled) setHostId(resolved.hostId ?? settings.selectedHostId);
      })
      .catch((cause) => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [settingsRpc, threadId]);

  const refresh = useCallback(async () => {
    if (hostId === null || inflight.current) return;
    inflight.current = true;
    try {
      setSnapshot(await rpc.call("computer.snapshot", { hostId, selectedRunId }));
      setError(null);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { inflight.current = false; }
  }, [rpc, hostId, selectedRunId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh();
    }, SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  useRealtime(COMPUTER_REALTIME_CHANNEL, () => void refresh());
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current !== "connected" && connection === "connected") void refresh();
    previousConnection.current = connection;
  }, [connection, refresh]);

  if (loading || (hostId !== null && snapshot === null && error === null)) return <CenteredSpinner />;
  if (hostId === null) return <Notice title="Setup required">Attach this thread to a computer or choose a fallback computer in Wayfinder settings.</Notice>;
  if (snapshot === null) return <Notice title="Computer unavailable">{error ?? "The computer did not respond."}</Notice>;

  const active = snapshot.activeRun;
  const selected = snapshot.selectedRun;
  const viewed = active ?? selected;
  if (snapshot.readiness === "setup-required" && viewed === null && snapshot.queue.length === 0) {
    return <Notice title="Setup required">{snapshot.readinessMessage || "Finish setup in Wayfinder settings."}</Notice>;
  }

  const cancel = async () => {
    if (active === null) return;
    try {
      await rpc.call("runs.cancel", { runId: active.runId, reason: "Cancelled from the Computer view" });
      toast.success("Run cancelled");
      await refresh();
    } catch (cause) { toast.error("Could not cancel run", { description: errorMessage(cause) }); }
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-black text-white">
      {viewed !== null ? <LiveView runId={viewed.runId} fill /> : <IdleView />}

      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs shadow backdrop-blur">
        <span className={`size-2 rounded-full ${connection === "connected" && error === null ? "bg-emerald-400" : "bg-amber-400"}`} aria-hidden="true" />
        <span>{error === null ? (connection === "connected" ? "Connected" : connection) : "Unavailable"}</span>
        <span className="text-white/55">·</span>
        <span>{active === null ? "Idle" : "Live"}</span>
      </div>

      {snapshot.queue.length > 0 ? <div className="absolute right-3 top-3 rounded-full bg-black/70 px-3 py-1.5 text-xs shadow backdrop-blur">{snapshot.queue.length} queued</div> : null}

      {active !== null ? (
        <div className="absolute inset-x-3 bottom-3 flex items-end gap-3 rounded-xl bg-black/75 p-3 shadow-lg backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-white/70">{RUN_STATE_LABEL[active.state] ?? active.state}</div>
            <p className="truncate text-sm">{active.route.goal}</p>
          </div>
          <button type="button" onClick={() => void cancel()} className="rounded-md bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">Cancel</button>
        </div>
      ) : selectedRunId !== null ? (
        <div className="absolute inset-x-3 bottom-3 rounded-xl bg-black/75 p-3 text-xs text-white/70 shadow-lg backdrop-blur">Selected run is not controlling the computer.</div>
      ) : null}
    </div>
  );
}

function CenteredSpinner() {
  return <div role="status" aria-label="Loading computer" className="flex h-full min-h-0 items-center justify-center bg-black text-white"><Icon name="Loading" aria-hidden="true" className="size-5 animate-spin text-white/60" /></div>;
}

function IdleView() {
  return <div className="flex h-full min-h-0 items-center justify-center bg-black text-center"><div><Icon name="Laptop" className="mx-auto mb-3 size-8 text-white/35" aria-hidden="true" /><p className="text-sm text-white/70">Computer is idle</p><p className="mt-1 text-xs text-white/40">The live view starts when a run takes control.</p></div></div>;
}

function Notice({ title, children }: { title: string; children: string }) {
  return <div role="status" className="flex h-full min-h-0 items-center justify-center bg-black px-8 text-center text-white"><div><Icon name="Laptop" aria-hidden="true" className="mx-auto mb-3 size-8 text-white/35" /><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 max-w-sm text-sm text-white/55">{children}</p></div></div>;
}
