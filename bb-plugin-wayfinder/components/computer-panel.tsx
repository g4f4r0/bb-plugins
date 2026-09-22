import {
  experimental_Icon as Icon,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { toast } from "sonner";

import { entityIdSchema } from "../src/contracts/primitives.js";
import type { ComputerSnapshot, HumanInput } from "../src/contracts/run.js";
import { errorMessage, RUN_STATE_LABEL } from "./format.js";
import { DesktopView } from "./live-view.js";
import { COMPUTER_REALTIME_CHANNEL, type UiRpcContract } from "./rpc.js";

type LiveStatus = "connecting" | "live" | "disconnected";
type Machine = { hostId: string; name: string; status: "connected" | "disconnected"; phase: string };
const SNAPSHOT_INTERVAL_MS = 2_000;

export function selectedRunFromParams(params: unknown): string | null {
  const parsed = entityIdSchema.safeParse(params && typeof params === "object" && "runId" in params ? params.runId : null);
  return parsed.success ? parsed.data : null;
}
function selectedHostFromParams(params: unknown): string | null {
  const parsed = entityIdSchema.safeParse(params && typeof params === "object" && "hostId" in params ? params.hostId : null);
  return parsed.success ? parsed.data : null;
}
function frameUrl(base64: string, mimeType: string): string {
  if (typeof URL.createObjectURL !== "function" || navigator.userAgent.includes("jsdom")) return `data:${mimeType};base64,${base64}`;
  const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export function ComputerPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<UiRpcContract>();
  const connection = useRealtimeConnectionState();
  const selectedRunId = selectedRunFromParams(params);
  const requestedHostId = selectedHostFromParams(params);
  const clientId = useRef(`viewer_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`);
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [threadHostId, setThreadHostId] = useState<string | null>(null);
  const [hostId, setHostId] = useState<string | null>(requestedHostId);
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const [desktopFrame, setDesktopFrame] = useState<string | null>(null);
  const [desktopSize, setDesktopSize] = useState({ width: 1280, height: 720 });
  const [desktopState, setDesktopState] = useState<"connecting" | "ready" | "setup-required" | "unavailable">("connecting");
  const [desktopMessage, setDesktopMessage] = useState<string | null>(null);
  const [human, setHuman] = useState(false);
  const [takingControl, setTakingControl] = useState(false);
  const panelRoot = useRef<HTMLDivElement>(null);
  const panelVisible = useRef(true);
  const windowFocused = useRef(typeof document === "undefined" || navigator.userAgent.includes("jsdom") || document.hasFocus());
  const previewInflight = useRef(false);
  const snapshotInflight = useRef(false);
  const inputQueue = useRef(Promise.resolve<unknown>(undefined));
  const [visibilityRevision, setVisibilityRevision] = useState(0);

  const refreshMachines = useCallback(async () => {
    const result = await rpc.call("computer.machines", { threadId });
    setMachines(result.machines);
    setThreadHostId(result.threadHostId);
  }, [rpc, threadId]);
  useEffect(() => { void refreshMachines().catch((cause) => setError(errorMessage(cause))); }, [refreshMachines]);

  const active = snapshot?.activeRun ?? null;
  const controlRunId = active && ["running", "verifying"].includes(active.state) ? active.runId : null;
  const disconnect = useCallback((targetHost = hostId) => {
    if (targetHost === null) return;
    setHuman(false);
    void rpc.call("computer.control.release", { hostId: targetHost, runId: null, clientId: clientId.current }).catch(() => undefined);
    void rpc.call("computer.disconnect", { hostId: targetHost, clientId: clientId.current }).catch(() => undefined);
  }, [hostId, rpc]);

  const selectMachine = useCallback((nextHostId: string | null) => {
    if (hostId !== null && hostId !== nextHostId) disconnect(hostId);
    setHostId(nextHostId);
    setSnapshot(null);
    setError(null);
    setDesktopState("connecting");
    setDesktopMessage(null);
    setDesktopFrame((current) => { if (current?.startsWith("blob:")) URL.revokeObjectURL(current); return null; });
    setLiveStatus("connecting");
  }, [disconnect, hostId]);

  const refresh = useCallback(async () => {
    if (hostId === null || snapshotInflight.current) return;
    snapshotInflight.current = true;
    try { setSnapshot(await rpc.call("computer.snapshot", { hostId, selectedRunId })); setError(null); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { snapshotInflight.current = false; }
  }, [rpc, hostId, selectedRunId]);
  useEffect(() => {
    if (hostId === null) return;
    void refresh();
    const timer = setInterval(() => { if (panelVisible.current && document.visibilityState !== "hidden") void refresh(); }, SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hostId, refresh]);
  useRealtime(COMPUTER_REALTIME_CHANNEL, () => { if (panelVisible.current) void refresh(); });

  useEffect(() => {
    const node = panelRoot.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (panelVisible.current && !visible) disconnect();
      panelVisible.current = visible;
      if (visible) setVisibilityRevision((value) => value + 1);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [disconnect]);
  useEffect(() => {
    const changed = () => {
      if (document.visibilityState === "hidden") disconnect();
      else setVisibilityRevision((value) => value + 1);
    };
    const blurred = () => { windowFocused.current = false; disconnect(); };
    const focused = () => { windowFocused.current = true; setVisibilityRevision((value) => value + 1); };
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("blur", blurred);
    window.addEventListener("focus", focused);
    return () => { document.removeEventListener("visibilitychange", changed); window.removeEventListener("blur", blurred); window.removeEventListener("focus", focused); disconnect(); };
  }, [disconnect]);

  useEffect(() => {
    if (hostId === null || !panelVisible.current || !windowFocused.current || document.visibilityState === "hidden") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (stopped || previewInflight.current || !panelVisible.current || !windowFocused.current || document.visibilityState === "hidden") return;
      previewInflight.current = true;
      try {
        const result = await rpc.call("computer.preview", { hostId, threadId, clientId: clientId.current });
        if (!stopped) {
          setDesktopState(result.state);
          setDesktopMessage(result.message);
          if (result.frame) {
            const next = frameUrl(result.frame.base64, result.frame.mimeType);
            setDesktopFrame((current) => { if (current?.startsWith("blob:")) URL.revokeObjectURL(current); return next; });
            setDesktopSize({ width: result.frame.width, height: result.frame.height });
            setLiveStatus("live");
          } else setLiveStatus("disconnected");
        }
      } catch (cause) {
        if (!stopped) { setDesktopState("unavailable"); setDesktopMessage(errorMessage(cause)); setLiveStatus("disconnected"); }
      } finally {
        previewInflight.current = false;
        if (!stopped && panelVisible.current && windowFocused.current && !document.hidden) timer = setTimeout(() => void poll(), 16);
      }
    };
    void poll();
    return () => { stopped = true; if (timer !== null) clearTimeout(timer); disconnect(hostId); };
  }, [disconnect, hostId, rpc, threadId, visibilityRevision]);

  const takeControl = async () => {
    if (hostId === null || desktopFrame === null || takingControl) return;
    setTakingControl(true);
    try {
      const result = await rpc.call("computer.control.acquire", { hostId, runId: controlRunId, clientId: clientId.current });
      if (result.state === "busy") { toast.error("Another viewer has control"); return; }
      setHuman(true);
    } catch (cause) { toast.error("Could not take control", { description: errorMessage(cause) }); }
    finally { setTakingControl(false); }
  };
  const releaseControl = () => {
    if (!human || hostId === null) return;
    setHuman(false);
    void rpc.call("computer.control.release", { hostId, runId: controlRunId, clientId: clientId.current }).catch(() => undefined);
  };
  const sendInput = (input: HumanInput) => {
    if (!human || hostId === null) return;
    inputQueue.current = inputQueue.current.then(() => rpc.call("computer.control.input", { hostId, runId: controlRunId, clientId: clientId.current, input })).catch((cause) => {
      setHuman(false);
      toast.error("Computer input disconnected", { description: errorMessage(cause) });
    });
  };
  useEffect(() => { if (human) document.querySelector<HTMLElement>('[aria-label="Live computer; click, type, paste, or scroll"]')?.focus(); }, [human]);

  const cancel = async () => {
    if (active === null) return;
    try { await rpc.call("runs.cancel", { runId: active.runId, reason: "Cancelled from the Computer view" }); toast.success("Run cancelled"); await refresh(); }
    catch (cause) { toast.error("Could not cancel run", { description: errorMessage(cause) }); }
  };

  if (hostId === null) return <MachinePicker ref={panelRoot} machines={machines} threadHostId={threadHostId} error={error} onRefresh={refreshMachines} onSelect={selectMachine} />;
  const machine = machines?.find((item) => item.hostId === hostId);
  const hostName = machine?.name ?? hostId;
  const connected = error === null && connection === "connected" && liveStatus === "live";
  const statusLabel = human ? "You’re controlling" : liveStatus === "live" ? "Connected" : liveStatus === "disconnected" ? "Disconnected" : "Connecting";

  const ratio = desktopSize.width / desktopSize.height;
  return <div ref={panelRoot} className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
    <main className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" style={{ containerType: "size" }}>
      <div className="group relative flex min-h-0 items-center justify-center overflow-hidden rounded-md border border-border bg-black text-white" style={{ width: `min(${desktopSize.width}px, calc(100cqw - 24px), calc((100cqh - 24px) * ${ratio}))`, aspectRatio: `${desktopSize.width} / ${desktopSize.height}` }}>
        {desktopFrame !== null ? <DesktopView imageUrl={desktopFrame} interactive={human} onInput={sendInput} /> : desktopState === "setup-required" || desktopState === "unavailable" ? <Notice title="Desktop unavailable">{desktopMessage ?? "Install Cua Driver and grant screen-recording permission on this computer."}</Notice> : <ViewportSkeleton />}

        {desktopFrame !== null && !human ? <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-black/0 opacity-0 transition-opacity group-hover:bg-black/25 group-hover:opacity-100 group-focus-within:bg-black/25 group-focus-within:opacity-100"><button type="button" onClick={() => void takeControl()} disabled={takingControl} className="pointer-events-auto inline-flex min-h-9 items-center gap-2 rounded-md bg-white px-3 text-xs font-medium text-black shadow-lg hover:bg-white/90 disabled:opacity-60">{takingControl ? <Icon name="Loading" className="size-4 animate-spin" aria-hidden="true" /> : <Icon name="Cursor" className="size-4" aria-hidden="true" />}{takingControl ? "Taking control…" : "Take control"}</button></div> : null}

        {active !== null ? <div className="absolute left-3 top-3 z-20 flex max-w-[calc(100%-6rem)] items-center gap-3 rounded-lg bg-black/70 px-3 py-2 shadow backdrop-blur"><div className="min-w-0"><div className="text-[10px] font-medium uppercase tracking-wide text-white/50">{RUN_STATE_LABEL[active.state] ?? active.state}</div><p className="truncate text-xs">{active.route.goal}</p></div><button type="button" onClick={() => void cancel()} className="shrink-0 rounded-md bg-white/10 px-2 py-1 text-[11px] hover:bg-white/20">Cancel</button></div> : null}
        {snapshot?.queue.length ? <div className="absolute right-3 top-3 z-20 rounded-full bg-black/70 px-3 py-1.5 text-xs shadow backdrop-blur">{snapshot.queue.length} queued</div> : null}
        <button type="button" disabled={!human} onClick={releaseControl} title={human ? "Release control" : statusLabel} className="absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-xs shadow backdrop-blur disabled:pointer-events-none disabled:opacity-100"><span className={`size-1.5 rounded-full ${connected ? "bg-emerald-400" : liveStatus === "disconnected" ? "bg-red-400" : "bg-amber-400"}`} aria-hidden="true" /><span>{statusLabel}</span></button>
        <button type="button" aria-label="All computers" onClick={() => selectMachine(null)} className="absolute bottom-3 right-3 z-20 flex max-w-[45%] items-center gap-1.5 rounded-full bg-black/75 px-3 py-1.5 text-xs text-white/70 shadow backdrop-blur hover:bg-black/90 hover:text-white"><Icon name="Laptop" className="size-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{hostName}</span></button>
      </div>
    </main>
  </div>;
}

function MachinePicker({ ref, machines, threadHostId, error, onRefresh, onSelect }: { ref: Ref<HTMLDivElement>; machines: Machine[] | null; threadHostId: string | null; error: string | null; onRefresh: () => Promise<void>; onSelect: (hostId: string) => void }) {
  const thread = machines?.filter((machine) => machine.hostId === threadHostId) ?? [];
  const others = machines?.filter((machine) => machine.hostId !== threadHostId) ?? [];
  return <div ref={ref} className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
    <header className="flex h-12 shrink-0 items-center justify-between border-b px-4"><span className="text-sm font-medium">Computers</span><button type="button" aria-label="Refresh computers" onClick={() => void onRefresh()} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><Icon name="RefreshCw" className="size-4" aria-hidden="true" /></button></header>
    <div className="min-h-0 flex-1 overflow-auto"><div className="m-auto w-full max-w-3xl px-6 py-12">
      {error ? <p role="alert" className="mb-4 text-sm text-destructive-text">{error}</p> : null}
      {machines === null ? <MachineListSkeleton /> : <>{thread.length > 0 ? <MachineGroup title="Thread computer" machines={thread} onSelect={onSelect} /> : null}<MachineGroup title={thread.length > 0 ? "Other computers" : "Available computers"} machines={others} onSelect={onSelect} />{machines.length === 0 ? <p className="text-sm text-muted-foreground">No computers enrolled.</p> : null}</>}
    </div></div>
  </div>;
}
function MachineGroup({ title, machines, onSelect }: { title: string; machines: Machine[]; onSelect: (hostId: string) => void }) {
  if (machines.length === 0) return null;
  return <section className="mb-6" aria-label={title}><h2 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h2><ul className="space-y-1">{machines.map((machine) => <li key={machine.hostId}><button type="button" disabled={machine.status !== "connected"} onClick={() => onSelect(machine.hostId)} className="flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"><Icon name="Laptop" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{machine.name}</span><span className="block truncate text-xs text-muted-foreground">{machine.status === "connected" ? "Available" : "Offline"}</span></span><span className={`size-2 rounded-full ${machine.status === "connected" ? "bg-emerald-500" : "bg-muted-foreground/40"}`} aria-hidden="true" /></button></li>)}</ul></section>;
}
function MachineListSkeleton() { return <div role="status" aria-label="Loading computers" className="space-y-3"><div className="h-4 w-28 animate-pulse rounded bg-muted" /><div className="h-14 animate-pulse rounded-md border bg-muted/40" /><div className="h-14 animate-pulse rounded-md border bg-muted/40" /></div>; }
function ViewportSkeleton() { return <div role="status" aria-label="Loading computer" className="h-full max-h-[1080px] w-full max-w-[1920px] animate-pulse rounded-md bg-white/[0.06]"><span className="sr-only">Connecting to computer</span></div>; }
function Notice({ title, children }: { title: string; children: string }) { return <div role="status" className="flex h-full min-h-0 items-center justify-center bg-black px-8 text-center text-white"><div><Icon name="Laptop" aria-hidden="true" className="mx-auto mb-3 size-8 text-white/35" /><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 max-w-sm text-sm text-white/55">{children}</p></div></div>; }
