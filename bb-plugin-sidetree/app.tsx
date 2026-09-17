import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  definePluginApp,
  experimental_FileLink as FileLink,
  experimental_Icon as Icon,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useMediaQuery } from "./components/ui/hooks/use-media-query";
import {
  treeRows,
  visibleRange,
  pruneDirectories,
  type Directory,
} from "./tree-model";
import { Button } from "./components/ui/button";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "./components/ui/coarse-pointer-sizing";
import { Input } from "./components/ui/input";
import { Skeleton } from "./components/ui/skeleton";
import { FileGlyph, FolderGlyph } from "./file-icon";
import { FileOpener } from "./opener";
import { SourceRenderer } from "./source-renderer";
import { ScrollEdgeFades, useOverflowEdges } from "./scroll-fade";
import { cn } from "./lib/utils";
import type { Entry, Root, rpcContract } from "./server";
import { fileIconToken, OPENER_EXTENSIONS, defaultFolderToOpen } from "./tree";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/** Ghost row; one spacing token under the search field. */
const LINE = "flex w-full min-w-0 items-center";
const ITEM = cn(
  "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm font-normal text-foreground",
  "appearance-none cursor-pointer border-0 bg-transparent no-underline hover:no-underline hover:bg-state-hover",
  "focus-visible:bg-state-hover focus-visible:outline-none",
  "max-md:pointer-coarse:h-9",
);

function IndentGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <span
      className="flex h-7 shrink-0 self-stretch max-md:pointer-coarse:h-9"
      aria-hidden="true"
    >
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} className="relative w-3 self-stretch">
          <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
        </span>
      ))}
    </span>
  );
}

function TreeLine({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <div className={LINE}>
      <IndentGuides depth={depth} />
      {children}
    </div>
  );
}

function TreeSkeleton({ rows, depth = 0 }: { rows: number; depth?: number }) {
  return (
    <ul className="m-0 list-none p-0" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="min-w-0">
          <div className={cn(LINE, "pointer-events-none")}>
            <IndentGuides depth={depth} />
            <div className={cn(ITEM, "hover:bg-transparent")}>
              <Skeleton className="size-4 shrink-0 rounded-[3px]" />
              <Skeleton
                className="h-3 rounded-sm"
                style={{ width: `${42 + ((index * 17) % 36)}%` }}
              />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function StatusLine({
  depth = 0,
  tone = "muted",
  children,
}: {
  depth?: number;
  tone?: "muted" | "destructive";
  children: string;
}) {
  return (
    <p
      role={tone === "destructive" ? "alert" : undefined}
      className={cn(
        "flex h-7 items-center px-2 text-sm max-md:pointer-coarse:h-9",
        tone === "destructive" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <IndentGuides depth={depth} />
      {children}
    </p>
  );
}

function FileTree({
  rpc,
  threadId,
  environmentId,
  scroller,
}: {
  rpc: Rpc;
  threadId: string;
  environmentId: string;
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const [directories, setDirectories] = useState(new Map<string, Directory>());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [tick, setTick] = useState(0);
  const pending = useRef(new Set<string>());
  const autoOpened = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        list.current?.getClientRects().length
      )
        setTick((n) => n + 1);
    }, 10_000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [scroller]);

  const rows = useMemo(
    () => treeRows(directories, expanded),
    [directories, expanded],
  );
  useEffect(() => {
    // Load only reachable branches, with at most four directory requests in flight.
    const paths = [
      "",
      ...rows.flatMap((row) =>
        row.entry?.kind === "directory" && expanded.has(row.key)
          ? [row.key]
          : [],
      ),
    ];
    for (const path of paths) {
      if (pending.current.size >= 4) break;
      const cached = directories.get(path);
      if (
        pending.current.has(path) ||
        (cached && Date.now() - cached.checkedAt < 10_000)
      )
        continue;
      pending.current.add(path);
      void rpc
        .call("list_dir", { threadId, relativePath: path })
        .then((result) => {
          if (!mounted.current) return;
          setDirectories((current) => {
            const next = new Map(current);
            const previous = current.get(path);
            const equal =
              previous?.entries.length === result.entries.length &&
              result.entries.every((entry, i) => {
                const old = previous.entries[i];
                return (
                  old.relativePath === entry.relativePath &&
                  old.kind === entry.kind &&
                  old.name === entry.name
                );
              });
            next.delete(path);
            next.set(path, {
              entries: equal ? previous.entries : result.entries,
              checkedAt: Date.now(),
            });
            pruneDirectories(next, new Set(paths));
            return next;
          });
          if (path === "" && !autoOpened.current) {
            autoOpened.current = true;
            const folder = defaultFolderToOpen(result.entries);
            if (folder)
              setExpanded((current) =>
                current.has(folder) ? current : new Set([...current, folder]),
              );
          }
        })
        .catch((cause: unknown) => {
          if (!mounted.current) return;
          setDirectories((current) =>
            new Map(current).set(path, {
              entries: current.get(path)?.entries ?? [],
              checkedAt: Date.now(),
              error: cause instanceof Error ? cause.message : String(cause),
            }),
          );
        })
        .finally(() => {
          pending.current.delete(path);
          if (mounted.current) setTick((n) => n + 1);
        });
    }
  }, [directories, expanded, rows, rpc, threadId, tick]);

  useEffect(() => {
    setDirectories((current) => {
      const active = new Set([
        "",
        ...treeRows(current, expanded).flatMap((row) =>
          row.entry?.kind === "directory" && expanded.has(row.key)
            ? [row.key]
            : [],
        ),
      ]);
      const next = new Map(current);
      pruneDirectories(next, active);
      return next.size === current.size ? current : next;
    });
  }, [expanded]);

  const rowHeight = useMediaQuery("(max-width: 767px) and (pointer: coarse)")
    ? 36
    : 28;
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [focused, setFocused] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () =>
      setViewport((previous) => {
        const next = { top: el.scrollTop, height: el.clientHeight };
        return previous.top === next.top && previous.height === next.height
          ? previous
          : next;
      });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [scroller]);
  const range = visibleRange(
    rows.length,
    viewport.top,
    viewport.height,
    rowHeight,
  );
  const indices = Array.from(
    { length: range.end - range.start },
    (_, i) => range.start + i,
  );
  const focusedIndex =
    focused === null ? -1 : rows.findIndex((row) => row.key === focused);
  if (focusedIndex >= 0 && !indices.includes(focusedIndex))
    indices.push(focusedIndex);
  indices.sort((a, b) => a - b);
  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <ul
      ref={list}
      data-sidetree-tree=""
      className="relative m-0 list-none p-0"
      style={{ height: rows.length * rowHeight }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(null);
      }}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        const target = event.target as HTMLElement;
        const index = Number(
          target.closest("[data-row-index]")?.getAttribute("data-row-index"),
        );
        let next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : index + (event.key === "ArrowDown" ? 1 : -1);
        const direction =
          event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
        while (next >= 0 && next < rows.length && !rows[next].entry)
          next += direction;
        if (next < 0 || next >= rows.length) return;
        event.preventDefault();
        setFocused(rows[next].key);
        scroller.current?.scrollTo({
          top: Math.max(0, next * rowHeight - viewport.height / 2),
        });
        requestAnimationFrame(() =>
          list.current
            ?.querySelector<HTMLElement>(
              `[data-row-index="${next}"] :is(button,a)`,
            )
            ?.focus({ preventScroll: true }),
        );
      }}
    >
      {indices.map((index) => {
        const row = rows[index];
        const entry = row.entry;
        const open = expanded.has(row.key);
        return (
          <li
            key={row.key}
            data-row-index={index}
            className="absolute inset-x-0 min-w-0"
            style={{ top: index * rowHeight, height: rowHeight }}
            onFocus={() => setFocused(row.key)}
          >
            {entry ? (
              <TreeLine depth={row.depth}>
                {entry.kind === "directory" ? (
                  <button
                    type="button"
                    className={ITEM}
                    aria-expanded={open}
                    aria-label={entry.name}
                    onClick={() => toggle(row.key)}
                  >
                    <FolderGlyph open={open} />
                    <span className="min-w-0 truncate">{entry.name}</span>
                  </button>
                ) : (
                  <FileLink
                    target={{
                      kind: "workspace",
                      environmentId,
                      path: entry.relativePath,
                    }}
                    className={ITEM}
                  >
                    <FileGlyph token={fileIconToken(entry.relativePath)} />
                    <span className="min-w-0 truncate">{entry.name}</span>
                  </FileLink>
                )}
              </TreeLine>
            ) : row.status === "Loading" ? (
              <TreeSkeleton rows={1} depth={row.depth} />
            ) : (
              <StatusLine
                depth={row.depth}
                tone={row.error ? "destructive" : "muted"}
              >
                {row.status ?? ""}
              </StatusLine>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FilterHits({
  environmentId,
  entries,
}: {
  environmentId: string;
  entries: Entry[];
}) {
  if (entries.length === 0) {
    return <StatusLine>No matching files</StatusLine>;
  }
  return (
    <ul className="m-0 list-none p-0">
      {entries.map((entry) => (
        <li key={entry.relativePath} className="min-w-0">
          <FileLink
            target={{
              kind: "workspace",
              environmentId,
              path: entry.relativePath,
            }}
            className={ITEM}
            title={entry.relativePath}
          >
            {entry.kind === "directory" ? (
              <FolderGlyph open={false} />
            ) : (
              <FileGlyph token={fileIconToken(entry.relativePath)} />
            )}
            <span className="min-w-0 truncate">{entry.relativePath}</span>
          </FileLink>
        </li>
      ))}
    </ul>
  );
}

export function FilesPanel({ threadId }: { threadId: string }) {
  return <FilesSession key={threadId} threadId={threadId} />;
}

function FilesSession({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const edges = useOverflowEdges(scroller, content);
  const [root, setRoot] = useState<Root | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [hits, setHits] = useState<Entry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const next = await rpc.call("workspace_root", { threadId });
        if (cancelled) return;
        setRoot((current) =>
          current?.hostId === next.hostId &&
          current.environmentId === next.environmentId &&
          current.rootPath === next.rootPath
            ? current
            : next,
        );
        setError(null);
      } catch (cause: unknown) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [rpc, threadId]);

  useEffect(() => {
    const query = filter.trim();
    if (query === "") {
      setHits(null);
      setSearching(false);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      void rpc
        .call("search_files", { threadId, query })
        .then((result) => {
          if (cancelled) return;
          setHits(result.entries);
          setSearching(false);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setSearching(false);
          setSearchError(
            cause instanceof Error ? cause.message : String(cause),
          );
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filter, rpc, threadId, root]);

  const filtering = filter.trim() !== "";

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 px-4 pt-0.5 pb-1.5">
      <div className="relative min-w-0 shrink-0">
        <Icon
          name="Search"
          className={cn(
            "pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground",
            COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
          )}
          aria-hidden
        />
        <Input
          type="search"
          maxLength={200}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filter !== "") {
              event.stopPropagation();
              setFilter("");
            }
          }}
          placeholder="Search files"
          aria-label="Search files"
          data-sidetree-search=""
          spellCheck={false}
          className={cn(
            "h-8 pl-8 pr-8 text-sm focus-visible:ring-0 max-md:pointer-coarse:h-10",
            "[&::-webkit-search-cancel-button]:hidden",
          )}
        />
        {searching ? (
          <Icon
            name="Spinner"
            className={cn(
              "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground",
              COARSE_POINTER_ICON_SIZE_CLASS,
            )}
            aria-hidden
          />
        ) : filter !== "" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear search"
            className={cn(
              COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
              "absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setFilter("")}
          >
            <Icon name="X" fallback="X" aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={scroller} className="h-full overflow-auto">
          <div ref={content}>
            {root === null ? (
              error !== null ? (
                <StatusLine tone="destructive">{error}</StatusLine>
              ) : (
                <TreeSkeleton rows={8} />
              )
            ) : (
              <>
                <div hidden={filtering}>
                  <FileTree
                    key={`${root.hostId}:${root.environmentId}:${root.rootPath}`}
                    rpc={rpc}
                    threadId={threadId}
                    environmentId={root.environmentId}
                    scroller={scroller}
                  />
                </div>
                {filtering ? (
                  searchError !== null ? (
                    <StatusLine tone="destructive">{searchError}</StatusLine>
                  ) : hits === null ? (
                    <TreeSkeleton rows={6} />
                  ) : (
                    <FilterHits
                      environmentId={root.environmentId}
                      entries={hits}
                    />
                  )
                ) : null}
              </>
            )}
          </div>
        </div>
        <ScrollEdgeFades
          above={edges.above}
          below={edges.below}
          color="var(--background)"
        />
      </div>
    </div>
  );
}

const HIDDEN = "data-sidetree-hide";
const ACTIONS = "data-sidetree-actions";
const STYLE_ID = "sidetree-host-chrome";
const PREVIEW_ACTIONS = [
  'button[aria-label="Refresh file"]',
  'button[aria-label="Refreshing file"]',
  'button[aria-label="Copy file contents"]',
  'button[aria-label="Copy CSV"]',
  'button[aria-label="Copy markdown"]',
  'button[aria-label="Copy HTML source"]',
  'button[aria-label="Open in external browser"]',
].join(", ");

function markHidden(node: Element | null): void {
  if (!(node instanceof HTMLElement) || node.hasAttribute(HIDDEN)) return;
  node.setAttribute(HIDDEN, "");
  node.hidden = true;
}

function pinPreviewActionsRight(): void {
  const name = document.querySelector('button[aria-label="Copy file path"]');
  if (!(name instanceof HTMLElement) || name.parentElement === null) return;
  const row = name.parentElement;
  const action = row.querySelector(PREVIEW_ACTIONS);
  if (!(action instanceof HTMLElement)) return;
  let cluster: HTMLElement = action;
  while (cluster.parentElement !== null && cluster.parentElement !== row) {
    cluster = cluster.parentElement;
  }
  if (cluster.parentElement !== row || cluster === name) return;
  for (const node of row.querySelectorAll(`[${ACTIONS}]`)) {
    if (node !== cluster) node.removeAttribute(ACTIONS);
  }
  cluster.setAttribute(ACTIONS, "");
}

function hideHostChrome(): () => void {
  const hideMenus = () => {
    for (const item of document.querySelectorAll('[role="menuitem"]')) {
      const label = item.textContent?.trim() ?? "";
      if (label === "Open externally") {
        markHidden(item);
      }
    }
    pinPreviewActionsRight();
  };
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `[${ACTIONS}]{margin-left:auto}
*:has(>input[role="combobox"][aria-label^="Search files"]:not([data-sidetree-search])),
*:has(>input[placeholder="No searchable source"]){display:none!important}`;
  document.head.appendChild(style);
  hideMenus();
  document.addEventListener("pointerdown", hideMenus, true);
  return () => {
    document.removeEventListener("pointerdown", hideMenus, true);
    style.remove();
    for (const node of document.querySelectorAll(`[${HIDDEN}]`)) {
      if (node instanceof HTMLElement) {
        node.hidden = false;
        node.removeAttribute(HIDDEN);
      }
    }
    for (const node of document.querySelectorAll(`[${ACTIONS}]`)) {
      node.removeAttribute(ACTIONS);
    }
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "hide-host-chrome",
    mount() {
      return hideHostChrome();
    },
  });
  app.slots.threadPanelAction({
    id: "files",
    title: "Open files",
    icon: "FolderOpen",
    layout: "flush",
    component: FilesPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Files" });
    },
  });
  app.slots.fileOpener({
    id: "file",
    title: "Editor",
    extensions: OPENER_EXTENSIONS,
    component: FileOpener,
  });
  app.slots.experimental_sourceCodeRenderer({
    id: "source",
    title: "Editor",
    description: "CodeMirror source preview",
    component: SourceRenderer,
  });
});
