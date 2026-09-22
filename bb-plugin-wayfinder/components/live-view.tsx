import { useEffect, useState } from "react";

import { formatFrameAge } from "./format.js";
import { INITIAL_LIVE_STATE, LiveFramePoller, type LiveFramePollerOptions, type LiveViewState } from "./live-poller.js";

export const STALE_FRAME_MS = 3_000;

const STATUS_TEXT: Record<LiveViewState["status"], string> = {
  connecting: "Connecting to the live view…",
  live: "Live",
  paused: "Preview paused by the run's capture policy.",
  redacted: "Hidden while protected input is in progress.",
  disconnected: "Live view disconnected. Retrying…",
  "no-frame": "No frame captured yet.",
  "not-found": "This run is not viewable on this computer.",
};

/**
 * Read-only preview of the controlling run's bound browser viewport or app
 * window. There is no input path: pointer and keyboard events are not sent
 * anywhere. Closing the view stops only this viewer's polling.
 */
export function LiveView({
  runId,
  pollerOptions,
  fill = false,
}: {
  runId: string;
  pollerOptions?: Partial<Omit<LiveFramePollerOptions, "runId" | "onState">>;
  fill?: boolean;
}) {
  const [state, setState] = useState<LiveViewState>(INITIAL_LIVE_STATE);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    setState(INITIAL_LIVE_STATE);
    const poller = new LiveFramePoller({ ...pollerOptions, runId, onState: setState });
    poller.start();
    return () => poller.stop();
    // Poller options are construction-time configuration.
  }, [runId]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const ageMs =
    state.frameAgeMs === null || state.receivedAt === null ? null : state.frameAgeMs + Math.max(0, clock - state.receivedAt);
  const stale = state.status === "live" && ageMs !== null && ageMs > STALE_FRAME_MS;

  return (
    <div className={fill ? "h-full min-h-0 w-full" : "space-y-2"}>
      <div className={fill ? "relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-black" : "relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted"}>
        {state.imageUrl !== null && state.status === "live" ? (
          <img
            src={state.imageUrl}
            alt="Live view of the controlled browser or app window"
            draggable={false}
            className={`h-full w-full select-none object-contain ${stale ? "opacity-50" : ""}`}
          />
        ) : (
          <p className={`px-6 text-center text-sm ${fill ? "text-white/55" : "text-muted-foreground"}`}>{STATUS_TEXT[state.status]}</p>
        )}
      </div>
      {!fill ? <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-live="polite">
        <div className="flex gap-1">
          <dt>View</dt>
          <dd className="text-foreground">{stale ? "Stale" : STATUS_TEXT[state.status].split(".")[0]}</dd>
        </div>
        <div className="flex gap-1">
          <dt>Frame age</dt>
          <dd className={stale ? "text-destructive" : "text-foreground"}>{formatFrameAge(ageMs)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>Mode</dt>
          <dd className="text-foreground">Read-only</dd>
        </div>
      </dl> : null}
    </div>
  );
}
