import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { browserIcons, type BrowserIconName } from "./src/browser-icons";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  useBbContext,
  useBbNavigate,
  useRealtime,
  experimental_Icon as Icon,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, health, Job, Session } from "./src/contracts";
import type { z } from "zod";
import { openClientExternal } from "./src/client-external";
import { browseLink } from "./src/link-routing";
import { CredentialForm } from "./components/credential-form";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import {
  SettingsSection,
  SettingsRowList,
  SettingsRow,
} from "./components/ui/settings-section";

function BrowserActionTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={400}><TooltipPrimitive.Root><TooltipPrimitive.Trigger asChild><span className="inline-flex">{children}</span></TooltipPrimitive.Trigger><TooltipPrimitive.Portal><TooltipPrimitive.Content side="bottom" sideOffset={4} collisionPadding={8} className="z-50 rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md">{label}</TooltipPrimitive.Content></TooltipPrimitive.Portal></TooltipPrimitive.Root></TooltipPrimitive.Provider>;
}

type Health = z.infer<typeof health>;
type Machine = { hostId: string; label: string; connected: boolean };

function MachineDependencies({
  machine,
  revision,
}: {
  machine: Machine;
  revision: number;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<Health | null>(null),
    [busy, setBusy] = useState<"check" | "install" | null>(null),
    [error, setError] = useState(""),
    [job, setJob] = useState<Job | null>(null);
  const alive = useRef(true),
    locked = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  const check = useCallback(async () => {
    if (!machine.connected || locked.current) return;
    locked.current = true;
    const gen = generation.current;
    setBusy("check");
    setError("");
    try {
      const next = await rpc.call("probe", { hostId: machine.hostId });
      if (alive.current && gen === generation.current) setInfo(next);
    } catch (e) {
      if (alive.current && gen === generation.current) {
        setInfo(null);
        setError(String(e));
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(null);
    }
  }, [rpc, machine.hostId, machine.connected]);
  useEffect(() => {
    if (!machine.connected) {
      generation.current++;
      setInfo(null);
      setError("");
      return;
    }
    void check();
  }, [check, revision, machine.connected]);
  async function install() {
    if (locked.current || !machine.connected) return;
    locked.current = true;
    setBusy("install");
    setError("");
    const gen = generation.current;
    try {
      const started = await rpc.call("setup", {
        hostId: machine.hostId,
        dependencies: true,
      });
      let current: Job = started;
      while (alive.current && gen === generation.current) {
        setJob(current);
        if (current.status !== "running") break;
        await new Promise((r) => setTimeout(r, 1200));
        if (!alive.current || gen !== generation.current) return;
        current = await rpc.call("job", {
          hostId: machine.hostId,
          id: current.id,
        });
      }
      if (!alive.current || gen !== generation.current) return;
      if (current.status !== "succeeded")
        throw Error(current.error ?? current.status);
      const next = await rpc.call("probe", { hostId: machine.hostId });
      if (alive.current && gen === generation.current) setInfo(next);
    } catch (e) {
      if (alive.current && gen === generation.current) setError(String(e));
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(null);
        setJob(null);
      }
    }
  }
  const rows = [
    {
      name: "Fortress browser",
      icon: "Globe",
      ready: info?.browserRunnable,
      version: info?.browserVersion?.replace(/^(Fortress|Chromium)\s*/i, ""),
      status: info
        ? info.browserRunnable
          ? "Launch verified"
          : info.browserInstalled
            ? "Installed, cannot launch"
            : "Not installed"
        : "Not checked",
    },
    {
      name: "Browse control",
      icon: "Terminal",
      ready: info?.installed,
      version: info?.installed ? info.version : null,
      status: info
        ? info.installed
          ? "Ready"
          : "Not installed"
        : "Not checked",
    },
    {
      name: "FFmpeg",
      icon: "Play",
      ready: info?.ffmpeg,
      version: null,
      status: info
        ? info.ffmpeg
          ? "Ready for recording"
          : "Recording unavailable"
        : "Not checked",
    },
  ];
  if (!info || info.platform === "linux")
    rows.push(
      {
        name: "Display",
        icon: "Monitor",
        ready: info ? info.display !== "missing" : undefined,
        version: null,
        status: info
          ? info.display === "host"
            ? "Host DISPLAY"
            : info.display === "virtual"
              ? "Virtual display (Xvfb)"
              : "No display — install Xvfb and keyboard files"
          : "Not checked",
      },
      {
        name: "Xvfb",
        icon: "AppWindow",
        ready: info?.xvfb,
        version: null,
        status: info
          ? info.xvfb
            ? "Installed"
            : "Not installed"
          : "Not checked",
      },
      {
        name: "xkbcomp",
        icon: "Keyboard",
        ready: info?.xkbcomp,
        version: null,
        status: info
          ? info.xkbcomp
            ? "Keyboard compiler ready"
            : "Not installed — x11-xkb-utils"
          : "Not checked",
      },
      {
        name: "XKB keymap data",
        icon: "FileCode",
        ready: info?.xkbData,
        version: null,
        status: info
          ? info.xkbData
            ? "Installed"
            : "Not installed — xkb-data"
          : "Not checked",
      },
    );
  return (
    <section aria-label={machine.label}>
      <SettingsSection
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Icon
              name="Laptop"
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="truncate">{machine.label}</span>
          </span>
        }
        action={
          machine.connected ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Recheck ${machine.label}`}
              disabled={Boolean(busy)}
              onClick={() => void check()}
            >
              {busy === "check" ? "Checking…" : "Recheck"}
            </Button>
          ) : undefined
        }
      >
        <SettingsRowList>
          {!machine.connected ? (
            <SettingsRow className="py-3.5">
              <Icon
                name="Globe"
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Browser dependencies</p>
                <p className="mt-0.5 text-xs text-subtle-foreground/75">
                  Machine offline · reconnect to check
                </p>
              </div>
              <Icon
                name="CircleX"
                className="size-4 text-muted-foreground"
                aria-label="Offline"
              />
            </SettingsRow>
          ) : (
            rows.map((row) => (
              <SettingsRow key={row.name} className="py-3.5">
                <Icon
                  name={row.icon}
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <p className="text-sm font-medium text-foreground">
                      {row.name}
                    </p>
                    {row.version && (
                      <span className="text-xs text-subtle-foreground/75">
                        {row.version}
                      </span>
                    )}
                  </div>
                  <p
                    className={`mt-0.5 text-xs ${info && !row.ready ? "text-warning-text" : "text-subtle-foreground/75"}`}
                  >
                    {busy === "install"
                      ? "Installing…"
                      : busy === "check"
                        ? "Checking…"
                        : row.status}
                  </p>
                </div>
                {!busy && info && (
                  <Icon
                    name={row.ready ? "CircleCheck" : "CircleX"}
                    className={`size-4 shrink-0 ${row.ready ? "text-muted-foreground/60" : "text-warning-text"}`}
                    aria-label={row.status}
                  />
                )}
              </SettingsRow>
            ))
          )}
        </SettingsRowList>
      </SettingsSection>
      {machine.connected && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span role="status" className="text-xs text-subtle-foreground/75">
            {busy === "install"
              ? `Installing dependencies${job ? ` · ${Math.round(job.durationMs / 1000)}s` : "…"}`
              : info
                ? `${info.platform} / ${info.arch}`
                : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label={`Install dependencies on ${machine.label}`}
            disabled={Boolean(busy)}
            onClick={() => void install()}
          >
            {busy === "install" ? "Installing…" : "Install dependencies"}
          </Button>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 break-words text-xs text-destructive-text"
        >
          {error}
        </p>
      )}
      {info?.launchError && (
        <details className="mt-2 text-xs text-subtle-foreground">
          <summary className="cursor-pointer">Launch details</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-destructive-text">
            {info.launchError}
          </pre>
        </details>
      )}
    </section>
  );
}

function BrowseSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<Machine[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const alive = useRef(true),
    fetching = useRef(false);
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setLoading(true);
    setError("");
    try {
      const items = await rpc.call("machines", null);
      if (alive.current) {
        setMachines(items);
        setRevision((v) => v + 1);
      }
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      fetching.current = false;
      if (alive.current) setLoading(false);
    }
  }, [rpc]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  return (
    <div className="space-y-6">
      <SettingsSection
        title="Machine dependencies"
        description="Manage browser and recording tools across all machines. Browsers follow their thread’s machine."
        bodyClassName="border-0 bg-transparent p-0"
        action={
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        }
      >
        <div className="space-y-6">
          {error && (
            <p role="alert" className="text-sm text-destructive-text">
              {error}
            </p>
          )}
          {!machines.length && (
            <p role="status" className="text-sm text-subtle-foreground">
              {loading
                ? "Loading machines…"
                : error
                  ? "Could not load machines."
                  : "No machines enrolled."}
            </p>
          )}
          {machines.map((machine) => (
            <MachineDependencies
              key={machine.hostId}
              machine={machine}
              revision={revision}
            />
          ))}
        </div>
      </SettingsSection>
      <div className="space-y-3 text-xs text-subtle-foreground/75">
        <details>
          <summary className="cursor-pointer text-subtle-foreground">
            Installation details
          </summary>
          <p className="mt-2 leading-relaxed">
            Installation requires internet access. Close active Browse sessions
            on the target machine before updating. On Debian/Ubuntu, missing
            libraries and FFmpeg are installed in Browse’s own directory without
            administrator access. Other systems use their installed libraries.
            Profiles and saved files are preserved.
          </p>
        </details>
        <p>
          Also from the CLI: <code>bb browse probe</code> and{" "}
          <code>bb browse setup</code>.
        </p>
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "hide-native-browser-launcher",
    mount() {
      // BB's launcher slots are additive. Scope this presentation override to
      // the core action's stable id, including its sortable row/drag handle.
      const style = document.createElement("style");
      style.dataset.browseNativeLauncher = "hidden";
      style.textContent = `
        #file-search-result-open-browser,
        div:has(> button#file-search-result-open-browser) { display: none !important; }
      `;
      document.head.append(style);
      return () => style.remove();
    },
  });
  app.slots.pendingInteraction({
    id: "browser-credentials",
    component: CredentialForm,
  });
  app.slots.settingsSection({
    id: "browse-settings",
    component: BrowseSettings,
  });
  app.slots.threadPanelAction({
    id: "live",
    title: "Open browser",
    icon: "Globe",
    layout: "flush",
    component: LiveBrowser,
    run: ({ openPanel }) => { openPanel({ title: "Browser", params: {} }); },
  });
  app.slots.experimental_threadHeaderAction({
    id: "auto-show",
    title: "Browser sessions",
    component: AutoShowBrowsers,
  });
});

function BrowseIcon({ name, className }: { name: BrowserIconName; className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" data-icon-library="hugeicons" className={className}>{browserIcons[name].map(([tag, props]) => createElement(tag, props))}</svg>;
}

function BrowserListSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="mb-6 space-y-1 motion-safe:animate-pulse">
    <div className="mb-2 h-4 w-28 rounded bg-muted" />
    {[0, 1].map(row => <div key={row} className="flex items-center gap-2 rounded-md border px-3 py-2" aria-hidden="true">
      <div className="size-4 rounded bg-muted" />
      <div className="flex-1 space-y-1"><div className="h-5 w-1/3 rounded bg-muted" /><div className="h-4 w-2/3 rounded bg-muted" /></div>
    </div>)}
  </div>;
}

function LoadingBrowserFrame({ url }: { url: string }) {
  return <div role="status" aria-label="Loading page" className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
    <div aria-label="Browser navigation" className="flex h-12 shrink-0 items-center gap-2 border-b px-4 py-2">
      <div className="flex shrink-0 items-center gap-1">{(["ArrowLeft", "ArrowRight", "RefreshCw"] as const).map(name => <span key={name} className="grid size-7 place-items-center text-muted-foreground"><BrowseIcon name={name} className="size-4" /></span>)}</div>
      <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md text-muted-foreground" style={{ boxShadow: "inset 0 0 0 1px var(--input, var(--border))" }}>
        <span className="min-w-0 flex-1 truncate px-3 py-1 text-xs">{url}</span>
        <span className="mr-0.5 grid size-7 shrink-0 place-items-center"><BrowseIcon name="Loading" className="size-4 animate-spin" /></span>
      </div>
      <div className="flex shrink-0 items-center gap-1"><span className="grid size-7 place-items-center text-muted-foreground"><BrowseIcon name="External" className="size-4" /></span><span className="grid size-7 shrink-0 place-items-center text-muted-foreground"><BrowseIcon name="More" className="size-4" /></span></div>
    </div>
    <div className="flex min-h-0 flex-1 items-center justify-center" style={{ containerType: "size" }}>
      <div aria-hidden="true" className="rounded-md border bg-muted motion-safe:animate-pulse" style={{ width: "min(1280px, calc(100cqw - 24px), calc((100cqh - 24px) * 1.6))", aspectRatio: "8 / 5" }} />
    </div>
  </div>;
}

function LiveBrowser(props: Parameters<typeof SessionBrowser>[0]) {
  if(props.params && typeof props.params==='object' && 'streamTest' in props.params && props.params.streamTest===true)
    return <iframe title="WebRTC browser test" className="h-full min-h-0 w-full border-0 bg-sidebar" src="/api/v1/plugins/browse/http/stream-test/viewer?id=bench&video=1" />;
  return <SessionBrowser {...props} />;
}

function SessionBrowser({
  params,
  threadId,
}: {
  threadId: string;
  params: unknown;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loadedViewerId, setLoadedViewerId] = useState("");
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [error, setError] = useState("");
  const id =
    params &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    "id" in params
      ? String((params as { id: unknown }).id)
      : "";
  const rememberedUrl =
    params &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    "url" in params &&
    typeof (params as { url?: unknown }).url === "string"
      ? (params as { url: string }).url
      : "";
  const sync = useCallback(async () => {
    try {
      setSessions((await rpc.call("list", { threadId })).filter(s => s.threadId === threadId));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally { setSessionsLoaded(true); }
  }, [rpc, threadId]);
  useEffect(() => {
    void sync();
    const timer = setInterval(() => void sync(), 30000);
    return () => clearInterval(timer);
  }, [sync]);
  useRealtime("browser-changed", () => {
    void sync();
  });
  const [address, setAddress] = useState("");
  const [opening, setOpening] = useState(false);
  useEffect(() => { setOpening(false); }, [id]);
  const launching = useRef(false);
  async function openAddress(raw = address) {
    if (launching.current) return;
    launching.current = true;
    setOpening(true);
    setError("");
    try {
      const text = raw.trim();
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Enter an http or https address without login details.");
      setAddress(url.href);
      await rpc.call("open-address", { threadId, url: url.href, paramsJson: JSON.stringify(params ?? {}) });
    } catch (e) { setError(String(e)); setOpening(false); }
    finally { launching.current = false; }
  }
  const [local, setLocal] = useState<{ servers: Array<{ port: number; name: string; url: string }>; error: string | null }>({ servers: [], error: null });
  useEffect(() => {
    if (id) return;
    let live = true;
    const refresh = () => { void rpc.call("local-servers", { threadId }).then(value => { if (live) setLocal(value); }).catch(() => { if (live) setLocal({ servers: [], error: "Local server discovery is unavailable." }); }).finally(() => { if (live) setLocalLoaded(true); }); };
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => { live = false; clearInterval(timer); };
  }, [id, threadId, rpc]);
  const active = sessions.filter(s => ["ready", "connecting"].includes(s.status));
  const seen = new Set(active.map(s => s.url));
  const recent = sessions.filter(s => {
    if (!["released", "error"].includes(s.status) || seen.has(s.url)) return false;
    seen.add(s.url); return true;
  }).slice(0, 8);
  const current = sessions.find((s) => s.id === id);
  if (opening) return <LoadingBrowserFrame url={current?.url || address} />;
  if (!id)
    return (
      <div data-browser-shell className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
        <form aria-label="Browser navigation" className="flex h-12 shrink-0 items-center gap-2 border-b px-4 py-2" onSubmit={(event) => { event.preventDefault(); void openAddress(); }}>
          <div role="group" aria-label="Navigation" className="flex shrink-0 items-center gap-1">
          <BrowserActionTooltip label="Back"><Button type="button" variant="ghost" size="icon-xs" aria-label="Back" disabled><BrowseIcon name="ArrowLeft" className="size-4" /></Button></BrowserActionTooltip>
          <BrowserActionTooltip label="Forward"><Button type="button" variant="ghost" size="icon-xs" aria-label="Forward" disabled><BrowseIcon name="ArrowRight" className="size-4" /></Button></BrowserActionTooltip>
          <BrowserActionTooltip label="Refresh sessions"><Button type="button" variant="ghost" size="icon-xs" aria-label="Refresh sessions" onClick={() => void sync()}><BrowseIcon name="RefreshCw" className="size-4" /></Button></BrowserActionTooltip>
          </div>
          <div role="group" aria-label="Address" className="flex min-w-0 flex-1 items-center gap-1">
          <Input
            aria-label="Website address"
            className="h-7 min-w-0 flex-1 text-xs focus-visible:ring-0"
            disabled={opening}
            placeholder="Enter URL"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
          </div>
        </form>
        <div className="min-h-0 flex-1 overflow-auto flex flex-col">
          <div className="m-auto w-full max-w-3xl px-6 py-12">
            {error && <p role="alert" className="mb-4 text-sm">{error}</p>}
            {!sessionsLoaded && <BrowserListSkeleton label="Loading browser sessions" />}
            {[{ title: "Recently visited", items: recent }, { title: "Open sessions", items: active }].filter(group => group.items.length > 0).map(group => (
              <section key={group.title} className="mb-6" aria-label={group.title}>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">{group.title}</h2>
            <ul className="space-y-1">
              {group.items.map((s) => (
                <li key={s.id}>
                  <button type="button" disabled={opening} className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={async () => {
                    if (launching.current) return;
                    launching.current = true;
                    setOpening(true);
                    setAddress(s.url);
                    setError("");
                    try {
                      await rpc.call("open-address", { threadId, url: s.url, sessionId: s.id, paramsJson: JSON.stringify(params ?? {}) });
                    } catch (e) { setError(String(e)); setOpening(false); }
                    finally { launching.current = false; }
                  }}>
                    <BrowseIcon name="Globe" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{browserTitle(s)}</span><span className="block truncate text-xs text-muted-foreground">{s.url}</span></span>
                  </button>
                </li>
              ))}
            </ul>
              </section>
            ))}
            {!localLoaded && <BrowserListSkeleton label="Loading local servers" />}
            {localLoaded && local.servers.length > 0 && <section aria-label="Local servers">
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">Local servers</h2>
              <ul className="space-y-1">{local.servers.map(server => <li key={server.port}>
                <button type="button" disabled={opening} className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left hover:bg-accent" onClick={() => void openAddress(server.url)}>
                  <BrowseIcon name="Terminal" className="size-4 shrink-0 text-muted-foreground" />
                  <span><span className="block text-sm font-medium">{server.name}</span><span className="block text-xs text-muted-foreground">localhost:{server.port}</span></span>
                </button>
              </li>)}</ul>
            </section>}
          </div>
        </div>
      </div>
    );
  const unavailable =
    !!id && sessionsLoaded && (!current || ["error", "released"].includes(current.status));
  const reopenUrl = current?.url || rememberedUrl;
  if (unavailable)
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center overflow-auto bg-sidebar p-6 text-center text-sidebar-foreground">
        <BrowseIcon name="Globe" className="mb-3 size-6 text-muted-foreground" />
        <h2 className="text-sm font-medium">{current?.status === "error" ? "Browser disconnected" : "Browser closed"}</h2>
        {reopenUrl && <Button
            className="mt-4"
            variant="outline"
            size="sm"
            disabled={opening}
            onClick={async () => {
              if (launching.current) return;
              launching.current = true;
              setOpening(true);
              setError("");
              try {
                await rpc.call("open-address", {
                  threadId,
                  url: reopenUrl,
                  ...(current ? { sessionId: id } : {}),
                  paramsJson: JSON.stringify(params ?? {}),
                });
              } catch (e) {
                setError(String(e));
                setOpening(false);
              } finally {
                launching.current = false;
              }
            }}
          >
            Reopen page
          </Button>}
        {error && <p role="alert" className="mt-3 max-w-sm break-words text-xs text-muted-foreground">{error}</p>}
      </div>
    );
  return (
    <div data-browse-session={id} className="relative flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      {loadedViewerId !== id && <div className="absolute inset-0 z-10"><LoadingBrowserFrame url={current?.url || address} /></div>}
      {error && <p role="alert" className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{error}</p>}
      <iframe
        title="Live browser"
        className="min-h-0 w-full flex-1 border-0 bg-sidebar"
        style={{ opacity: loadedViewerId === id ? 1 : 0 }}
        onLoad={() => setLoadedViewerId(id)}
        src={`/api/v1/plugins/browse/http/viewer?id=${encodeURIComponent(id)}`}
      />
    </div>
  );
}

function browserTitle(s: Pick<Session, "url">) {
  let title = "Browser";
  try {
    title = new URL(s.url).hostname || title;
  } catch {}
  return title;
}
function AutoShowBrowsers({ threadId }: { threadId: string }) {
  const { threadId: selectedThreadId } = useBbContext();
  const nav = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [linkState, setLinkState] = useState<{
    url: string;
    error?: string;
  } | null>(null);
  const pendingLinks = useRef(new Set<string>());
  const opened = useRef(new Set<string>());
  const activeThread = useRef(threadId);
  activeThread.current = threadId;
  const openLink = useCallback(
    async (url: string) => {
      if (!threadId) return;
      const key = `${threadId}:${url}`;
      if (pendingLinks.current.has(key)) return;
      pendingLinks.current.add(key);
      setLinkState({ url });
      try {
        const target = new URL(url, window.location.href);
        const viewerId = target.origin === window.location.origin && target.pathname === "/api/v1/plugins/browse/http/viewer" ? target.searchParams.get("id") ?? undefined : undefined;
        const visible = [...document.querySelectorAll<HTMLElement>("[data-browse-session]")].find(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
        const result = await rpc.call("open-link", { threadId, url, ...(viewerId ? { viewerId } : {}), ...(visible?.dataset.browseSession ? { currentId: visible.dataset.browseSession } : {}) });
        if (activeThread.current !== threadId) return;
        if (
          !result.reused && !nav.openThreadPanel({
            actionId: "live",
            params: { id: result.session.id, url: result.session.url },
            title: browserTitle(result.session),
          })
        ) {
          throw new Error(
            "Browser started. Open Browser from the new-tab menu to view this session.",
          );
        }
        opened.current.add(result.session.id);
        setLinkState((state) => (state?.url === url ? null : state));
      } catch (error) {
        if (activeThread.current === threadId)
          setLinkState({ url, error: String(error) });
      } finally {
        pendingLinks.current.delete(key);
      }
    },
    [threadId, rpc, nav],
  );
  useEffect(() => {
    setLinkState(null);
    if (!threadId || selectedThreadId !== threadId) return;
    const routeLauncher = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      nav.openThreadPanel({ actionId: "live", params: {}, title: "Browser" });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("#file-search-result-open-browser") ||
          (event.key === "Enter" && target?.getAttribute("aria-activedescendant") === "file-search-result-open-browser"))
        routeLauncher(event);
    };
    const click = (event: MouseEvent) => {
      if (event.composedPath().some(node => node instanceof Element && node.id === "file-search-result-open-browser")) {
        routeLauncher(event);
        return;
      }
      const modified = event.metaKey || event.ctrlKey;
      const url = browseLink(event, window.location, modified);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      if (modified) {
        try { void Promise.resolve(openClientExternal(url)).catch(error => setLinkState({url, error: String(error)})); }
        catch(error) { setLinkState({url, error: String(error)}); }
      } else void openLink(url);
    };
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [threadId, selectedThreadId, openLink, nav]);
  const sync = useCallback(
    async (revealId?: string) => {
      if (!threadId) return;
      try {
        const sessions = await rpc.call("list", { threadId, onlyUnshown: true });
        if (activeThread.current !== threadId) return;
        // Oldest first leaves the newly opened page selected. Routine refreshes
        // never steal focus from another session or reopen a user-closed tab.
        for (const s of [...sessions].reverse()) {
          if (
            revealId
              ? s.id !== revealId
              : !["ready", "connecting"].includes(s.status) ||
                opened.current.has(s.id)
          )
            continue;
          if (
            nav.openThreadPanel({
              actionId: "live",
              params: { id: s.id, url: s.url },
              title: browserTitle(s),
            })
          )
            opened.current.add(s.id);
        }
      } catch {
        /* Keep manual Browser launcher available after an RPC failure. */
      }
    },
    [nav, rpc, threadId],
  );
  useRealtime("browser-changed", () => {
    void sync();
  });
  useRealtime("browser-reveal", (payload) => {
    if (!payload || typeof payload !== "object") return;
    const event = payload as { threadId?: string; id?: string };
    if (event.threadId === threadId && event.id) void sync(event.id);
  });
  useEffect(() => {
    void sync();
  }, [sync]);
  return linkState ? (
    <div
      role={linkState.error ? "alert" : "status"}
      className="fixed bottom-4 right-4 z-50 max-w-md rounded-md border bg-background p-3 text-sm shadow-lg"
    >
      <p>{linkState.error || "Opening in Browser…"}</p>
      {linkState.error && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void openLink(linkState.url)}
        >
          Retry
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => setLinkState(null)}>
        Dismiss
      </Button>
    </div>
  ) : null;
}
