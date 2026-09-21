import { Copy01Icon, Download04Icon, File01Icon, Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import type { ArtifactRecord } from "../src/contracts/artifact.js";
import { entityIdSchema } from "../src/contracts/primitives.js";
import { browserClipboardEnvironment, copyArtifact, type ClipboardEnvironment, type CopyOutcome } from "./clipboard.js";
import { errorMessage, formatBytes, formatDuration } from "./format.js";
import { IconButton } from "./icon-button.js";
import type { UiRpcContract } from "./rpc.js";
import { ShareControls } from "./share-controls.js";
import { absoluteUrl, artifactUrl } from "./urls.js";

type Preview = "image" | "video" | "none";

function previewFor(mimeType: string): Preview {
  if (mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp") return "image";
  if (mimeType === "video/mp4") return "video";
  // Reports, trails, and HTML never render inside BB; they are download-only.
  return "none";
}

/**
 * `::wayfinder-artifact{id="art_…"}` in an assistant message. Attributes are
 * untrusted: only a bounded opaque ID is accepted, and the lookup is scoped
 * to the message's own thread, so another thread's artifact is "not found".
 */
export function ArtifactDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const rpc = useRpc<UiRpcContract>();
  const parsedId = entityIdSchema.safeParse(attributes.id);
  const artifactId = parsedId.success ? parsedId.data : null;
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; artifact: ArtifactRecord } | { kind: "error"; message: string }>({
    kind: "loading",
  });

  useEffect(() => {
    if (artifactId === null) return;
    let cancelled = false;
    setState({ kind: "loading" });
    rpc
      .call("artifacts.get", { threadId: message.threadId, artifactId })
      .then((artifact) => !cancelled && setState({ kind: "ready", artifact }))
      .catch((error: unknown) => !cancelled && setState({ kind: "error", message: errorMessage(error) }));
    return () => {
      cancelled = true;
    };
  }, [rpc, artifactId, message.threadId]);

  if (artifactId === null) return <CardNotice>Invalid Wayfinder artifact reference.</CardNotice>;
  if (state.kind === "loading") return <CardNotice>Loading artifact…</CardNotice>;
  if (state.kind === "error") return <CardNotice>Artifact unavailable: {state.message}</CardNotice>;
  return <ArtifactCard artifact={state.artifact} threadId={message.threadId} />;
}

function CardNotice({ children }: { children: React.ReactNode }) {
  return <div className="my-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">{children}</div>;
}

export function ArtifactCard({
  artifact,
  threadId,
  clipboard = browserClipboardEnvironment(),
}: {
  artifact: ArtifactRecord;
  threadId: string;
  clipboard?: ClipboardEnvironment;
}) {
  const media = artifact.media;
  const preview = previewFor(media.mimeType);
  const inlineUrl = artifactUrl("inline", artifact.artifactId, threadId);
  const downloadUrl = artifactUrl("download", artifact.artifactId, threadId);
  const [copyState, setCopyState] = useState<CopyOutcome | { kind: "busy" } | { kind: "error"; note: string } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const statusId = useId();
  const manualRef = useRef<HTMLInputElement>(null);

  const onCopy = useCallback(async () => {
    setCopyState({ kind: "busy" });
    try {
      const outcome = await copyArtifact({
        isImage: preview === "image",
        fetchImage: async () => {
          const response = await fetch(inlineUrl, { credentials: "same-origin", cache: "no-store" });
          if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);
          return response.blob();
        },
        link: absoluteUrl(inlineUrlOrDownload(preview, inlineUrl, downloadUrl)),
        env: clipboard,
      });
      setCopyState(outcome);
      if (outcome.kind === "image") toast.success("Image copied");
      else if (outcome.kind === "link") toast.message("Link copied", { description: outcome.note });
      else toast.error("Copy failed", { description: outcome.note });
    } catch (error) {
      setCopyState({ kind: "error", note: errorMessage(error) });
      toast.error("Copy failed", { description: errorMessage(error) });
    }
  }, [clipboard, downloadUrl, inlineUrl, preview]);

  useEffect(() => {
    if (copyState?.kind === "manual") manualRef.current?.select();
  }, [copyState]);

  const details = [
    media.mimeType,
    formatBytes(media.sizeBytes),
    media.width !== null && media.height !== null ? `${media.width}×${media.height}` : null,
    media.durationMs !== null ? formatDuration(media.durationMs) : null,
  ].filter((part): part is string => part !== null);

  return (
    <figure className="my-2 w-full max-w-xl overflow-hidden rounded-lg border border-border bg-card" aria-describedby={statusId}>
      {preview === "image" ? (
        <a href={inlineUrl} target="_blank" rel="noopener noreferrer" className="block bg-muted">
          <img src={inlineUrl} alt={media.filename} loading="lazy" decoding="async" className="mx-auto max-h-80 w-auto object-contain" />
        </a>
      ) : preview === "video" ? (
        <video src={inlineUrl} controls playsInline preload="metadata" className="max-h-80 w-full bg-muted">
          <track kind="captions" />
        </video>
      ) : (
        <div className="flex items-center gap-2 bg-muted px-3 py-4 text-sm text-muted-foreground">
          <HugeiconsIcon icon={File01Icon} size={18} aria-hidden="true" />
          Download to view. Reports never run inside BB.
        </div>
      )}
      <figcaption className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground" title={media.filename}>
            {media.filename}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {details.join(" · ")}
            {media.redacted ? " · redacted" : ""}
          </div>
        </div>
        <IconButton
          icon={Copy01Icon}
          label={preview === "image" ? "Copy image" : "Copy link"}
          tooltip={preview === "image" ? "Copy image (falls back to a private link)" : "Copy private link"}
          onClick={() => void onCopy()}
          disabled={copyState?.kind === "busy"}
        />
        <a
          href={downloadUrl}
          download={media.filename}
          aria-label="Download"
          title="Download"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <HugeiconsIcon icon={Download04Icon} size={16} strokeWidth={1.8} aria-hidden="true" />
        </a>
        <ShareToggle artifact={artifact} threadId={threadId} open={shareOpen} onToggle={() => setShareOpen((open) => !open)} />
      </figcaption>
      <div id={statusId} aria-live="polite" className="px-3 text-xs text-muted-foreground empty:hidden">
        {copyState?.kind === "link" ? <p className="pb-2">{copyState.note}</p> : null}
        {copyState?.kind === "error" ? <p className="pb-2 text-destructive">Copy failed: {copyState.note}</p> : null}
        {copyState?.kind === "manual" ? (
          <div className="space-y-1 pb-2">
            <p className="text-destructive">{copyState.note}</p>
            <input
              ref={manualRef}
              readOnly
              value={copyState.text}
              aria-label="Private artifact link"
              className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        ) : null}
      </div>
      {shareOpen ? <ShareControls artifact={artifact} threadId={threadId} clipboard={clipboard} /> : null}
    </figure>
  );
}

function inlineUrlOrDownload(preview: Preview, inlineUrl: string, downloadUrl: string): string {
  return preview === "none" ? downloadUrl : inlineUrl;
}

/**
 * Share is enabled only when the server reports external sharing ready.
 * Otherwise it stays visibly disabled with the exact prerequisite.
 */
function ShareToggle({
  artifact,
  threadId,
  open,
  onToggle,
}: {
  artifact: ArtifactRecord;
  threadId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const rpc = useRpc<UiRpcContract>();
  const [availability, setAvailability] = useState<{ ready: boolean; reason: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("artifacts.shareStatus", { threadId, runId: artifact.runId })
      .then((status) => {
        if (cancelled) return;
        setAvailability(
          status.external.state === "ready"
            ? { ready: true, reason: "" }
            : { ready: false, reason: status.external.reason },
        );
      })
      .catch((error: unknown) => !cancelled && setAvailability({ ready: false, reason: errorMessage(error) }));
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, artifact.runId]);

  const disabled = availability === null || !availability.ready || !artifact.sanitized;
  const tooltip =
    availability === null
      ? "Checking whether external sharing is available…"
      : !availability.ready
        ? `External sharing unavailable: ${availability.reason}`
        : !artifact.sanitized
          ? "Only sanitized artifacts can be shared"
          : "Share online with an expiring link";
  return (
    <IconButton
      icon={Share08Icon}
      label="Share"
      tooltip={tooltip}
      aria-expanded={open}
      aria-description={disabled ? tooltip : undefined}
      disabled={disabled}
      onClick={onToggle}
    />
  );
}
