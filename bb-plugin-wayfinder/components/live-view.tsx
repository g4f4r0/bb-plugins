import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";

import type { HumanInput } from "../src/contracts/run.js";
import { formatFrameAge } from "./format.js";
import { INITIAL_LIVE_STATE, LiveFramePoller, type LiveFramePollerOptions, type LiveViewState } from "./live-poller.js";

export const STALE_FRAME_MS = 3_000;

const STATUS_TEXT: Record<LiveViewState["status"], string> = {
  connecting: "Connecting to the live view…",
  live: "Live",
  paused: "Preview paused by the run's capture policy.",
  redacted: "Hidden while protected input is in progress.",
  disconnected: "Live view disconnected. Retrying…",
  "no-frame": "Waiting for the first frame…",
  "not-found": "This run is not viewable on this computer.",
};

export function LiveView({
  runId,
  pollerOptions,
  fill = false,
  interactive = false,
  onInput,
  onStatusChange,
}: {
  runId: string;
  pollerOptions?: Partial<Omit<LiveFramePollerOptions, "runId" | "onState">>;
  fill?: boolean;
  interactive?: boolean;
  onInput?: (input: HumanInput) => void;
  onStatusChange?: (status: LiveViewState["status"]) => void;
}) {
  const [state, setState] = useState<LiveViewState>(INITIAL_LIVE_STATE);
  const [clock, setClock] = useState(() => Date.now());
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setState(INITIAL_LIVE_STATE);
    const poller = new LiveFramePoller({ ...pollerOptions, runId, onState: setState });
    poller.start();
    return () => poller.stop();
  }, [runId]);
  useEffect(() => { onStatusChange?.(state.status); }, [onStatusChange, state.status]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const ageMs = state.frameAgeMs === null || state.receivedAt === null ? null : state.frameAgeMs + Math.max(0, clock - state.receivedAt);
  const stale = state.status === "live" && ageMs !== null && ageMs > STALE_FRAME_MS;
  const loadingFrame = state.imageUrl === null && (state.status === "connecting" || state.status === "no-frame");
  const point = (event: MouseEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => {
    const target = image.current;
    if (!target) return null;
    const bounds = target.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(target.naturalWidth - 1, (event.clientX - bounds.left) * target.naturalWidth / bounds.width)),
      y: Math.max(0, Math.min(target.naturalHeight - 1, (event.clientY - bounds.top) * target.naturalHeight / bounds.height)),
    };
  };
  const keyboard = (event: KeyboardEvent<HTMLImageElement>) => {
    if (!interactive || !onInput) return;
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    if (event.key.length === 1 && (modifiers & 7) === 0) onInput({ kind: "text", text: event.key });
    else onInput({ kind: "key", key: event.key, code: event.code, modifiers });
    event.preventDefault();
  };

  return <div className={fill ? "h-full min-h-0 w-full" : "space-y-2"}>
    <div className={fill ? "relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-black" : "relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted"}>
      {state.imageUrl !== null && state.status === "live" ? <img
        ref={image}
        src={state.imageUrl}
        alt="Live view of the controlled browser or app window"
        draggable={false}
        tabIndex={interactive ? 0 : -1}
        aria-label={interactive ? "Live computer; click, type, paste, or scroll" : undefined}
        className={`h-full w-full select-none object-contain outline-none ${stale ? "opacity-50" : ""} ${interactive ? "cursor-default" : ""}`}
        onClick={(event) => { if (!interactive || !onInput) return; const at = point(event); if (at) onInput({ kind: "click", ...at, button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left" }); }}
        onContextMenu={(event) => { if (interactive) event.preventDefault(); }}
        onWheel={(event) => { if (!interactive || !onInput) return; const at = point(event); if (!at) return; event.preventDefault(); onInput({ kind: "wheel", ...at, deltaX: Math.max(-3_000, Math.min(3_000, event.deltaX)), deltaY: Math.max(-3_000, Math.min(3_000, event.deltaY)) }); }}
        onKeyDown={keyboard}
        onPaste={(event) => { if (!interactive || !onInput) return; const text = event.clipboardData.getData("text/plain"); if (text) { event.preventDefault(); onInput({ kind: "text", text: text.slice(0, 10_000) }); } }}
      /> : loadingFrame ? <div role="status" aria-label="Loading browser" className="h-[min(80%,800px)] w-[min(92%,1280px)] max-h-full animate-pulse rounded-md border border-white/10 bg-white/[0.06]" style={{ aspectRatio: "8 / 5" }}><span className="sr-only">{STATUS_TEXT[state.status]}</span></div> : <p className={`px-6 text-center text-sm ${fill ? "text-white/55" : "text-muted-foreground"}`}>{STATUS_TEXT[state.status]}</p>}
    </div>
    {!fill ? <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-live="polite"><div className="flex gap-1"><dt>View</dt><dd className="text-foreground">{stale ? "Stale" : STATUS_TEXT[state.status].split(".")[0]}</dd></div><div className="flex gap-1"><dt>Frame age</dt><dd className={stale ? "text-destructive" : "text-foreground"}>{formatFrameAge(ageMs)}</dd></div><div className="flex gap-1"><dt>Mode</dt><dd className="text-foreground">{interactive ? "Human control" : "Read-only"}</dd></div></dl> : null}
  </div>;
}
