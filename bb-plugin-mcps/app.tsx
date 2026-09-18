import { readRpc } from "./lib/read-rpc";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { crumbsForRoute, detailPath, parseRoute, publishDetailLabel, subscribeDetailLabel, type Tab } from "@/lib/route";
import { usePortalScopeProps } from "@/lib/portal-scope";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type ServerRow = {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  sourceKind: string;
  approved: boolean;
  enabled: boolean;
  authStatus: string;
  lastError: string | null;
  sourceRef: string | null;
  registryName: string | null;
  registryVersion: string | null;
  configJson: string;
  toolCount: number | null;
};

type RegistryHit = {
  name: string;
  description: string;
  version: string;
  status: string;
  installable: boolean;
  sourceRef: string | null;
  type: string | null;
  remote: boolean;
  requiredHeaders: string[];
};

type CompactTool = {
  opaqueId: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  risk: "read" | "write" | "destructive";
  enabled: boolean;
  card?: {
    shape: string;
    fields: Array<{ name: string; type: string; required: boolean; enum?: string[] }>;
    example: Record<string, unknown>;
  };
};

type AddKind = "url" | "command" | null;
type TypeFilter = "http" | "sse" | "stdio";
type StatusFilter = "enabled" | "disabled";
type AuthFilter = "authenticated" | "needs-auth";
type ReadyFilter = "installable" | "needs-headers" | "unsupported";

const TYPE_FILTERS: Array<[TypeFilter, string]> = [
  ["http", "HTTP"],
  ["sse", "SSE"],
  ["stdio", "Command"],
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRowAction(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-row-action]"));
}

function typeLabel(type: string): string {
  if (type === "stdio") return "Command";
  if (type === "sse") return "SSE";
  return "HTTP";
}

function typeIcon(type: string): "Terminal" | "Globe" {
  return type === "stdio" ? "Terminal" : "Globe";
}

function stdioConfig(configJson: string): { command: string; args: string[]; cwd: string | null } | null {
  try {
    const cfg = JSON.parse(configJson) as { type?: unknown; command?: unknown; args?: unknown; cwd?: unknown };
    if (cfg.type !== "stdio" || typeof cfg.command !== "string" || cfg.command.length === 0) return null;
    const args = Array.isArray(cfg.args) ? cfg.args.filter((item): item is string => typeof item === "string") : [];
    const cwd = typeof cfg.cwd === "string" && cfg.cwd !== "" && cfg.cwd !== "${PLUGIN_DATA}" ? cfg.cwd : null;
    return { command: cfg.command, args, cwd };
  } catch {
    return null;
  }
}

function toggleFilter<T extends string>(values: T[], id: T, onChange: (next: T[]) => void) {
  onChange(values.includes(id) ? values.filter((item) => item !== id) : [...values, id]);
}

function hitType(hit: RegistryHit): TypeFilter | null {
  if (hit.type === "stdio") return "stdio";
  if (hit.type === "sse") return "sse";
  if (hit.type === "streamable-http" || hit.remote) return "http";
  return null;
}

function hitReady(hit: RegistryHit): ReadyFilter {
  if (!hit.installable) return "unsupported";
  if (hit.requiredHeaders.length > 0) return "needs-headers";
  return "installable";
}

const FilterButton = forwardRef<
  HTMLButtonElement,
  { active: boolean; label: string } & ButtonHTMLAttributes<HTMLButtonElement>
>(function FilterButton({ active, label, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="icon"
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "size-8 shrink-0 rounded-md p-0 text-muted-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground data-[state=open]:hover:bg-state-active",
        active && "bg-state-active text-foreground hover:bg-state-active",
        className,
      )}
      {...props}
    >
      <Icon name="SlidersHorizontal" className="size-4" />
    </Button>
  );
});

function serverHaystack(server: ServerRow): string {
  return [server.name, server.description, server.type, server.sourceRef, server.registryName, server.authStatus].join(" ").toLowerCase();
}

const CRUMB_LINK =
  "-mx-2 inline-flex min-h-7 shrink-0 cursor-pointer items-center rounded-md px-2 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [app-region:no-drag] [-webkit-app-region:no-drag]";

type HeaderRow = { name: string; value: string };

function emptyHeader(): HeaderRow {
  return { name: "", value: "" };
}

function headersFromRows(rows: HeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name || !value) continue;
    headers[name] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
function HeaderCrumbs({ subPath }: { subPath: string }) {
  const nav = useBbNavigate();
  const scope = usePortalScopeProps();
  const route = parseRoute(subPath);
  const [name, setName] = useState<string | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => subscribeDetailLabel(setName), []);

  const pluginAttr = scope["data-bb-plugin"];
  const rootAttr = scope["data-bb-plugin-root"];

  useLayoutEffect(() => {
    const row = document.querySelector("[data-testid='app-page-header-content-row']");
    const inner = row?.firstElementChild?.firstElementChild;
    if (!(inner instanceof HTMLElement)) return;
    const mount = document.createElement("div");
    mount.dataset.mcpsHeaderCrumbs = "";
    if (rootAttr !== undefined) mount.setAttribute("data-bb-plugin-root", "");
    if (pluginAttr !== undefined) mount.setAttribute("data-bb-plugin", pluginAttr);
    mount.className = "min-w-0 max-w-full";
    const hidden: HTMLElement[] = [];
    for (const child of Array.from(inner.children)) {
      if (child instanceof HTMLElement) {
        child.hidden = true;
        hidden.push(child);
      }
    }
    inner.append(mount);
    setHost(mount);
    return () => {
      mount.remove();
      for (const child of hidden) child.hidden = false;
      setHost(null);
    };
  }, [pluginAttr, rootAttr]);

  const crumbs = crumbsForRoute(route, name);
  if (host === null) return null;
  return createPortal(
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {index > 0 ? <Icon name="ChevronRight" className="size-3.5 shrink-0 text-subtle-foreground" /> : null}
              {!last && crumb.subPath !== undefined ? (
                <button
                  type="button"
                  className={CRUMB_LINK}
                  onClick={() => nav.toPluginPanel("mcps", { subPath: crumb.subPath })}
                >
                  {crumb.label}
                </button>
              ) : (
                <span aria-current={last ? "page" : undefined} className={last ? "min-w-0 truncate" : "shrink-0 text-muted-foreground"}>
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>,
    host,
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm">{label}</span>
      {children}
    </label>
  );
}

function HeaderFields({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  const update = (index: number, patch: Partial<HeaderRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <div className="space-y-1.5">
      <span className="block text-sm">Headers</span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={row.name}
            onChange={(event) => update(index, { name: event.target.value })}
            placeholder="Name"
            aria-label={`Header ${index + 1} name`}
            className="min-w-0 flex-1"
          />
          <Input
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
            placeholder="Value"
            aria-label={`Header ${index + 1} value`}
            className="min-w-0 flex-[1.4]"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label={`Remove header ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Icon name="X" className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 w-full justify-start text-muted-foreground"
        onClick={() => onChange([...rows, emptyHeader()])}
      >
        <Icon name="Plus" className="size-4" />
        Add header
      </Button>
    </div>
  );
}

function CheckRow({
  id,
  checked,
  onCheckedChange,
  children,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <label htmlFor={id} className="text-sm leading-none">{children}</label>
    </div>
  );
}

function PageShell({ fill, children }: { fill?: boolean; children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto box-border min-h-full w-full max-w-5xl px-4 pb-4 pt-3 md:px-5 md:pt-4", fill && "h-full")}>
        {children}
      </div>
    </div>
  );
}

function CollectionChrome({
  tab,
  installedCount,
  onTabChange,
  actions,
  children,
}: {
  tab: Tab;
  installedCount: number | undefined;
  onTabChange: (tab: Tab) => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "installed", label: "Installed", count: installedCount },
    { id: "browse", label: "Browse" },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <p className="pr-3 text-sm leading-5 text-muted-foreground">
        Install MCP servers from the official registry, a URL, or a local command. Every provider uses the same catalog.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2 pr-3">
        <div className="flex items-center gap-1" role="tablist" aria-label="MCP views">
          {tabs.map((item) => {
            const selected = item.id === tab;
            return (
              <button
                key={item.id}
                id={`mcps-${item.id}-tab`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`mcps-${item.id}-panel`}
                tabIndex={selected ? 0 : -1}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium",
                  selected ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onTabChange(item.id)}
              >
                {item.label}
                {item.count !== undefined ? <span className="text-xs text-muted-foreground">{item.count}</span> : null}
              </button>
            );
          })}
        </div>
        {actions}
      </div>
      <div id={`mcps-${tab}-panel`} role="tabpanel" aria-labelledby={`mcps-${tab}-tab`} className="min-h-0 flex-1">
        {children}
      </div>
    </div>
  );
}

function MenuRow({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <>
      <Icon name={icon} className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
}

function NewMcpButton({ onPick }: { onPick: (kind: "url" | "command") => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm">
          <Icon name="Plus" className="size-4" />
          New MCP
          <Icon name="ChevronDown" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max min-w-40">
        <DropdownMenuItem onSelect={() => onPick("url")}>
          <MenuRow icon="Globe">From URL</MenuRow>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick("command")}>
          <MenuRow icon="Terminal">From command</MenuRow>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RemoveDialog({
  name,
  pending,
  onOpenChange,
  onConfirm,
}: {
  name: string | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={name !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove MCP?</AlertDialogTitle>
          <AlertDialogDescription>
            “{name}” will be removed from BB. You can add it again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={pending}
            onClick={onConfirm}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AddFormDialog({
  kind,
  pending,
  onOpenChange,
  onSubmitUrl,
  onSubmitCommand,
}: {
  kind: AddKind;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitUrl: (input: { name: string; url: string; headers?: Record<string, string>; sse: boolean }) => void;
  onSubmitCommand: (input: { name: string; command: string; args: string[] }) => void;
}) {
  const [httpName, setHttpName] = useState("");
  const [httpUrl, setHttpUrl] = useState("");
  const [httpHeaders, setHttpHeaders] = useState<HeaderRow[]>([]);
  const [httpSse, setHttpSse] = useState(false);
  const [commandName, setCommandName] = useState("");
  const [commandLine, setCommandLine] = useState("");

  useEffect(() => {
    setHttpName("");
    setHttpUrl("");
    setHttpHeaders([]);
    setHttpSse(false);
    setCommandName("");
    setCommandLine("");
  }, [kind]);

  return (
    <Dialog open={kind !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {kind === "url" ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const name = httpName.trim();
              const url = httpUrl.trim();
              if (!name || !url) return;
              onSubmitUrl({
                name,
                url,
                headers: headersFromRows(httpHeaders),
                sse: httpSse || url.includes("/sse"),
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Add from URL</DialogTitle>
              <DialogDescription>Connect a cloud HTTP or SSE MCP server.</DialogDescription>
            </DialogHeader>
            <Field label="Name">
              <Input value={httpName} onChange={(event) => setHttpName(event.target.value)} required autoFocus />
            </Field>
            <Field label="URL">
              <Input value={httpUrl} onChange={(event) => setHttpUrl(event.target.value)} placeholder="https://example.com/mcp" required />
            </Field>
            <HeaderFields rows={httpHeaders} onChange={setHttpHeaders} />
            <CheckRow id="http-sse" checked={httpSse} onCheckedChange={setHttpSse}>Use SSE instead of streamable HTTP</CheckRow>
            <DialogFooter>
              <Button type="submit" disabled={pending || httpName.trim() === "" || httpUrl.trim() === ""}>Add MCP</Button>
            </DialogFooter>
          </form>
        ) : kind === "command" ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const name = commandName.trim();
              if (!name || !commandLine.trim()) return;
              const [command, ...args] = commandLine.trim().split(/\s+/);
              onSubmitCommand({ name, command, args });
            }}
          >
            <DialogHeader>
              <DialogTitle>Add from command</DialogTitle>
              <DialogDescription>Run a local stdio MCP on this BB host.</DialogDescription>
            </DialogHeader>
            <Field label="Name">
              <Input value={commandName} onChange={(event) => setCommandName(event.target.value)} required autoFocus />
            </Field>
            <Field label="Command">
              <Input value={commandLine} onChange={(event) => setCommandLine(event.target.value)} placeholder="npx -y package" required />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={pending || commandName.trim() === "" || commandLine.trim() === ""}>Add MCP</Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Pagination({ page, total, onPage, label }: { page: number; total: number; onPage: (page: number) => void; label: string }) {
  if (total <= 50) return null;
  return <div className="flex items-center justify-between gap-3">
    <Button size="sm" variant="outline" aria-label={`Previous ${label}`} disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</Button>
    <span className="text-xs text-muted-foreground">{page * 50 + 1}–{Math.min((page + 1) * 50, total)} of {total}</span>
    <Button size="sm" variant="outline" aria-label={`Next ${label}`} disabled={(page + 1) * 50 >= total} onClick={() => onPage(page + 1)}>Next</Button>
  </div>;
}

function useServers() {
  const rpc = useRpc<typeof rpcContract>();
  const [servers, setServers] = useState<ServerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const refetch = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    readRpc("snapshot", null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setServers(result.servers);
      setError(null);
    }, (cause) => { if (!controller.signal.aborted) setError(errorText(cause)); });
  }, []);
  useEffect(() => { refetch(); return () => request.current?.abort(); }, [refetch]);
  useRealtime("mcps-changed", refetch);
  return { rpc, servers, error, setError, refetch };
}

function InstalledList({
  servers,
  pending,
  onOpen,
  onEnabledChange,
}: {
  servers: ServerRow[] | null;
  pending: string | null;
  onOpen: (id: string) => void;
  onEnabledChange: (id: string, enabled: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<TypeFilter[]>([]);
  const [statuses, setStatuses] = useState<StatusFilter[]>([]);
  const [auths, setAuths] = useState<AuthFilter[]>([]);

  const filtered = useMemo(() => {
    if (!servers) return null;
    const q = query.trim().toLowerCase();
    return servers.filter((server) => {
      if (q && !serverHaystack(server).includes(q)) return false;
      if (types.length > 0) {
        const kind: TypeFilter = server.type === "stdio" ? "stdio" : server.type === "sse" ? "sse" : "http";
        if (!types.includes(kind)) return false;
      }
      if (statuses.length > 0) {
        const status: StatusFilter = server.enabled ? "enabled" : "disabled";
        if (!statuses.includes(status)) return false;
      }
      if (auths.length > 0 && server.authStatus !== "not-applicable") {
        const auth: AuthFilter = server.authStatus === "authenticated" ? "authenticated" : "needs-auth";
        if (!auths.includes(auth)) return false;
      }
      return true;
    });
  }, [servers, query, types, statuses, auths]);

  const [requestedPage, setPage] = useState(0);
  useEffect(() => setPage(0), [query, types, statuses, auths]);
  const page = Math.min(requestedPage, Math.max(0, Math.ceil((filtered?.length ?? 0) / 50) - 1));
  const filtersActive = types.length + statuses.length + auths.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 pr-3">
        <div className="relative w-full min-w-0 sm:w-auto sm:flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search MCPs"
            aria-label="Search MCPs"
            className="h-8 pl-8"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterButton active={filtersActive} label={filtersActive ? "Filters on" : "Filters"} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max max-w-64">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Type</DropdownMenuLabel>
            {TYPE_FILTERS.map(([id, label]) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={types.includes(id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggleFilter(types, id, setTypes)}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Status</DropdownMenuLabel>
            {([
              ["enabled", "Enabled"],
              ["disabled", "Disabled"],
            ] as const).map(([id, label]) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={statuses.includes(id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggleFilter(statuses, id, setStatuses)}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Auth</DropdownMenuLabel>
            {([
              ["authenticated", "Authenticated"],
              ["needs-auth", "Needs auth"],
            ] as const).map(([id, label]) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={auths.includes(id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggleFilter(auths, id, setAuths)}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {servers === null ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card px-4 py-3.5" role="status" aria-label="Loading MCP servers">
          <div className="divide-y divide-border">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0" aria-hidden="true">
                <Skeleton className="size-6 rounded-md" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : filtered && filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {servers.length === 0 ? "No MCP servers yet. Browse the registry or add a URL or command." : "No MCPs match these filters."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card px-4 py-3.5">
          <ul className="divide-y divide-border">
            {filtered?.slice(page * 50, (page + 1) * 50).map((server) => (
              <li
                key={server.id}
                className={cn(
                  "group grid cursor-pointer grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-left first:pt-0 last:pb-0",
                  !server.enabled && "opacity-60",
                )}
                onClick={(event) => { if (!isRowAction(event.target)) onOpen(server.id); }}
              >
                <span className="flex size-6 shrink-0 items-center justify-center">
                  <Icon name={typeIcon(server.type)} className="size-4 text-muted-foreground" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{server.name}</span>
                  <span className="mt-0.5 block truncate text-xs leading-snug text-muted-foreground">
                    {typeLabel(server.type)}
                    {server.enabled ? "" : " · disabled"}
                    {server.authStatus !== "not-applicable" ? ` · ${server.authStatus}` : ""}
                    {server.toolCount !== null ? ` · ${server.toolCount} tools` : ""}
                    {server.lastError ? ` · ${server.lastError}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span data-row-action="" className="flex items-center" onClick={(event) => event.stopPropagation()}>
                    <Switch
                      checked={server.enabled}
                      disabled={pending !== null}
                      aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                      onCheckedChange={(enabled) => onEnabledChange(server.id, enabled)}
                    />
                  </span>
                  <Icon name="ChevronRight" className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </span>
              </li>
            ))}
          </ul>
          <Pagination page={page} total={filtered?.length ?? 0} onPage={setPage} label="servers" />
        </div>
      )}
    </div>
  );
}

function BrowsePane({
  pending,
  onAdd,
}: {
  pending: boolean;
  onAdd: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RegistryHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [types, setTypes] = useState<TypeFilter[]>([]);
  const [readies, setReadies] = useState<ReadyFilter[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const next = query.trim();
    setHits(null);
    if (next.length < 2) {
      setHits(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      setSearchError(null);
      readRpc("registrySearch", { query: next, ...(cursor ? {cursor} : {}) }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setHits(result.servers);
        setNextCursor(result.nextCursor);
        setSearching(false);
      }, (cause) => {
        if (controller.signal.aborted) return;
        setSearchError(errorText(cause));
        setHits([]);
        setSearching(false);
      });
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, cursor]);

  const filtered = useMemo(() => {
    if (hits === null) return null;
    return hits.filter((hit) => {
      if (types.length > 0) {
        const kind = hitType(hit);
        if (kind === null || !types.includes(kind)) return false;
      }
      if (readies.length > 0 && !readies.includes(hitReady(hit))) return false;
      return true;
    });
  }, [hits, types, readies]);

  const filtersActive = types.length + readies.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 pr-3">
        <div className="relative w-full min-w-0 sm:w-auto sm:flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setCursors([]); setNextCursor(null); }}
            placeholder="Search the MCP Registry"
            aria-label="Search the MCP Registry"
            className="h-8 pl-8"
            autoFocus
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterButton active={filtersActive} label={filtersActive ? "Filters on" : "Filters"} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-max max-w-64">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Type</DropdownMenuLabel>
            {TYPE_FILTERS.map(([id, label]) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={types.includes(id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggleFilter(types, id, setTypes)}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Ready</DropdownMenuLabel>
            {([
              ["installable", "Installable"],
              ["needs-headers", "Needs headers"],
              ["unsupported", "Unsupported"],
            ] as const).map(([id, label]) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={readies.includes(id)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggleFilter(readies, id, setReadies)}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {searching ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,23rem),1fr))] gap-2.5 pr-3">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="min-h-28 rounded-lg border border-border p-3" aria-hidden="true">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-3/4" />
            </div>
          ))}
        </div>
      ) : searchError ? (
        <p role="alert" className="px-3 py-8 text-center text-sm text-destructive">{searchError}</p>
      ) : hits === null ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          Search the official registry to add a server.
        </p>
      ) : filtered && filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          {hits.length === 0 ? "No registry matches." : "No MCPs match these filters."}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,23rem),1fr))] gap-2.5 pr-3">
          {filtered?.map((hit) => (
            <div key={hit.name} className="flex min-h-28 flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-medium">{hit.name}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0"
                  disabled={!hit.installable || pending}
                  onClick={() => onAdd(hit.name)}
                >
                  Add
                </Button>
              </div>
              <p className="line-clamp-3 text-xs leading-snug text-muted-foreground">
                {hit.remote ? "HTTP" : hit.type ?? "unsupported"}
                {hit.requiredHeaders.length > 0 ? ` · needs ${hit.requiredHeaders.join(", ")}` : ""}
                {hit.description ? ` · ${hit.description}` : ""}
              </p>
            </div>
          ))}
        </div>
      )}
      {!searching && !searchError && (cursors.length > 0 || nextCursor) ? <div className="flex justify-between gap-3">
        <Button size="sm" variant="outline" disabled={cursors.length === 0} onClick={() => setCursors(p => p.slice(0, -1))}>Previous matches</Button>
        <Button size="sm" variant="outline" disabled={!nextCursor || nextCursor === cursor} onClick={() => { if (nextCursor) setCursors(p => [...p, nextCursor]); }}>Next matches</Button>
      </div> : null}
    </div>
  );
}

function DetailPage({
  id,
  servers,
  pending,
  onBack,
  onEnabledChange,
  onRemove,
  onAuth,
}: {
  id: string;
  servers: ServerRow[] | null;
  pending: string | null;
  onBack: () => void;
  onEnabledChange: (id: string, enabled: boolean) => void;
  onRemove: (server: ServerRow) => void;
  onAuth: (id: string) => void;
}) {
  const server = servers?.find((item) => (item.id === id || item.handle === id)) ?? null;
  const [tools, setTools] = useState<CompactTool[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [toolPage, setToolPage] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setTools(null);
    setToolPage(0);
    setCatalogError(null);
    readRpc("inspectServer", { id }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setTools(result.tools);
      setCatalogError(result.error);
    }, (cause) => {
      if (controller.signal.aborted) return;
      setTools([]);
      setCatalogError(errorText(cause));
    });
    return () => controller.abort();
  }, [id, server?.status, server?.authStatus, server?.enabled]);

  if (servers !== null && server === null) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">That MCP is gone.</p>
        <Button type="button" variant="outline" size="sm" onClick={onBack}>Back to Installed</Button>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const local = stdioConfig(server.configJson);
  const localRows = local ? [
    { label: "Command", value: local.command },
    ...(local.args.length > 0 ? [{ label: "Arguments", value: local.args.join(" ") }] : []),
    ...(local.cwd ? [{ label: "Working directory", value: local.cwd }] : []),
  ] : [];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Icon name={typeIcon(server.type)} className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </span>
            <h1 className="min-w-0 truncate text-base font-semibold">{server.name}</h1>
          </div>
          <div className="text-xs text-subtle-foreground">
            <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="inline-flex h-4 min-w-0 items-center gap-1.5 whitespace-nowrap leading-4">
                <Icon name="Code" className="size-3.5 shrink-0" aria-label="Handle" />
                <span className="min-w-0 truncate" title={server.id}>{server.handle}</span>
              </span>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span aria-hidden="true">·</span>
                <span className="inline-flex h-4 min-w-0 items-center gap-1.5 whitespace-nowrap leading-4">
                  <Icon name={typeIcon(server.type)} className="size-3.5 shrink-0" aria-label="Connection type" />
                  <span>{server.type === "stdio" ? "Local (stdio)" : typeLabel(server.type)}</span>
                </span>
              </span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <Switch
            checked={server.enabled}
            disabled={pending !== null}
            aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
            onCheckedChange={(enabled) => onEnabledChange(server.id, enabled)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 p-0 text-muted-foreground hover:text-foreground"
                aria-label={`${server.name} actions`}
              >
                <Icon name="MoreHorizontal" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-max min-w-32 max-w-72">
              {server.type === "stdio" ? null : (
                <DropdownMenuItem disabled={pending !== null} onSelect={() => onAuth(server.id)}>
                  <MenuRow icon="Lock">{server.authStatus === "authenticated" ? "Re-authenticate" : "Authenticate"}</MenuRow>
                </DropdownMenuItem>
              )}
              {server.type === "stdio" ? null : <DropdownMenuSeparator />}
              <DropdownMenuItem variant="destructive" disabled={pending !== null} onSelect={() => onRemove(server)}>
                <MenuRow icon="Trash2">Remove</MenuRow>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {server.lastError ? <p role="alert" className="text-sm text-destructive">{server.lastError}</p> : null}
      {localRows.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-foreground">Settings</h2>
          <div className="overflow-hidden rounded-lg border border-border bg-card px-4 py-3.5">
            <dl className="divide-y divide-border">
              {localRows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                  <dt className="shrink-0 text-sm">{row.label}</dt>
                  <dd className="min-w-0 truncate text-right text-sm text-muted-foreground" title={row.value}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      ) : null}
      <section data-resource-detail-section="definition" className="space-y-3">
        <div className="flex min-h-6 items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Tools</h2>
        </div>
        {tools === null ? (
          <div className="overflow-hidden rounded-lg border border-border bg-card px-4 py-3.5" role="status" aria-label="Loading tools">
            <div className="divide-y divide-border">
              {[0, 1, 2].map((row) => (
                <div key={row} className="space-y-2 py-2.5 first:pt-0 last:pb-0" aria-hidden="true">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          </div>
        ) : tools.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {catalogError ?? (server.authStatus === "unauthenticated" || server.authStatus === "authorizing"
              ? "Authenticate to load tools."
              : "No tools reported yet.")}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card px-4 py-3.5">
            <ul className="divide-y divide-border">
              {tools.slice(toolPage * 50, (toolPage + 1) * 50).map((tool) => (
                <li key={tool.opaqueId} className="py-2.5 first:pt-0 last:pb-0">
                  <p className="truncate text-sm font-medium">{tool.name}</p>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    {tool.risk}
                    {tool.description ? ` · ${tool.description}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Pagination page={toolPage} total={tools?.length ?? 0} onPage={setToolPage} label="tools" />
        {catalogError && tools && tools.length > 0 ? (
          <p role="alert" className="text-sm text-destructive">{catalogError}</p>
        ) : null}
      </section>
    </div>
  );
}

function McpsPage({ subPath }: { subPath: string }) {
  const nav = useBbNavigate();
  const { rpc, servers, error, setError, refetch } = useServers();
  const route = parseRoute(subPath);
  const [pending, setPending] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<AddKind>(null);
  const [removeTarget, setRemoveTarget] = useState<ServerRow | null>(null);

  const go = (next: string, replace = false) => {
    nav.toPluginPanel("mcps", { subPath: next, replace });
  };

  useEffect(() => {
    if (!route.detailId) {
      publishDetailLabel(null);
      return;
    }
    publishDetailLabel(servers?.find((server) => (server.id === route.detailId || server.handle === route.detailId))?.name ?? null);
  }, [route.detailId, servers]);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setPending(label);
    try {
      await work();
      refetch();
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      toast.error(message);
    } finally {
      setPending(null);
    }
  };

  const addThenOpen = async (work: () => Promise<{ id: string; name: string }>, oauth = false) => {
    setPending("add");
    const authWindow = oauth ? window.open("about:blank", "_blank") : null;
    try {
      const added = await work();
      toast.success("MCP added");
      setAddKind(null);
      refetch();
      go(detailPath(added.id));
      if (oauth) {
        const result = await rpc.call("authenticate", { id: added.id });
        if (result.url) {
          if (authWindow) authWindow.location.href = result.url;
          else window.open(result.url, "_blank", "noopener,noreferrer");
        } else {
          authWindow?.close();
        }
      }
    } catch (cause) {
      authWindow?.close();
      toast.error(`Failed to add MCP: ${errorText(cause)}`);
    } finally {
      setPending(null);
    }
  };

  const removeMcp = () => {
    const target = removeTarget;
    if (!target) return;
    void (async () => {
      setPending(`remove:${target.id}`);
      try {
        await rpc.call("remove", { id: target.id });
        toast.success("MCP deleted");
        setRemoveTarget(null);
        refetch();
        if (route.detailId) go("", true);
      } catch (cause) {
        toast.error(`Failed to delete MCP: ${errorText(cause)}`);
      } finally {
        setPending(null);
      }
    })();
  };

  const authenticate = (id: string) => {
    const authWindow = window.open("about:blank", "_blank");
    void run(`auth:${id}`, async () => {
      const result = await rpc.call("authenticate", { id });
      if (result.url) {
        if (authWindow) authWindow.location.href = result.url;
        else window.open(result.url, "_blank", "noopener,noreferrer");
      } else {
        authWindow?.close();
      }
    });
  };

  if (route.detailId) {
    return (
      <PageShell>
        {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
        <DetailPage
          key={route.detailId}
          id={route.detailId}
          servers={servers}
          pending={pending}
          onBack={() => go("")}
          onEnabledChange={(id, enabled) => void run(`enable:${id}`, () => rpc.call("setEnabled", { id, enabled }))}
          onRemove={setRemoveTarget}
          onAuth={authenticate}
        />
        <RemoveDialog
          name={removeTarget?.name ?? null}
          pending={pending !== null}
          onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
          onConfirm={removeMcp}
        />
      </PageShell>
    );
  }

  return (
    <PageShell fill>
      {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
      <CollectionChrome
        tab={route.tab}
        installedCount={servers?.length}
        onTabChange={(tab) => go(tab === "browse" ? "browse" : "")}
        actions={<NewMcpButton onPick={setAddKind} />}
      >
        {route.tab === "browse" ? (
          <BrowsePane pending={pending !== null} onAdd={(name) => void addThenOpen(() => rpc.call("addFromRegistry", { name }), true)} />
        ) : (
          <InstalledList
            servers={servers}
            pending={pending}
            onOpen={(id) => go(detailPath(id))}
            onEnabledChange={(id, enabled) => void run(`enable:${id}`, () => rpc.call("setEnabled", { id, enabled }))}
          />
        )}
      </CollectionChrome>
      <AddFormDialog
        kind={addKind}
        pending={pending !== null}
        onOpenChange={(open) => { if (!open) setAddKind(null); }}
        onSubmitUrl={(input) => void addThenOpen(() => rpc.call("addManual", {
          name: input.name,
          type: input.sse ? "sse" : "streamable-http",
          url: input.url,
          ...(input.headers ? { headers: input.headers } : {}),
        }), true)}
        onSubmitCommand={(input) => void addThenOpen(() => rpc.call("addManual", {
          name: input.name,
          type: "stdio",
          command: input.command,
          args: input.args,
        }))}
      />
      <RemoveDialog
        name={removeTarget?.name ?? null}
        pending={pending !== null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
          onConfirm={removeMcp}
      />
    </PageShell>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mcps",
    title: "MCPs",
    icon: "Layers",
    path: "mcps",
    component: McpsPage,
    headerContent: HeaderCrumbs,
  });
});
