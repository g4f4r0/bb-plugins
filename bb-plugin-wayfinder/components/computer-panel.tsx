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
import type { ComputerSnapshot, HumanInput } from "../src/contracts/run.js";
import type { wayfinderSettingsRpcContract } from "../src/contracts/settings.js";
import { errorMessage, RUN_STATE_LABEL } from "./format.js";
import { LiveView } from "./live-view.js";
import { COMPUTER_REALTIME_CHANNEL, type UiRpcContract } from "./rpc.js";

type SettingsRpcContract = typeof wayfinderSettingsRpcContract;
type LiveStatus = "connecting" | "live" | "paused" | "redacted" | "disconnected" | "no-frame" | "not-found";
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
  const clientId = useRef(`viewer_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`);
  const [hostId, setHostId] = useState<string | null>(null);
  const [hostName, setHostName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const [nativeFrame, setNativeFrame] = useState<string | null>(null);
  const panelRoot = useRef<HTMLDivElement>(null);
  const panelVisible = useRef(true);
  const nativeInflight = useRef(false);
  const [humanRunId, setHumanRunId] = useState<string | null>(null);
  const [takingControl, setTakingControl] = useState(false);
  const inflight = useRef(false);
  const inputQueue = useRef(Promise.resolve<unknown>(undefined));

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      settingsRpc.call("settings.hostForThread", { threadId }),
      settingsRpc.call("settings.get", {}),
      settingsRpc.call("settings.hosts", {}).catch(() => []),
    ]).then(([resolved, settings, hosts]) => {
      if (cancelled) return;
      const nextHostId = resolved.hostId ?? settings.selectedHostId;
      setHostId(nextHostId);
      setHostName(hosts.find((host) => host.hostId === nextHostId)?.name ?? nextHostId);
    }).catch((cause) => { if (!cancelled) setError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [settingsRpc, threadId]);

  const refresh = useCallback(async () => {
    if (hostId === null || inflight.current) return;
    inflight.current = true;
    try { setSnapshot(await rpc.call("computer.snapshot", { hostId, selectedRunId })); setError(null); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { inflight.current = false; }
  }, [rpc, hostId, selectedRunId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (panelVisible.current && (typeof document === "undefined" || document.visibilityState !== "hidden")) void refresh(); }, SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  useRealtime(COMPUTER_REALTIME_CHANNEL, () => { if (panelVisible.current) void refresh(); });
  useEffect(() => {
    const node = panelRoot.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      panelVisible.current = entries.some((entry) => entry.isIntersecting);
      if (panelVisible.current) void refresh();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [refresh]);
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current !== "connected" && connection === "connected") void refresh();
    previousConnection.current = connection;
  }, [connection, refresh]);

  const releaseControl = useCallback((runId = humanRunId) => {
    if (runId === null || hostId === null) return;
    setHumanRunId((current) => current === runId ? null : current);
    void rpc.call("computer.control.release", { hostId, runId, clientId: clientId.current }).catch(() => undefined);
  }, [hostId, humanRunId, rpc]);
  useEffect(() => {
    const relinquish = () => releaseControl();
    const visibility = () => { if (document.visibilityState === "hidden") relinquish(); };
    window.addEventListener("blur", relinquish);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", relinquish); document.removeEventListener("visibilitychange", visibility); relinquish(); };
  }, [releaseControl]);

  const active = snapshot?.activeRun ?? null;
  useEffect(() => {
    if (hostId === null || active !== null) { setNativeFrame(null); return; }
    let stopped = false;
    const poll = async () => {
      if (stopped || nativeInflight.current || !panelVisible.current || document.visibilityState === "hidden") return;
      nativeInflight.current = true;
      try {
        const result = await rpc.call("computer.preview", { hostId, threadId });
        if (!stopped && result.frame) { setNativeFrame(`data:image/jpeg;base64,${result.frame.base64}`); setLiveStatus("live"); }
      } catch { /* Built-in browser is optional; retained run evidence remains the fallback. */ }
      finally { nativeInflight.current = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, hostId, rpc, threadId]);
  const controllableRunId = active && ["running", "verifying"].includes(active.state) ? active.runId : null;
  useEffect(() => {
    if (humanRunId !== null && humanRunId !== controllableRunId) releaseControl(humanRunId);
  }, [controllableRunId, humanRunId, releaseControl]);
  useEffect(() => {
    if (humanRunId !== null) document.querySelector<HTMLElement>('[aria-label="Live computer; click, type, paste, or scroll"]')?.focus();
  }, [humanRunId]);

  if (loading || (hostId !== null && snapshot === null && error === null)) return <CenteredSpinner />;
  if (hostId === null) return <Notice title="Setup required">Attach this thread to a computer or choose a fallback computer in Wayfinder settings.</Notice>;
  if (snapshot === null) return <Notice title="Computer unavailable">{error ?? "The computer did not respond."}</Notice>;

  const selected = snapshot.selectedRun;
  const viewed = active ?? selected;
  const hasViewport = nativeFrame !== null || viewed !== null;
  if (snapshot.readiness === "setup-required" && !hasViewport && snapshot.queue.length === 0) return <Notice title="Setup required">{snapshot.readinessMessage || "Finish setup in Wayfinder settings."}</Notice>;

  const cancel = async () => {
    if (active === null) return;
    try { await rpc.call("runs.cancel", { runId: active.runId, reason: "Cancelled from the Computer view" }); toast.success("Run cancelled"); await refresh(); }
    catch (cause) { toast.error("Could not cancel run", { description: errorMessage(cause) }); }
  };
  const takeControl = async () => {
    if (active === null || controllableRunId === null || takingControl) return;
    setTakingControl(true);
    try {
      const result = await rpc.call("computer.control.acquire", { hostId, runId: active.runId, clientId: clientId.current });
      if (result.state === "busy") { toast.error("Another viewer has control"); return; }
      setHumanRunId(active.runId);
    } catch (cause) { toast.error("Could not take control", { description: errorMessage(cause) }); }
    finally { setTakingControl(false); }
  };
  const sendInput = (input: HumanInput) => {
    if (active === null || humanRunId !== controllableRunId) return;
    inputQueue.current = inputQueue.current.then(() => rpc.call("computer.control.input", { hostId, runId: active.runId, clientId: clientId.current, input })).catch((cause) => {
      setHumanRunId(null);
      toast.error("Computer input disconnected", { description: errorMessage(cause) });
    });
  };
  const hasHumanControl = humanRunId !== null && humanRunId === controllableRunId;
  const connected = hasHumanControl || (error === null && connection === "connected" && (!hasViewport || !["disconnected", "not-found"].includes(liveStatus)));
  const statusLabel = hasHumanControl ? "You’re controlling" : !hasViewport ? (connection === "connected" ? "Connected" : "Disconnected") : liveStatus === "live" ? "Connected" : liveStatus === "paused" ? "Paused" : liveStatus === "redacted" ? "Hidden" : liveStatus === "disconnected" || liveStatus === "not-found" ? "Disconnected" : "Connecting";

  return <div ref={panelRoot} className="group relative h-full min-h-0 overflow-hidden bg-black text-white">
    {active !== null ? <LiveView runId={active.runId} fill interactive={hasHumanControl} onInput={sendInput} onStatusChange={setLiveStatus} /> : nativeFrame !== null ? <img src={nativeFrame} alt="Live view of the built-in browser" className="h-full w-full select-none object-contain" draggable={false} /> : viewed !== null ? <LiveView runId={viewed.runId} fill onStatusChange={setLiveStatus} /> : <IdleView />}

    {controllableRunId !== null && humanRunId !== controllableRunId ? <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/0 opacity-0 transition-opacity group-hover:bg-black/25 group-hover:opacity-100 group-focus-within:bg-black/25 group-focus-within:opacity-100"><button type="button" onClick={() => void takeControl()} disabled={takingControl} className="pointer-events-auto inline-flex min-h-9 items-center gap-2 rounded-md bg-white px-3 text-xs font-medium text-black shadow-lg hover:bg-white/90 disabled:opacity-60">{takingControl ? <Icon name="Loading" className="size-4 animate-spin" aria-hidden="true" /> : <Icon name="Cursor" className="size-4" aria-hidden="true" />}{takingControl ? "Taking control…" : "Take control"}</button></div> : null}

    {active !== null ? <div className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-6rem)] items-center gap-3 rounded-lg bg-black/70 px-3 py-2 shadow backdrop-blur"><div className="min-w-0"><div className="text-[10px] font-medium uppercase tracking-wide text-white/50">{RUN_STATE_LABEL[active.state] ?? active.state}</div><p className="truncate text-xs">{active.route.goal}</p></div><button type="button" onClick={() => void cancel()} className="shrink-0 rounded-md bg-white/10 px-2 py-1 text-[11px] hover:bg-white/20">Cancel</button></div> : null}
    {snapshot.queue.length > 0 ? <div className="absolute right-3 top-3 z-20 rounded-full bg-black/70 px-3 py-1.5 text-xs shadow backdrop-blur">{snapshot.queue.length} queued</div> : null}
    {active === null && selectedRunId !== null ? <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white/70 shadow backdrop-blur">Selected run is not controlling the computer.</div> : null}

    <button type="button" disabled={!hasHumanControl} onClick={() => releaseControl()} title={hasHumanControl ? "Release control" : statusLabel} className="absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-xs shadow backdrop-blur disabled:pointer-events-none disabled:opacity-100"><span className={`size-1.5 rounded-full ${connected ? "bg-emerald-400" : liveStatus === "disconnected" ? "bg-red-400" : "bg-amber-400"}`} aria-hidden="true" /><span>{statusLabel}</span></button>
    <div aria-label="Computer host" className="pointer-events-none absolute bottom-3 right-3 z-20 flex max-w-[45%] items-center gap-1.5 rounded-full bg-black/75 px-3 py-1.5 text-xs text-white/70 shadow backdrop-blur"><Icon name="Laptop" className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{hostName ?? hostId}</span></div>
  </div>;
}

function CenteredSpinner() { return <div role="status" aria-label="Loading computer" className="flex h-full min-h-0 items-center justify-center bg-black text-white"><Icon name="Loading" aria-hidden="true" className="size-5 animate-spin text-white/60" /></div>; }
function IdleView() { return <div className="flex h-full min-h-0 items-center justify-center bg-black text-center"><div><Icon name="Laptop" className="mx-auto mb-3 size-8 text-white/35" aria-hidden="true" /><p className="text-sm text-white/70">Computer is idle</p><p className="mt-1 text-xs text-white/40">The live view starts when a run takes control.</p></div></div>; }
function Notice({ title, children }: { title: string; children: string }) { return <div role="status" className="flex h-full min-h-0 items-center justify-center bg-black px-8 text-center text-white"><div><Icon name="Laptop" aria-hidden="true" className="mx-auto mb-3 size-8 text-white/35" /><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 max-w-sm text-sm text-white/55">{children}</p></div></div>; }
