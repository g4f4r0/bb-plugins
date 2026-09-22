import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { wayfinderSettingsRpcContract, HostSummary, ProviderId, WayfinderSettingsState } from "../src/contracts/settings.js";
import { errorMessage } from "./format.js";

const SAVE_URL = "/api/v1/plugins/wayfinder/http/settings/save";
const controlClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-64";
type SettingsRpcContract = typeof wayfinderSettingsRpcContract;

export function WayfinderSettingsSection() {
  const rpc = useRpc<SettingsRpcContract>();
  const [hosts, setHosts] = useState<HostSummary[] | null>(null);
  const [saved, setSaved] = useState<WayfinderSettingsState | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderId>("jev");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextHosts, next] = await Promise.all([rpc.call("settings.hosts", {}), rpc.call("settings.get", {})]);
    setHosts(nextHosts); setSaved(next); setHostId(next.selectedHostId); setProvider(next.provider);
  }, [rpc]);
  const refreshHosts = useCallback(async (hostId: string) => {
    setChecking(hostId);
    try { setHosts(await rpc.call("settings.hosts", {})); }
    catch (cause) { toast.error("Could not check machine", { description: errorMessage(cause) }); }
    finally { setChecking(null); }
  }, [rpc]);
  useEffect(() => { void refresh().catch((cause) => toast.error("Could not load Wayfinder settings", { description: errorMessage(cause) })); }, [refresh]);

  if (saved === null || hosts === null) return <div role="status" aria-label="Loading settings" className="flex justify-center py-6"><Icon name="Loading" className="size-4 animate-spin text-muted-foreground" aria-hidden="true" /></div>;

  const configured = provider === saved.provider && saved.keyStatus === "configured";
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(SAVE_URL, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId, provider, ...(key.trim() ? { key } : {}) }),
      });
      const body = await response.json() as { ok?: boolean; message?: string };
      if (!response.ok || body.ok !== true) throw new Error(body.message || `Request failed (${response.status})`);
      setKey(""); await refresh(); toast.success("Settings saved");
    } catch (cause) { toast.error("Could not save settings", { description: errorMessage(cause) }); }
    finally { setBusy(false); }
  };

  return <div className="space-y-6">
    {hosts.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">No machines enrolled.</p> : (
      <div role="list" aria-label="Machines" className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-background">
        {hosts.map((host) => <MachineSetupPanel key={host.hostId} host={host} fallback={host.hostId === hostId} checking={checking === host.hostId} onCheck={() => void refreshHosts(host.hostId)} />)}
      </div>
    )}

    <div>
      <h3 className="mb-1 text-sm font-semibold">Configuration</h3>
      <p className="mb-3 text-xs text-muted-foreground">Used by browser-only runs when the thread machine cannot run Wayfinder.</p>
      <div className="rounded-lg border border-border/70 bg-background px-3 py-1">
        <SettingRow label="Fallback machine" description="The thread machine is always preferred.">
          <select aria-label="Computer host" className={controlClass} value={hostId ?? ""} disabled={busy || hosts.length === 0} onChange={(event) => setHostId(event.target.value || null)}>
            <option value="">No fallback</option>
            {hosts.map((host) => <option key={host.hostId} value={host.hostId} disabled={host.status !== "connected"}>{host.name}{host.os ? ` — ${host.os} ${host.arch ?? ""}` : ""}{host.status === "connected" ? "" : " — offline"}</option>)}
          </select>
        </SettingRow>
        <SettingRow label="Provider" description="Provider used to access Jev.">
          <select aria-label="Provider" className={controlClass} value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as ProviderId); setKey(""); }}>
            <option value="jev">TypeSafe</option><option value="openrouter">OpenRouter</option>
          </select>
        </SettingRow>
        <SettingRow label="Model" description="Decision model used by Wayfinder."><div aria-label="Model" className="flex h-9 items-center text-sm">Jev</div></SettingRow>
        <SettingRow label={<>API key <span className="ml-1 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">secret</span></>} description={`Your ${provider === "jev" ? "TypeSafe" : "OpenRouter"} API key.`}>
          <input type="password" autoComplete="off" aria-label={`${provider === "jev" ? "TypeSafe" : "OpenRouter"} API key`} className={controlClass} placeholder={configured ? "[set]" : "Enter API key"} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} />
        </SettingRow>
        <div className="flex justify-end pb-3 pt-2"><button type="button" className="min-h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></div>
      </div>
    </div>
  </div>;
}

function MachineSetupPanel({ host, fallback, checking, onCheck }: { host: HostSummary; fallback: boolean; checking: boolean; onCheck: () => void }) {
  const online = host.status === "connected";
  const checks = [
    { label: "Machine connection", ready: online, detail: online ? "Online" : "Offline" },
    { label: "Platform", ready: host.os !== null && host.arch !== null, detail: host.os && host.arch ? `${host.os} · ${host.arch}` : "Not available" },
    { label: "Fortress browser", ready: host.browserState === "ready", detail: stateLabel(host.browserState) },
    { label: "Jev provider", ready: host.providerState === "ready", detail: stateLabel(host.providerState) },
  ];
  const complete = checks.filter((check) => check.ready).length;
  const needsAttention = !online || complete !== checks.length;
  const [open, setOpen] = useState(needsAttention);
  useEffect(() => { if (needsAttention) setOpen(true); }, [needsAttention]);

  if (!online) return <div role="listitem" className="flex min-h-12 items-center justify-between gap-3 px-3 py-3 text-sm"><span className="flex min-w-0 items-center gap-3"><ConnectionDot online={false} /><span className="truncate font-medium">{host.name}</span>{fallback ? <Tag>fallback</Tag> : null}</span><Tag>Offline</Tag></div>;

  return <div role="listitem">
    <button type="button" aria-expanded={open} aria-label={`${host.name} setup, ${needsAttention ? "needs attention" : "ready"}, ${complete} of ${checks.length}`} onClick={() => setOpen((value) => !value)} className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-3 text-left text-sm hover:bg-accent/40">
      <span className="flex min-w-0 items-center gap-3"><ConnectionDot online /><span className="truncate font-medium">{host.name}</span>{fallback ? <Tag>fallback</Tag> : null}</span>
      <span className="flex shrink-0 items-center gap-2"><span className={needsAttention ? "text-warning-text" : "text-success-foreground"}>{needsAttention ? `Setup needs attention · ${complete}/${checks.length}` : "Ready"}</span><Chevron open={open} /></span>
    </button>
    {open ? <div className="border-t border-border/60 px-3 pb-3 pt-2">
      <ol className="divide-y divide-border/50" aria-label={`Setup checklist for ${host.name}`}>
        {checks.map((check) => <li key={check.label} className="flex items-center justify-between gap-4 py-2.5"><span className="text-sm font-medium">{check.label}</span><span className="flex items-center gap-2 text-xs text-muted-foreground"><span>{check.detail}</span><CheckIcon ready={check.ready} /></span></li>)}
      </ol>
      <button type="button" className="mt-3 min-h-10 w-full rounded-full border border-border text-sm hover:bg-accent disabled:opacity-50" disabled={checking} onClick={onCheck}>{checking ? "Checking setup…" : "Check setup"}</button>
    </div> : null}
  </div>;
}

function ConnectionDot({ online }: { online: boolean }) { return <span aria-hidden="true" className="relative grid size-5 shrink-0 place-items-center">{online ? <><span className="absolute size-2.5 rounded-full bg-success/25 motion-safe:animate-pulse" /><span className="relative size-1.5 rounded-full bg-success" /></> : <span className="size-1.5 rounded-full border border-muted-foreground/70 bg-muted/50" />}</span>; }
function CheckIcon({ ready }: { ready: boolean }) { return <span aria-label={ready ? "Ready" : "Action required"} className={`grid size-5 place-items-center rounded-full border border-border/60 ${ready ? "text-success" : "text-warning-text"}`}><svg aria-hidden="true" viewBox="0 0 12 12" className="size-3">{ready ? <path d="m2.5 6.2 2.1 2.1 4.9-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /> : <path d="M6 2.5v4.2m0 2.3v.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />}</svg></span>; }
function Chevron({ open }: { open: boolean }) { return <svg aria-hidden="true" viewBox="0 0 16 16" className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" /></svg>; }
function Tag({ children }: { children: ReactNode }) { return <span className="rounded border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">{children}</span>; }
function stateLabel(state: HostSummary["browserState"]): string { return state === "ready" ? "Ready" : state === "unavailable" ? "Unavailable" : state === "setup-required" ? "Setup required" : "Not checked"; }
function SettingRow({ label, description, children }: { label: ReactNode; description: string; children: ReactNode }) { return <div className="flex flex-col gap-2 border-b border-border/50 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{label}</div><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div><div className="w-full shrink-0 sm:w-64">{children}</div></div>; }
