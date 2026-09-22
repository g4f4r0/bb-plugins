import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { wayfinderSettingsRpcContract, HostSummary, ProviderId, WayfinderSettingsState } from "../src/contracts/settings.js";
import { errorMessage } from "./format.js";

const SAVE_URL = "/api/v1/plugins/wayfinder/http/settings/save";
const controlClass = "h-8 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-64";
type SettingsRpcContract = typeof wayfinderSettingsRpcContract;

export function WayfinderSettingsSection() {
  const rpc = useRpc<SettingsRpcContract>();
  const [hosts, setHosts] = useState<HostSummary[] | null>(null);
  const [saved, setSaved] = useState<WayfinderSettingsState | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [provider, setProvider] = useState<ProviderId>("jev");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const [nextHosts, next] = await Promise.all([rpc.call("settings.hosts", {}), rpc.call("settings.get", {})]);
    setHosts(nextHosts); setSaved(next); setHostId(next.selectedHostId); setProvider(next.provider);
  }, [rpc]);
  useEffect(() => { void refresh().catch((cause) => setMessage({ ok: false, text: errorMessage(cause) })); }, [refresh]);

  if (saved === null || hosts === null) return <div role="status" aria-label="Loading settings" className="flex justify-center py-6"><Icon name="Loading" className="size-4 animate-spin text-muted-foreground" aria-hidden="true" /></div>;

  const configured = provider === saved.provider && saved.keyStatus === "configured";
  const save = async () => {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(SAVE_URL, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId, provider, ...(key.trim() ? { key } : {}) }),
      });
      const body = await response.json() as { ok?: boolean; message?: string };
      if (!response.ok || body.ok !== true) throw new Error(body.message || `Request failed (${response.status})`);
      setKey(""); await refresh(); setMessage({ ok: true, text: body.message || "Saved" });
    } catch (cause) { setMessage({ ok: false, text: errorMessage(cause) }); }
    finally { setBusy(false); }
  };

  return <div className="space-y-4">
    <div className="rounded-lg border border-border bg-card px-3 py-1">
      <SettingRow label="Computer" description="Machine used for browser sessions.">
        <select aria-label="Computer host" className={controlClass} value={hostId ?? ""} disabled={busy || hosts.length === 0} onChange={(event) => setHostId(event.target.value || null)}>
          <option value="">{hosts.length === 0 ? "No machines available" : "Select a machine"}</option>
          {hosts.map((host) => <option key={host.hostId} value={host.hostId} disabled={host.status !== "connected"}>{host.name}{host.status === "connected" ? "" : " (disconnected)"}</option>)}
        </select>
      </SettingRow>
      <SettingRow label="Provider" description="Provider used to access Jev.">
        <select aria-label="Provider" className={controlClass} value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as ProviderId); setKey(""); setMessage(null); }}>
          <option value="jev">TypeSafe</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </SettingRow>
      <SettingRow label="Model" description="The decision model used by Wayfinder.">
        <div aria-label="Model" className="flex h-8 items-center text-sm">Jev</div>
      </SettingRow>
      <SettingRow label={<>API key <span className="ml-1 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">secret</span></>} description={`Your ${provider === "jev" ? "TypeSafe" : "OpenRouter"} API key.`}>
        <input type="password" autoComplete="off" aria-label={`${provider === "jev" ? "TypeSafe" : "OpenRouter"} API key`} className={controlClass}
          placeholder={configured ? "[set]" : "Enter API key"} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} />
      </SettingRow>
      <div className="flex items-center justify-between gap-3 pb-3 pt-1">
        <span className="text-xs text-muted-foreground">{configured ? "Configured" : "Not configured"}</span>
        <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      </div>
      {message ? <p role="status" className={`pb-3 text-xs ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
    </div>
  </div>;
}

function SettingRow({ label, description, children }: { label: ReactNode; description: string; children: ReactNode }) {
  return <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
    <div className="min-w-0 flex-1"><div className="text-sm font-medium">{label}</div><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div>
    <div className="w-full shrink-0 sm:w-64">{children}</div>
  </div>;
}
