import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import type { ProviderId, WayfinderSettingsState, wayfinderSettingsRpcContract } from "../src/contracts/settings.js";
import { errorMessage } from "./format.js";

const SAVE_URL = "/api/v1/plugins/wayfinder/http/settings/save";
const controlClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-64";
type SettingsRpcContract = typeof wayfinderSettingsRpcContract;

export function WayfinderSettingsSection() {
  const rpc = useRpc<SettingsRpcContract>();
  const [saved, setSaved] = useState<WayfinderSettingsState | null>(null);
  const [provider, setProvider] = useState<ProviderId>("jev");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await rpc.call("settings.get", {});
    setSaved(next);
    setProvider(next.provider);
  }, [rpc]);
  useEffect(() => { void refresh().catch((cause) => toast.error("Could not load Wayfinder settings", { description: errorMessage(cause) })); }, [refresh]);

  if (saved === null) return <div role="status" aria-label="Loading settings" className="flex justify-center py-6"><Icon name="Loading" className="size-4 animate-spin text-muted-foreground" aria-hidden="true" /></div>;

  const configured = provider === saved.provider && saved.keyStatus === "configured";
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(SAVE_URL, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, ...(key.trim() ? { key } : {}) }),
      });
      const body = await response.json() as { ok?: boolean; message?: string };
      if (!response.ok || body.ok !== true) throw new Error(body.message || `Request failed (${response.status})`);
      setKey(""); await refresh(); toast.success("Settings saved");
    } catch (cause) { toast.error("Could not save settings", { description: errorMessage(cause) }); }
    finally { setBusy(false); }
  };

  return <div className="rounded-lg border border-border/70 bg-background px-3 py-1">
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
  </div>;
}

function SettingRow({ label, description, children }: { label: ReactNode; description: string; children: ReactNode }) {
  return <div className="flex flex-col gap-2 border-b border-border/50 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"><div className="min-w-0 flex-1"><div className="text-sm font-medium">{label}</div><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div><div className="w-full shrink-0 sm:w-64">{children}</div></div>;
}
