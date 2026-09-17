import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  experimental_Icon as Icon,
  useRpc,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { Toggle } from "./components/ui/toggle";
import {
  COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS,
  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
} from "./components/ui/coarse-pointer-sizing";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CodeEditor, type CodeEditorHandle } from "./code-editor";
import { MarkdownEditor } from "./markdown-editor";
import { Skeleton } from "./components/ui/skeleton";
import {
  isLastInputKeyboard,
  preventOverlayTriggerSelection,
} from "./components/ui/overlay-trigger";
import { usePortalScopeProps } from "./lib/portal-scope";
import { cn } from "./lib/utils";
import type { FileTarget, rpcContract } from "./server";
import { DISK_CONFLICT, fileSyncAction } from "./file-sync";
import { toast } from "sonner";
import { FileGlyph } from "./file-icon";
import { Icon as Glyph } from "./components/ui/icon";
import { syncFileTabIcon } from "./tab-icon";
import { fileIconToken, fileName, isMarkdownPath } from "./tree";

const ITEM =
  "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none focus:bg-state-hover focus:text-foreground data-[highlighted]:bg-state-hover data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0";

function FileActions({
  text,
  disabled,
  onCopy,
  onDownload,
  onDelete,
  onPrepare,
}: {
  text: boolean;
  disabled: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onPrepare: () => void;
}) {
  const portal = usePortalScopeProps();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label="File actions"
          className={COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS}
          onMouseDown={(event) => {
            preventOverlayTriggerSelection(event);
            onPrepare();
          }}
        >
          <Icon name="MoreHorizontal" fallback="MoreHorizontal" aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...portal}
          align="end"
          sideOffset={4}
          onCloseAutoFocus={(event) => {
            if (!isLastInputKeyboard()) event.preventDefault();
          }}
          className="z-50 min-w-40 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {text ? (
            <DropdownMenu.Item className={ITEM} onSelect={onCopy}>
              <Icon name="Copy" fallback="Copy" aria-hidden />
              Copy contents
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className={ITEM} onSelect={onDownload}>
            <Icon name="Download" fallback="Download" aria-hidden />
            Download
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
          <DropdownMenu.Item
            className={cn(
              ITEM,
              "text-destructive focus:bg-destructive/15 focus:text-destructive data-[highlighted]:bg-destructive/15 data-[highlighted]:text-destructive",
            )}
            onSelect={onDelete}
          >
            <Icon name="Trash2" fallback="Trash2" aria-hidden />
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const LINE_WIDTHS = [
  72, 54, 88, 41, 63, 79, 36, 58, 91, 47, 70, 33, 85, 52, 66, 44, 77, 39, 60,
  83, 49, 68, 31, 74,
];

function FileSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2 overflow-hidden px-4 py-2.5"
      aria-busy="true"
      aria-label="Loading"
    >
      {LINE_WIDTHS.map((width, index) => (
        <Skeleton
          key={index}
          className="h-3 rounded-sm"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}

function toTarget(
  path: string,
  source: PluginFileOpenerProps["source"],
): FileTarget {
  return {
    path,
    kind: source.kind,
    threadId: source.threadId,
    environmentId: source.environmentId,
    ...(source.experimental_hostId === undefined
      ? {}
      : { hostId: source.experimental_hostId }),
  };
}

function downloadBytes(name: string, bytes: BlobPart, type: string): void {
  const blob = new Blob([bytes], { type });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  URL.revokeObjectURL(href);
}

async function copyText(
  value: string,
  successMessage: string,
  errorMessage: string,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    notify(successMessage, "success");
  } catch {
    notify(errorMessage, "error");
  }
}

function notify(title: string, tone: "success" | "error"): void {
  toast.custom(
    (id) => (
      <div className="w-[var(--width,356px)] max-w-[calc(100vw-32px)] shrink-0 rounded-md border border-border bg-popover px-4 py-3 text-popover-foreground shadow-sm max-[600px]:w-[calc(100vw-32px)]">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-foreground">
            <Icon
              name={tone === "success" ? "CircleCheck" : "AlertCircle"}
              className="size-4"
              aria-hidden
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium leading-5">{title}</div>
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            className="-mr-1 -mt-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground"
            onClick={() => toast.dismiss(id)}
          >
            <Icon name="X" className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    ),
    { className: "bb-app-toast", duration: 4000, unstyled: true },
  );
}

export function FileOpener(props: PluginFileOpenerProps) {
  const key = JSON.stringify(toTarget(props.path, props.source));
  return <FileSession key={key} {...props} />;
}

function FileSession({
  path,
  source,
  experimental_lineRange,
}: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const portal = usePortalScopeProps();
  const target = toTarget(path, source);
  const name = fileName(path);
  const markdown = isMarkdownPath(path);

  const editor = useRef<CodeEditorHandle | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [dirty, setDirty] = useState(false);
  const [sha256, setSha256] = useState<string | null>(null);
  const [encoding, setEncoding] = useState<"utf8" | "base64">("utf8");
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [image, setImage] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [text, setText] = useState(true);
  const [deleted, setDeleted] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "delete" | null>("load");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [edits, setEdits] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [sourceMode, setSourceMode] = useState(
    () => experimental_lineRange?.startLineNumber != null,
  );
  const [draft, setDraft] = useState("");
  const [fileRevision, setFileRevision] = useState(0);
  const richMarkdown = markdown && draft.length <= 500_000;
  const operation = useRef(0);
  const mounted = useRef(true);
  const saving = useRef(false);
  const editVersion = useRef(0);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current += 1;
    };
  }, []);

  const applyFile = useCallback(
    (file: {
      content: string;
      encoding: "utf8" | "base64";
      mimeType: string | null;
      sha256: string;
      image: boolean;
      text: boolean;
    }) => {
      setContent(file.content);
      setSaved(file.content);
      setDraft(file.content);
      // An explicit reset updates the existing editor even when the prop is unchanged.
      setFileRevision((revision) => revision + 1);
      setDirty(false);
      setSha256(file.sha256);
      setEncoding(file.encoding);
      setMimeType(file.mimeType);
      setImage(file.image);
      setImageFailed(false);
      setText(file.text);
    },
    [],
  );

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const version = ++operation.current;
      const editsAtStart = editVersion.current;
      if (!opts?.silent) setBusy("load");
      setError(null);
      try {
        const file = await rpc.call("read_file", target);
        if (!mounted.current || version !== operation.current) return;
        if (editsAtStart !== editVersion.current) {
          setError(DISK_CONFLICT);
          return;
        }
        applyFile(file);
      } catch (cause: unknown) {
        if (!mounted.current || version !== operation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (mounted.current && version === operation.current && !opts?.silent)
          setBusy(null);
      }
    },
    [
      applyFile,
      rpc,
      target.path,
      target.kind,
      target.threadId,
      target.environmentId,
      target.hostId,
    ],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSourceMode(experimental_lineRange?.startLineNumber != null);
  }, [path, experimental_lineRange?.startLineNumber]);

  const syncRef = useRef({
    applyFile,
    busy,
    deleted,
    dirty,
    error,
    rpc,
    sha256,
    target,
  });
  syncRef.current = {
    applyFile,
    busy,
    deleted,
    dirty,
    error,
    rpc,
    sha256,
    target,
  };

  useEffect(() => {
    const node = root.current;
    if (node == null) return;
    let cancelled = false;
    let intersecting = false;
    let pending = false;
    let timer = 0;

    const visible = () =>
      intersecting && document.visibilityState === "visible";

    const poll = async () => {
      const current = syncRef.current;
      if (
        cancelled ||
        pending ||
        !visible() ||
        current.deleted ||
        current.sha256 === null ||
        current.busy !== null ||
        saving.current
      ) {
        return;
      }
      pending = true;
      const version = operation.current;
      try {
        const file = await current.rpc.call("poll_file", {
          ...current.target,
          sha256: current.sha256,
        });
        if (cancelled || version !== operation.current) return;
        setRefreshError(null);
        const latest = syncRef.current;
        if (
          latest.busy !== null ||
          saving.current ||
          latest.sha256 === null ||
          editor.current?.isComposing?.()
        )
          return;
        const action =
          file === null
            ? "same"
            : fileSyncAction(latest.sha256, file.sha256, latest.dirty);
        if (action === "same") {
          if (latest.error === DISK_CONFLICT) setError(null);
          return;
        }
        if (action === "conflict") {
          setError(DISK_CONFLICT);
          return;
        }
        if (file !== null) latest.applyFile(file);
        if (latest.error === DISK_CONFLICT) setError(null);
      } catch (cause: unknown) {
        // Keep the editable snapshot while surfacing deletion/offline failures.
        if (!cancelled && version === operation.current)
          setRefreshError(
            `Unable to refresh: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
      } finally {
        pending = false;
      }
    };

    const arm = () => {
      window.clearTimeout(timer);
      if (!cancelled && visible()) {
        timer = window.setTimeout(() => {
          void poll().then(arm);
        }, 1500);
      }
    };

    const kick = () => {
      if (!visible()) {
        window.clearTimeout(timer);
        return;
      }
      void poll().then(arm);
    };

    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      kick();
    });
    observer.observe(node);
    document.addEventListener("visibilitychange", kick);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", kick);
    };
  }, []);

  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (parent == null) return;
    const position = parent.style.position;
    const overflow = parent.style.overflow;
    parent.style.position = "relative";
    parent.style.overflow = "hidden";
    return () => {
      parent.style.position = position;
      parent.style.overflow = overflow;
    };
  }, []);

  useLayoutEffect(() => syncFileTabIcon(path), [path]);

  function liveText(): string {
    return editor.current?.getDoc() ?? content;
  }

  const markDirty = useCallback((next: boolean) => {
    editVersion.current += 1;
    syncRef.current.dirty = next;
    setDirty(next);
    if (next) {
      setError((current) => (current === DISK_CONFLICT ? current : null));
      setEdits((count) => count + 1);
    }
  }, []);

  async function save(): Promise<void> {
    if (
      !text ||
      sha256 === null ||
      !syncRef.current.dirty ||
      deleted ||
      busy !== null ||
      saving.current ||
      editor.current?.isComposing?.()
    )
      return;
    saving.current = true;
    const version = ++operation.current;
    const next = liveText();
    setBusy("save");
    setError(null);
    try {
      const result = await rpc.call("write_file", {
        ...target,
        content: next,
        expectedSha256: sha256,
      });
      if (!mounted.current || version !== operation.current) return;
      if (result.outcome === "conflict") {
        setError(DISK_CONFLICT);
        return;
      }
      setContent(next);
      setSha256(result.sha256);
      // The disk baseline advances even if more edits arrived during the write.
      setSaved(next);
      const stillDirty = liveText() !== next;
      syncRef.current.dirty = stillDirty;
      setDirty(stillDirty);
    } catch (cause: unknown) {
      if (mounted.current && version === operation.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      saving.current = false;
      if (mounted.current && version === operation.current) setBusy(null);
    }
  }

  async function copyContents(): Promise<void> {
    if (!text) return;
    await copyText(liveText(), "Contents copied", "Failed to copy contents");
  }

  async function copyPath(): Promise<void> {
    await copyText(path, "Path copied", "Failed to copy path");
  }

  function download(): void {
    if (encoding === "base64") {
      const binary = atob(content);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      downloadBytes(name, bytes, mimeType ?? "application/octet-stream");
      return;
    }
    downloadBytes(name, liveText(), mimeType ?? "text/plain;charset=utf-8");
  }

  async function remove(): Promise<void> {
    if (busy !== null || saving.current) return;
    const version = ++operation.current;
    setBusy("delete");
    setError(null);
    try {
      await rpc.call("remove_file", target);
      if (!mounted.current || version !== operation.current) return;
      setDeleted(true);
      setConfirmDelete(false);
      setSaved(content);
      syncRef.current.deleted = true;
    } catch (cause: unknown) {
      if (!mounted.current || version !== operation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && version === operation.current) setBusy(null);
    }
  }

  const saveRef = useRef(save);
  saveRef.current = save;
  const onSave = useCallback(() => {
    void saveRef.current();
  }, []);
  useEffect(() => {
    if (
      !text ||
      deleted ||
      sha256 === null ||
      !dirty ||
      busy !== null ||
      error !== null
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveRef.current();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [busy, deleted, dirty, edits, error, sha256, text]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "s"
      ) {
        return;
      }
      if (
        event.defaultPrevented ||
        !root.current?.contains(document.activeElement)
      )
        return;
      event.preventDefault();
      void saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      ref={root}
      data-sidetree-opener=""
      className="absolute inset-0 flex flex-col overflow-hidden"
    >
      <div className="flex shrink-0 items-center gap-1 px-4 pt-0.5 pb-1">
        <Tooltip.Provider delayDuration={300}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label="Copy path"
                className={cn(
                  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
                  "min-w-0 max-w-full justify-start gap-1.5 font-normal text-muted-foreground",
                )}
                onMouseDown={preventOverlayTriggerSelection}
                onClick={() => void copyPath()}
              >
                <FileGlyph token={fileIconToken(path)} />
                <span className="min-w-0 truncate">{path}</span>
                {
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full bg-primary ring-1 ring-primary/40",
                      !dirty && "invisible",
                    )}
                    title={dirty ? "Unsaved changes" : undefined}
                    aria-label={dirty ? "Unsaved changes" : undefined}
                    aria-hidden={!dirty}
                  />
                }
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                {...portal}
                side="bottom"
                sideOffset={4}
                className="z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
              >
                Copy path
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {
              <Button
                type="button"
                variant="ghost"
                tabIndex={-1}
                aria-label={busy === "save" ? "Saving" : undefined}
                aria-hidden={busy !== "save"}
                className={cn(
                  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
                  busy !== "save" && "invisible",
                  "pointer-events-none gap-1.5 bg-transparent text-muted-foreground hover:bg-transparent hover:text-muted-foreground [&_svg]:size-3.5 max-md:pointer-coarse:[&_svg]:size-5",
                )}
              >
                <Icon
                  name="Spinner"
                  fallback="Loader"
                  className="size-3.5 shrink-0 animate-spin max-md:pointer-coarse:size-5"
                  aria-hidden
                />
                Saving
              </Button>
            }
            {text && (!richMarkdown || sourceMode) ? (
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <span className="inline-flex">
                    <Toggle
                      pressed={wrap}
                      onPressedChange={setWrap}
                      disabled={deleted || busy === "load"}
                      aria-label="Wrap lines"
                      size="icon"
                      className={COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS}
                      onMouseDown={preventOverlayTriggerSelection}
                    >
                      <Glyph name="TextWrap" className="size-3.5" aria-hidden />
                    </Toggle>
                  </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    {...portal}
                    side="bottom"
                    sideOffset={4}
                    className="z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
                  >
                    Wrap lines
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            ) : null}
            {richMarkdown ? (
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <span className="inline-flex">
                    <Toggle
                      pressed={sourceMode}
                      onPressedChange={(next) => {
                        setDraft(liveText());
                        setSourceMode(next);
                      }}
                      disabled={deleted || busy === "load"}
                      aria-label="Code"
                      size="icon"
                      className={COARSE_POINTER_COMPACT_ICON_BUTTON_CLASS}
                      onMouseDown={preventOverlayTriggerSelection}
                    >
                      <Glyph name="Code" className="size-3.5" aria-hidden />
                    </Toggle>
                  </span>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    {...portal}
                    side="bottom"
                    sideOffset={4}
                    className="z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
                  >
                    Code
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            ) : null}
            <FileActions
              text={text}
              disabled={deleted || busy !== null || sha256 === null}
              onCopy={() => void copyContents()}
              onDownload={download}
              onDelete={() => setConfirmDelete(true)}
              onPrepare={() => editor.current?.blur()}
            />
          </div>
        </Tooltip.Provider>
      </div>
      {error !== null || refreshError !== null ? (
        <div
          role="alert"
          className="flex items-center gap-2 px-4 py-2 text-sm text-destructive"
        >
          <p className="min-w-0 flex-1">{error ?? refreshError}</p>
          {error !== null ? (
            <Button
              type="button"
              variant="ghost"
              className={COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS}
              onClick={() => void load({ silent: sha256 !== null })}
            >
              {error === DISK_CONFLICT ? "Reload" : "Retry"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-hidden",
          text ? "" : "overflow-auto",
        )}
      >
        {deleted ? (
          <p className="px-4 py-2.5 text-sm text-muted-foreground">
            {name} was deleted.
          </p>
        ) : busy === "load" ? (
          <FileSkeleton />
        ) : sha256 === null ? (
          <p className="px-4 py-2.5 text-sm text-muted-foreground">
            File unavailable.
          </p>
        ) : image && imageFailed ? (
          <p className="px-4 py-2.5 text-sm text-muted-foreground">
            Image preview unavailable. Use File actions to download it.
          </p>
        ) : image ? (
          <img
            alt={name}
            src={
              encoding === "base64"
                ? `data:${mimeType ?? "image/*"};base64,${content}`
                : `data:${mimeType ?? "application/octet-stream"};charset=utf-8,${encodeURIComponent(content)}`
            }
            onError={() => setImageFailed(true)}
            className="h-full w-full object-contain p-4"
          />
        ) : text ? (
          richMarkdown && !sourceMode ? (
            <MarkdownEditor
              revision={fileRevision}
              path={path}
              value={draft}
              saved={saved}
              onDirty={markDirty}
              readOnly={deleted}
              editorRef={editor}
            />
          ) : (
            <CodeEditor
              revision={fileRevision}
              path={path}
              value={draft}
              cleanValue={saved}
              onDirty={markDirty}
              onSave={onSave}
              readOnly={deleted}
              wrap={wrap}
              startLine={experimental_lineRange?.startLineNumber}
              endLine={experimental_lineRange?.endLineNumber}
              editorRef={editor}
            />
          )
        ) : (
          <p className="px-4 py-2.5 text-sm text-muted-foreground">
            Binary file · {name}
          </p>
        )}
      </div>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent hideCloseButton>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              This removes the file from disk. It cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy === "delete"}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
