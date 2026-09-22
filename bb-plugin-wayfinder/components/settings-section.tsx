import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { wayfinderSettingsRpcContract, HostSummary, WayfinderSettingsState } from "../src/contracts/settings.js";
import { errorMessage } from "./format.js";

const HTTP_BASE = "/api/v1/plugins/wayfinder/http";
const JEV_MODEL = "jev-latest";
const controlClass = "h-8 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-64";
const buttonClass = "rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50";
type SettingsRpcContract = typeof wayfinderSettingsRpcContract;

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${HTTP_BASE}${path}`, {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof parsed.message === "string" ? parsed.message : `Request failed (${response.status})`);
  return parsed;
}

export function WayfinderSettingsSection() {
  const rpc = useRpc<SettingsRpcContract>();
  const [hosts, setHosts] = useState<HostSummary[] | null>(null);
  const [state, setState] = useState<WayfinderSettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [hostList, settings] = await Promise.all([rpc.call("settings.hosts", {}), rpc.call("settings.get", {})]);
      setHosts(hostList); setState(settings); setError(null);
    } catch (cause) { setError(errorMessage(cause)); }
  }, [rpc]);
  useEffect(() => { void refresh(); }, [refresh]);

  const selectHost = async (hostId: string | null) => {
    try { setState(await rpc.call("settings.selectHost", { hostId })); setError(null); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const selectJev = async () => {
    const next = await rpc.call("settings.saveProvider", { provider: "jev", model: JEV_MODEL });
    setState(next);
  };

  if (error !== null && state === null) return <Notice>{error}</Notice>;
  if (state === null || hosts === null) return <div role="status" aria-label="Loading settings" className="flex justify-center py-6"><Icon name="Loading" className="size-4 animate-spin text-muted-foreground" aria-hidden="true" /></div>;

  return (
    <div className="space-y-4">
      {error !== null ? <Notice>{error}</Notice> : null}
      <div className="rounded-lg border border-border bg-card px-3 py-1">
        <SettingRow label="Computer" description="The machine used for the Computer view.">
          <select aria-label="Computer host" className={controlClass} value={state.selectedHostId ?? ""}
            onChange={(event) => void selectHost(event.target.value || null)} disabled={hosts.length === 0}>
            <option value="">{hosts.length === 0 ? "No machines available" : "Select a machine"}</option>
            {hosts.map((host) => <option key={host.hostId} value={host.hostId} disabled={host.status !== "connected"}>
              {host.name}{host.status === "connected" ? "" : " (disconnected)"}
            </option>)}
          </select>
        </SettingRow>
        <ProviderKeyForm state={state} onSelectJev={selectJev} onRefresh={refresh} />
      </div>
    </div>
  );
}

function ProviderKeyForm({ state, onSelectJev, onRefresh }: {
  state: WayfinderSettingsState;
  onSelectJev: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"model" | "save" | "test" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const jevSelected = state.provider === "jev" && state.model === JEV_MODEL;
  // Do not label a previously selected provider's key as the Jev key.
  const keyStatus = state.provider === "jev" ? state.keyStatus : "unknown";

  const act = async (action: "model" | "save" | "test") => {
    if (busy !== null) return;
    setBusy(action); setMessage(null);
    try {
      if (!jevSelected) await onSelectJev();
      if (action === "model") return;
      const result = await postJson(action === "save" ? "/settings/key" : "/settings/key/test",
        action === "save" ? { provider: "jev", key } : { provider: "jev" });
      if (action === "save") setKey("");
      setMessage({ ok: result.ok === true, text: String(result.message ?? "") });
      await onRefresh();
    } catch (cause) { setMessage({ ok: false, text: errorMessage(cause) }); }
    finally { setBusy(null); }
  };

  return <>
    <SettingRow label="Model" description="Jev chooses the next action. Connects directly to TypeSafe.">
      <div className="flex w-full flex-col items-end gap-2 sm:w-64">
        <select aria-label="Model" className={controlClass} value={jevSelected ? JEV_MODEL : ""}
          disabled={busy !== null} onChange={() => void act("model")}>
          {!jevSelected ? <option value="" disabled>Select a model</option> : null}
          <option value={JEV_MODEL}>Jev</option>
        </select>
      </div>
    </SettingRow>
    <SettingRow label={<>API key <span className="ml-1 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground">secret</span></>}
      description="Shared server key, stored securely in Infisical.">
      <input type="password" autoComplete="off" aria-label="Jev API key" className={controlClass}
        placeholder={keyStatus === "configured" ? "[set]" : "Enter API key"}
        value={key} onChange={(event) => setKey(event.target.value)} disabled={busy !== null} />
    </SettingRow>
    <div className="flex flex-wrap items-center justify-between gap-3 pb-3 pt-1">
      <span className="text-xs text-muted-foreground" role="status">
        {keyStatus === "configured" ? "Configured" : keyStatus === "missing" ? "Missing" : "Not checked"}
      </span>
      <div className="flex gap-2">
        <button type="button" className={buttonClass} disabled={busy !== null || key.trim() === ""} onClick={() => void act("save")}>{busy === "save" ? "Saving…" : "Save"}</button>
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void act("test")}>{busy === "test" ? "Testing…" : "Test connection"}</button>
      </div>
    </div>
    {message !== null ? <p role="status" className={`pb-3 text-xs ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
    {state.provider === "jev" && state.lastTest !== null ? <p className="pb-3 text-xs text-muted-foreground">Last test {state.lastTest.ok ? "succeeded" : "failed"}: {state.lastTest.message}</p> : null}
  </>;
}

function SettingRow({ label, description, children }: { label: ReactNode; description: string; children: ReactNode }) {
  return <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
    <div className="min-w-0 flex-1"><div className="text-sm font-medium">{label}</div><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div>
    <div className="w-full shrink-0 sm:w-64">{children}</div>
  </div>;
}
function Notice({ children }: { children: ReactNode }) { return <p role="status" className="text-sm text-destructive">{children}</p>; }
