import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type WheelEvent } from "react";

import type { HumanInput } from "../src/contracts/run.js";
import { formatFrameAge } from "./format.js";
import { INITIAL_LIVE_STATE, LiveFramePoller, type LiveFramePollerOptions, type LiveViewState } from "./live-poller.js";

export const STALE_FRAME_MS = 3_000;

function inputPoint(image: HTMLImageElement, clientX: number, clientY: number) {
  const bounds = image.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: Math.max(0, Math.min(image.naturalWidth - 1, (clientX - bounds.left) * image.naturalWidth / bounds.width)),
    y: Math.max(0, Math.min(image.naturalHeight - 1, (clientY - bounds.top) * image.naturalHeight / bounds.height)),
  };
}

function toKeyboardInput(event: KeyboardEvent<HTMLImageElement>): HumanInput {
  const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  return event.key.length === 1 && (modifiers & 7) === 0 ? { kind: "text", text: event.key } : { kind: "key", key: event.key, code: event.code, modifiers };
}

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
  const root = useRef<HTMLDivElement>(null);
  const visible = useRef(true);

  useEffect(() => {
    const node = root.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => { visible.current = entries.some((entry) => entry.isIntersecting); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setState(INITIAL_LIVE_STATE);
    const callerHidden = pollerOptions?.isHidden;
    const poller = new LiveFramePoller({ ...pollerOptions, runId, onState: setState, isHidden: () => !visible.current || callerHidden?.() === true });
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
    return inputPoint(target, event.clientX, event.clientY);
  };
  const keyboard = (event: KeyboardEvent<HTMLImageElement>) => {
    if (!interactive || !onInput) return;
    onInput(toKeyboardInput(event));
    event.preventDefault();
  };

  return <div ref={root} className={fill ? "h-full min-h-0 w-full" : "space-y-2"}>
    <div className={fill ? "relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-black" : "relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted"}>
      {state.imageUrl !== null && state.status !== "redacted" ? <img
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

export function DesktopView({ imageUrl, interactive, onInput }: { imageUrl: string; interactive: boolean; onInput: (input: HumanInput) => void }) {
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; startedAt: number } | null>(null);
  const dragged = useRef(false);
  const point = (event: MouseEvent<HTMLImageElement> | PointerEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => image.current ? inputPoint(image.current, event.clientX, event.clientY) : null;
  return <div className="relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-black">
    <img
      ref={image}
      src={imageUrl}
      alt="Live view of the controlled desktop"
      draggable={false}
      tabIndex={interactive ? 0 : -1}
      aria-label={interactive ? "Live computer; click, drag, type, paste, or scroll" : undefined}
      className={`h-full w-full select-none object-contain outline-none ${interactive ? "cursor-default touch-none" : ""}`}
      onPointerDown={(event) => { if (!interactive || event.button !== 0) return; const at = point(event); if (!at) return; image.current?.focus({ preventScroll: true }); if (typeof image.current?.setPointerCapture === "function") image.current.setPointerCapture(event.pointerId); drag.current = { pointerId: event.pointerId, x: at.x, y: at.y, startedAt: Date.now() }; dragged.current = false; }}
      onPointerMove={(event) => { const start = drag.current; if (!start || start.pointerId !== event.pointerId) return; const at = point(event); if (at && Math.hypot(at.x - start.x, at.y - start.y) >= 4) dragged.current = true; }}
      onPointerUp={(event) => { const start = drag.current; if (!start || start.pointerId !== event.pointerId) return; const at = point(event); drag.current = null; if (typeof image.current?.hasPointerCapture === "function" && image.current.hasPointerCapture(event.pointerId)) image.current.releasePointerCapture(event.pointerId); if (at && dragged.current) onInput({ kind: "drag", fromX: start.x, fromY: start.y, toX: at.x, toY: at.y, button: "left", durationMs: Math.min(10_000, Date.now() - start.startedAt) }); }}
      onPointerCancel={() => { drag.current = null; dragged.current = false; }}
      onClick={(event) => { if (!interactive || dragged.current) { dragged.current = false; return; } const at = point(event); if (at) onInput({ kind: "click", ...at, button: "left" }); }}
      onAuxClick={(event) => { if (!interactive || event.button !== 1) return; const at = point(event); if (at) { event.preventDefault(); onInput({ kind: "click", ...at, button: "middle" }); } }}
      onContextMenu={(event) => { if (!interactive) return; const at = point(event); event.preventDefault(); if (at) onInput({ kind: "click", ...at, button: "right" }); }}
      onWheel={(event) => { if (!interactive) return; const at = point(event); if (!at) return; event.preventDefault(); onInput({ kind: "wheel", ...at, deltaX: Math.max(-3_000, Math.min(3_000, event.deltaX)), deltaY: Math.max(-3_000, Math.min(3_000, event.deltaY)) }); }}
      onKeyDown={(event) => { if (!interactive) return; onInput(toKeyboardInput(event)); event.preventDefault(); }}
      onPaste={(event) => { if (!interactive) return; const text = event.clipboardData.getData("text/plain"); if (text) { event.preventDefault(); onInput({ kind: "text", text: text.slice(0, 10_000) }); } }}
    />
  </div>;
}
