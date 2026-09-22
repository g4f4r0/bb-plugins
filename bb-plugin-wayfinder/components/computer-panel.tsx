import {
  experimental_Icon as Icon,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ArtifactRecord } from "../src/contracts/artifact.js";
import { entityIdSchema } from "../src/contracts/primitives.js";
import type { ComputerSnapshot, RunRecord } from "../src/contracts/run.js";
import type { wayfinderSettingsRpcContract } from "../src/contracts/settings.js";
import { ArtifactCard } from "./artifact-card.js";
import { errorMessage, formatDuration, RUN_STATE_LABEL, TERMINAL_RUN_STATES } from "./format.js";
import { LiveView } from "./live-view.js";
import { COMPUTER_REALTIME_CHANNEL, type UiRpcContract } from "./rpc.js";

type SettingsRpcContract = typeof wayfinderSettingsRpcContract;

const SNAPSHOT_INTERVAL_MS = 2_000;

export function selectedRunFromParams(params: unknown): string | null {
  const parsed = entityIdSchema.safeParse(
    params && typeof params === "object" && "runId" in params ? params.runId : null,
  );
  return parsed.success ? parsed.data : null;
}

export function ComputerPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<UiRpcContract>();
  const settingsRpc = useRpc<SettingsRpcContract>();
  const connection = useRealtimeConnectionState();
  const [hostId, setHostId] = useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    settingsRpc
      .call("settings.get", {})
      .then((state) => { if (!cancelled) { setHostId(state.selectedHostId); setSettingsLoading(false); } })
      .catch(() => { if (!cancelled) setSettingsLoading(false); });
    return () => { cancelled = true; };
  }, [settingsRpc]);
  const [selectedRunId, selectRun] = useState(() => selectedRunFromParams(params));
  useEffect(() => { selectRun(selectedRunFromParams(params)); }, [threadId, params]);
  const [snapshot, setSnapshot] = useState<ComputerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (hostId === null || inflight.current) return;
    inflight.current = true;
    try {
      setSnapshot(await rpc.call("computer.snapshot", { hostId, selectedRunId }));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inflight.current = false;
    }
  }, [rpc, hostId, selectedRunId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh();
    }, SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useRealtime(COMPUTER_REALTIME_CHANNEL, () => void refresh());
  const previousConnection = useRef(connection);
  useEffect(() => {
    // Signals are ephemeral; reconcile after a reconnect.
    if (previousConnection.current !== "connected" && connection === "connected") void refresh();
    previousConnection.current = connection;
  }, [connection, refresh]);

  if (settingsLoading || (hostId !== null && snapshot === null && error === null)) {
    return (
      <div role="status" aria-label="Loading computer" className="flex h-full min-h-0 items-center justify-center bg-sidebar text-sidebar-foreground">
        <Icon name="Loading" aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (hostId === null) {
    return (
      <Notice title="Setup required">
        Choose a computer in Wayfinder settings to get started.
      </Notice>
    );
  }
  if (snapshot === null && error !== null) {
    return <Notice title="Computer unavailable">{error}</Notice>;
  }

  const active = snapshot?.activeRun ?? null;
  const selected = snapshot?.selectedRun ?? null;
  if (snapshot?.readiness === "setup-required" && active === null && selectedRunId === null && snapshot.queue.length === 0) {
    return <Notice title="Setup required">{snapshot.readinessMessage || "Finish setup in Wayfinder settings to get started."}</Notice>;
  }

  return (
    <Page>
      <section aria-label="Computer status" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <Badge tone={snapshot?.readiness === "ready" ? "ok" : "warn"}>{snapshot?.readiness ?? "loading"}</Badge>
        <span className="text-muted-foreground">
          Host <span className="font-mono text-foreground">{hostId}</span>
        </span>
        <span className="text-muted-foreground">
          Connection <span className="text-foreground">{connectionLabel(connection, snapshot, error)}</span>
        </span>
        {snapshot?.readinessMessage ? <span className="w-full text-muted-foreground">{snapshot.readinessMessage}</span> : null}
        {error !== null ? (
          <span role="alert" className="w-full text-destructive">
            {error}
          </span>
        ) : null}
      </section>

      <section aria-labelledby="wf-controller" className="space-y-2">
        <h2 id="wf-controller" className="text-sm font-semibold text-foreground">
          Current controller
        </h2>
        {active === null ? (
          <p className="text-sm text-muted-foreground">No run is controlling the computer.</p>
        ) : (
          <>
            <RunSummary run={active} now={snapshot?.sampledAt ?? Date.now()} onSelect={() => selectRun(active.runId)} />
            <LiveView runId={active.runId} />
          </>
        )}
      </section>

      <section aria-labelledby="wf-queue" className="space-y-2">
        <h2 id="wf-queue" className="text-sm font-semibold text-foreground">
          Queue {snapshot !== null ? `(${snapshot.queue.length})` : ""}
        </h2>
        {snapshot === null || snapshot.queue.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs waiting.</p>
        ) : (
          <ol className="divide-y divide-border rounded-lg border border-border">
            {snapshot.queue.map((entry) => (
              <li key={entry.runId}>
                <button
                  type="button"
                  onClick={() => selectRun(entry.runId)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <span className="w-6 text-muted-foreground">#{entry.position}</span>
                  <span className="font-mono text-foreground">{entry.runId}</span>
                  <span className="ml-auto text-xs text-muted-foreground">thread {entry.threadId}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {selectedRunId !== null ? (
        <SelectedRun
          runId={selectedRunId}
          run={selected}
          isController={active?.runId === selectedRunId}
          now={snapshot?.sampledAt ?? Date.now()}
          onClose={() => selectRun(null)}
          onChanged={() => void refresh()}
        />
      ) : null}
    </Page>
  );
}

function connectionLabel(connection: string, snapshot: ComputerSnapshot | null, error: string | null): string {
  if (error !== null) return "unreachable";
  if (connection !== "connected") return connection;
  return snapshot?.connectionState ?? "connecting";
}

function SelectedRun({
  runId,
  run,
  isController,
  now,
  onClose,
  onChanged,
}: {
  runId: string;
  run: RunRecord | null;
  isController: boolean;
  now: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const rpc = useRpc<UiRpcContract>();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await rpc.call("runs.cancel", { runId, reason: "Cancelled from the Computer view" });
      onChanged();
    } catch (cause) {
      setCancelError(errorMessage(cause));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section aria-labelledby="wf-selected" className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <h2 id="wf-selected" className="text-sm font-semibold text-foreground">
          Selected run {isController ? "(current controller)" : "(not controlling)"}
        </h2>
        <button type="button" onClick={onClose} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
          Clear selection
        </button>
      </div>
      {run === null ? (
        <p className="text-sm text-muted-foreground">Run {runId} was not found.</p>
      ) : (
        <>
          <RunSummary run={run} now={now} />
          {!TERMINAL_RUN_STATES.has(run.state) ? (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={cancelling}
              className="rounded-md border border-border px-3 py-1 text-sm text-destructive disabled:opacity-50"
            >
              Cancel run
            </button>
          ) : null}
          {cancelError !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {cancelError}
            </p>
          ) : null}
          <RunArtifacts run={run} />
        </>
      )}
    </section>
  );
}

function RunSummary({ run, now, onSelect }: { run: RunRecord; now: number; onSelect?: () => void }) {
  const elapsed = run.startedAt === null ? null : (run.finishedAt ?? now) - run.startedAt;
  const failed = run.checkpoints.filter((checkpoint) => checkpoint.outcome !== "pass").length;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={run.state === "passed" ? "ok" : TERMINAL_RUN_STATES.has(run.state) ? "warn" : "neutral"}>
          {RUN_STATE_LABEL[run.state] ?? run.state}
        </Badge>
        {onSelect ? (
          <button type="button" onClick={onSelect} className="font-mono text-foreground underline-offset-2 hover:underline">
            {run.runId}
          </button>
        ) : (
          <span className="font-mono text-foreground">{run.runId}</span>
        )}
        <span className="text-muted-foreground">thread {run.route.identity.threadId}</span>
        {elapsed !== null ? <span className="text-muted-foreground">{formatDuration(elapsed)}</span> : null}
      </div>
      <p className="line-clamp-2 text-muted-foreground">{run.route.goal}</p>
      <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        {run.currentActionId ? <span>Action {run.currentActionId}</span> : null}
        {run.currentCheckpointId ? <span>Checkpoint {run.currentCheckpointId}</span> : null}
        {run.checkpoints.length > 0 ? (
          <span>
            Checkpoints {run.checkpoints.length - failed}/{run.checkpoints.length} passed
          </span>
        ) : null}
        {run.cleanup.state === "incomplete" ? <span className="text-destructive">Cleanup incomplete</span> : null}
      </div>
      {run.error !== null ? <p className="text-xs text-destructive">{run.error.message}</p> : null}
    </div>
  );
}

function RunArtifacts({ run }: { run: RunRecord }) {
  const rpc = useRpc<UiRpcContract>();
  const threadId = run.route.identity.threadId;
  const [artifacts, setArtifacts] = useState<ArtifactRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc
      .call("artifacts.list", { threadId, runId: run.runId, cursor: null, limit: 24 })
      .then((page) => !cancelled && setArtifacts(page.artifacts))
      .catch((cause: unknown) => !cancelled && setError(errorMessage(cause)));
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, run.runId, run.revision]);

  if (error !== null) return <p className="text-sm text-destructive">Artifacts unavailable: {error}</p>;
  if (artifacts === null) return <p className="text-sm text-muted-foreground">Loading artifacts…</p>;
  if (artifacts.length === 0) return <p className="text-sm text-muted-foreground">No artifacts for this run.</p>;
  return (
    <div className="space-y-2">
      {artifacts.map((artifact) => (
        <ArtifactCard key={artifact.artifactId} artifact={artifact} threadId={threadId} />
      ))}
    </div>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-5">{children}</div>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="status" className="flex h-full min-h-0 flex-col items-center justify-center overflow-auto bg-sidebar p-6 text-center text-sidebar-foreground">
      <Icon name="Laptop" aria-hidden="true" className="mb-3 size-6 text-muted-foreground" />
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "neutral"; children: React.ReactNode }) {
  const toneClass =
    tone === "ok"
      ? "border-border text-foreground"
      : tone === "warn"
        ? "border-destructive/40 text-destructive"
        : "border-border text-muted-foreground";
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${toneClass}`}>{children}</span>;
}
