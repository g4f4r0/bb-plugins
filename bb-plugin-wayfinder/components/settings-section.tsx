import { useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";

import type { wayfinderSettingsRpcContract, HostSummary, ProviderId, WayfinderSettingsState } from "../src/contracts/settings.js";
import { errorMessage } from "./format.js";

const HTTP_BASE = "/api/v1/plugins/wayfinder/http";
const PROVIDER_LABEL: Record<ProviderId, string> = { jev: "Jev (TypeSafe)", openrouter: "OpenRouter" };

type SettingsRpcContract = typeof wayfinderSettingsRpcContract;

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${HTTP_BASE}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
      setHosts(hostList);
      setState(settings);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [rpc]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectHost = async (hostId: string | null) => {
    try {
      setState(await rpc.call("settings.selectHost", { hostId }));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const saveProvider = async (provider: ProviderId, model: string) => {
    try {
      setState(await rpc.call("settings.saveProvider", { provider, model }));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  if (error !== null && state === null) return <Notice tone="error">{error}</Notice>;
  if (state === null || hosts === null) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      {error !== null ? <Notice tone="error">{error}</Notice> : null}
      <HostPicker hosts={hosts} selectedHostId={state.selectedHostId} onSelect={(hostId) => void selectHost(hostId)} />
      <ProviderKeyForm state={state} onSaveProvider={(provider, model) => void saveProvider(provider, model)} onRefresh={refresh} />
    </div>
  );
}

function HostPicker({
  hosts,
  selectedHostId,
  onSelect,
}: {
  hosts: HostSummary[];
  selectedHostId: string | null;
  onSelect: (hostId: string | null) => void;
}) {
  return (
    <section aria-labelledby="wf-settings-host" className="space-y-2">
      <h3 id="wf-settings-host" className="text-sm font-semibold text-foreground">
        Computer
      </h3>
      <p className="text-sm text-muted-foreground">The enrolled host Wayfinder's Computer view controls.</p>
      {hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No hosts are enrolled yet. Enroll one with `bb host list`.</p>
      ) : (
        <select
          aria-label="Computer host"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={selectedHostId ?? ""}
          onChange={(event) => onSelect(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">Not selected</option>
          {hosts.map((host) => (
            <option key={host.hostId} value={host.hostId} disabled={host.status !== "connected"}>
              {host.name} — {host.status === "connected" ? "connected" : `disconnected (${host.phase})`}
            </option>
          ))}
        </select>
      )}
      {selectedHostId !== null && !hosts.some((host) => host.hostId === selectedHostId) ? (
        <Notice tone="warn">The previously selected host is no longer enrolled. Choose another to restore the Computer view.</Notice>
      ) : null}
    </section>
  );
}

function ProviderKeyForm({
  state,
  onSaveProvider,
  onRefresh,
}: {
  state: WayfinderSettingsState;
  onSaveProvider: (provider: ProviderId, model: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [provider, setProvider] = useState<ProviderId>(state.provider);
  const [model, setModel] = useState(state.model);
  const [key, setKey] = useState("");
  const [savingProvider, setSavingProvider] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  useEffect(() => { setProvider(state.provider); setModel(state.model); }, [state.provider, state.model]);

  const saveProvider = async () => {
    setSavingProvider(true);
    try {
      onSaveProvider(provider, model);
    } finally {
      setSavingProvider(false);
    }
  };

  const saveKey = async () => {
    if (key.trim() === "") return;
    setSavingKey(true);
    setActionMessage(null);
    try {
      const result = await postJson("/settings/key", { provider, key });
      setKey("");
      setActionMessage({ tone: result.ok === true ? "ok" : "error", text: String(result.message ?? "") });
      await onRefresh();
    } catch (cause) {
      setActionMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setSavingKey(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setActionMessage(null);
    try {
      const result = await postJson("/settings/key/test", { provider });
      setActionMessage({ tone: result.ok === true ? "ok" : "warn", text: String(result.message ?? "") });
      await onRefresh();
    } catch (cause) {
      setActionMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section aria-labelledby="wf-settings-provider" className="space-y-3">
      <h3 id="wf-settings-provider" className="text-sm font-semibold text-foreground">
        Decision provider
      </h3>
      <p className="text-sm text-muted-foreground">
        Server-wide credential, resolved from the verified Infisical scope at run time. Never stored in BB settings.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Provider</span>
          <select
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderId)}
          >
            <option value="jev">{PROVIDER_LABEL.jev}</option>
            <option value="openrouter">{PROVIDER_LABEL.openrouter}</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Model</span>
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="e.g. openai/gpt-5"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={() => void saveProvider()}
        disabled={savingProvider || model.trim() === ""}
        className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
      >
        Save provider
      </button>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground">API key</span>
          <StatusBadge status={state.keyStatus} />
        </div>
        <input
          type="password"
          autoComplete="off"
          aria-label={`${PROVIDER_LABEL[provider]} API key`}
          placeholder={state.keyStatus === "configured" ? "•••••••••• (configured — enter a new value to replace it)" : "Enter API key"}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void saveKey()}
            disabled={savingKey || key.trim() === ""}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            {savingKey ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => void testKey()}
            disabled={testing}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
        </div>
        {actionMessage !== null ? <Notice tone={actionMessage.tone}>{actionMessage.text}</Notice> : null}
        {state.lastTest !== null ? (
          <p className="text-xs text-muted-foreground">
            Last test {state.lastTest.ok ? "succeeded" : "failed"}: {state.lastTest.message} ({new Date(state.lastTest.testedAt).toLocaleString()})
          </p>
        ) : null}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: WayfinderSettingsState["keyStatus"] }) {
  const toneClass =
    status === "configured"
      ? "border-border text-foreground"
      : status === "missing"
        ? "border-destructive/40 text-destructive"
        : "border-border text-muted-foreground";
  const label = status === "configured" ? "Configured" : status === "missing" ? "Missing" : "Unknown";
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${toneClass}`}>{label}</span>;
}

function Notice({ tone, children }: { tone: "ok" | "warn" | "error"; children: React.ReactNode }) {
  const toneClass = tone === "ok" ? "text-foreground" : tone === "warn" ? "text-amber-600" : "text-destructive";
  return (
    <p role="status" className={`text-sm ${toneClass}`}>
      {children}
    </p>
  );
}
