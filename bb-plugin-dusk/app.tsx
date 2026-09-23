import { createPortal } from "react-dom";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useRealtime, useRpc, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { mountHomepage, getSlots, subscribeSlots, getConfig, subscribeConfig, setConfig } from "./lib/homepage";
import { prepareImage } from "./lib/wallpaper";
import { SidebarDetails } from "./lib/sidebar";
import { SNOOZE_EVENT, StatusThreadList, statusListMounted } from "./lib/status-list";
import "./app.css";

function useBackground() {
  const rpc = useRpc<typeof rpcContract>();
  const config = useSyncExternalStore(subscribeConfig, getConfig);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    const previous = getConfig();
    rpc.call("get").then((value) => {
      if (request === generation.current && getConfig() === previous) setConfig(value);
    }, () => {
      if (request !== generation.current) return;
      if (!getConfig()) setConfig({ image: null });
      toast.error("Could not load the background. Refresh to retry.");
    });
  }, [rpc]);
  useEffect(() => { refresh(); return () => { generation.current++; }; }, [refresh]);
  useRealtime("changed", refresh);
  return config;
}

function BackgroundMenu() {
  const config = useSyncExternalStore(subscribeConfig, getConfig);
  const rpc = useRpc<typeof rpcContract>();
  const input = useRef<HTMLInputElement>(null), pending = useRef(false), active = useRef(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function apply(file: File | null) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const image = file ? await prepareImage(file) : null;
      if (!active.current) return;
      const value = await rpc.call("save", { image });
      if (active.current) setConfig(value);
    } catch (error) {
      if (active.current) toast.error(error instanceof Error ? error.message : "Could not update the background.");
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <>
    <input ref={input} className="hidden" aria-label="Choose wallpaper image" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) void apply(file);
    }} />
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button className="dusk-background-edit" type="button" variant="ghost" size="icon" aria-label="Edit background" disabled={!config || busy}>
        <Icon name={busy ? "Loading" : "Edit"} className={busy ? "size-4 animate-spin" : "size-4"} aria-hidden />
      </Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6}>
        <DropdownMenuItem disabled={busy} onSelect={() => input.current?.click()}>{config?.image ? "Change image" : "Choose image"}</DropdownMenuItem>
        {config?.image && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => void apply(null)}>Remove image</DropdownMenuItem></>}
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
}

function HomepageController() {
  useBackground();
  const slots = useSyncExternalStore(subscribeSlots, getSlots);
  useEffect(() => () => setConfig(null), []);
  return <>{slots.map((slot, index) => createPortal(<BackgroundMenu />, slot, String(index)))}</>;
}

function SpinnerAsLoading({ className }: { className?: string }) {
  return <Icon name="Loading" className={className} aria-hidden />;
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "Spinner", component: SpinnerAsLoading });
  app.contentScripts.register({ id: "homepage", mount: ({ signal }) => mountHomepage(signal) });
  app.slots.experimental_appOverlay({ id: "background-controller", component: HomepageController });
  app.slots.experimental_appOverlay({ id: "sidebar-details", component: SidebarDetails });
  app.slots.experimental_threadList({
    id: "status",
    title: "Dusk (status)",
    description: "Pinned, Waiting, Ready, Working, Done, and Snoozed, with no project headings.",
    component: StatusThreadList,
  });
  app.commands.register({
    id: "snooze-thread",
    title: "Dusk: snooze thread…",
    isAvailable: ({ threadId }) => threadId !== null && statusListMounted > 0,
    run: ({ threadId }) => { if (threadId) window.dispatchEvent(new CustomEvent(SNOOZE_EVENT, { detail: threadId })); },
  });
});
