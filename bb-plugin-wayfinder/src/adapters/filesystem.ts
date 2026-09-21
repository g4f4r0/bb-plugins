import { lstat } from "node:fs/promises";

import type { ActionIntent, AdapterExecutionContext, AdapterObservation, AdapterOutcome, AutomationAdapter } from "../contracts/adapter.js";
import type { Checkpoint, WayfinderRoute } from "../contracts/route.js";
import type { CheckpointResult } from "../contracts/run.js";
import { wayfinderError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import type { DataResolver } from "../fs/scoped-filesystem.js";
import { defaultDataResolver, ScopedFilesystem } from "../fs/scoped-filesystem.js";
import { assertActionAllowed } from "../policy/actions.js";
import { adapterEffect } from "./effect.js";

export interface FilesystemAdapterOptions {
  readonly route: WayfinderRoute;
  readonly hostId: string;
  readonly resourceGeneration: string;
  readonly filesystem?: ScopedFilesystem;
  readonly resolveData?: DataResolver;
}

export class FilesystemAdapter implements AutomationAdapter {
  readonly kind = "filesystem" as const;
  readonly #options: FilesystemAdapterOptions;
  readonly #filesystem: ScopedFilesystem;
  readonly #resolveData: DataResolver;
  #closed = false;

  constructor(options: FilesystemAdapterOptions) {
    this.#options = options;
    this.#filesystem = options.filesystem ?? new ScopedFilesystem(options.route.filesystem.roots);
    this.#resolveData = options.resolveData ?? defaultDataResolver;
  }

  observe(context: AdapterExecutionContext) { return adapterEffect("observe", () => this.#observe(context)); }
  execute(intent: ActionIntent, context: AdapterExecutionContext) { return adapterEffect("act", () => this.#execute(intent, context)); }
  verify(checkpoint: Checkpoint, _observation: AdapterObservation, context: AdapterExecutionContext) {
    return adapterEffect("verify", () => this.#verify(checkpoint, context));
  }
  close(context: AdapterExecutionContext) {
    return adapterEffect("cleanup", async () => {
      this.#assertContext(context, "cleanup");
      this.#closed = true;
    });
  }

  async #observe(context: AdapterExecutionContext): Promise<AdapterObservation> {
    this.#assertContext(context, "observe");
    const roots = await Promise.all(this.#options.route.filesystem.roots.map(async (root) => {
      try {
        const stat = await lstat(root.absolutePath);
        return { rootId: root.rootId, available: stat.isDirectory(), modifiedAt: Math.trunc(stat.mtimeMs) };
      } catch {
        return { rootId: root.rootId, available: false, modifiedAt: null };
      }
    }));
    const stateHash = sha256(roots);
    return {
      identity: {
        adapter: "filesystem",
        hostId: this.#options.hostId,
        resourceId: "scoped_filesystem",
        resourceGeneration: this.#options.resourceGeneration,
        snapshotId: `snapshot_${stateHash.slice(0, 24)}`,
        observedAt: Date.now(),
      },
      title: "Scoped filesystem",
      location: null,
      text: roots.map((root) => `${root.rootId}:${root.available ? "available" : "unavailable"}`).join(" "),
      targets: [],
      stateHash,
      changedTargetIds: [],
      humanActivityDetected: false,
    };
  }

  async #execute(intent: ActionIntent, context: AdapterExecutionContext): Promise<AdapterOutcome> {
    const current = await this.#observe(context);
    assertActionAllowed(this.#options.route, intent, current);
    const action = intent.action;
    let summary: string;
    switch (action.kind) {
      case "filesystem.read": {
        const value = await this.#filesystem.read(action.rootId, action.relativePath, context.signal);
        summary = `Read verified scoped file (${value.byteLength} bytes)`;
        break;
      }
      case "filesystem.list": {
        const entries = await this.#filesystem.list(action.rootId, action.relativePath);
        summary = `Listed scoped directory (${entries.length} entries)`;
        break;
      }
      case "filesystem.verify": {
        const result = await this.#filesystem.verify(action.checkpoint, this.#resolveData, context.signal);
        summary = `${result.outcome}: ${result.summary}`;
        break;
      }
      default:
        throw wayfinderError("policy-denied", "act", `Filesystem adapter cannot execute ${action.kind}`);
    }
    const post = await this.#observe(context);
    return {
      actionId: intent.actionId,
      state: "completed",
      dispatchedAt: Date.now(),
      outcomeRecordedAt: Date.now(),
      summary,
      postObservation: post,
      error: null,
    };
  }

  async #verify(checkpoint: Checkpoint, context: AdapterExecutionContext): Promise<CheckpointResult> {
    this.#assertContext(context, "verify");
    return this.#filesystem.verify(checkpoint, this.#resolveData, context.signal);
  }

  #assertContext(context: AdapterExecutionContext, phase: "observe" | "verify" | "cleanup"): void {
    if (this.#closed) throw wayfinderError("provider-unavailable", phase, "Filesystem adapter is closed");
    if (context.expectedHostId !== this.#options.hostId) throw wayfinderError("host-mismatch", phase, "Filesystem belongs to another host");
    if (context.signal.aborted) throw wayfinderError("cancelled", phase, "Filesystem operation cancelled");
  }
}
