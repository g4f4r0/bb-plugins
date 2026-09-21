import type { ActionIntent, AdapterExecutionContext, AdapterObservation, AdapterOutcome, AutomationAdapter } from "../contracts/adapter.js";
import type { Checkpoint, WayfinderRoute } from "../contracts/route.js";
import type { CheckpointResult } from "../contracts/run.js";
import { verifyObservationCheckpoint } from "../core/checkpoints.js";
import { wayfinderError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import type { DataResolver } from "../fs/scoped-filesystem.js";
import { defaultDataResolver } from "../fs/scoped-filesystem.js";
import { assertActionAllowed } from "../policy/actions.js";
import { isSensitiveLabel } from "../policy/privacy.js";
import { adapterEffect } from "./effect.js";
import type { CuaToolResult, CuaTransport } from "./cua-client.js";
import { basename } from "node:path";

interface CuaElement {
  readonly element_index?: number;
  readonly element_token?: string;
  readonly role?: string;
  readonly label?: string;
  readonly value?: unknown;
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly actions?: string[];
  readonly frame?: { x?: number; y?: number; w?: number; h?: number };
}

interface Binding { readonly elementIndex: number; readonly elementToken?: string; readonly snapshotId: string }

export interface CuaAdapterOptions {
  readonly route: WayfinderRoute;
  readonly hostId: string;
  readonly appId: string;
  readonly pid: number;
  readonly windowId: number;
  readonly resourceGeneration: string;
  readonly transport: CuaTransport;
  readonly resolveData?: DataResolver;
  readonly shortcuts?: ReadonlyMap<string, readonly string[]>;
  /** Trusted integration classification; native mutations fail closed unless true. */
  readonly syntheticFixture?: boolean;
}

function content(result: CuaToolResult): Record<string, unknown> {
  return result.structuredContent ?? {};
}

function allowedOperations(element: CuaElement): AdapterObservation["targets"][number]["allowedOperations"] {
  const role = (element.role ?? "").toLocaleLowerCase();
  const ops: AdapterObservation["targets"][number]["allowedOperations"] = [];
  if (["button", "link", "checkbox", "radio", "menu item", "menuitem", "tab"].includes(role)) ops.push("click");
  if (["text", "textbox", "entry", "searchbox", "combobox"].includes(role)) ops.push("click", "type");
  if (role.includes("menu")) ops.push("invoke-menu");
  if (role.includes("scroll")) ops.push("scroll");
  return [...new Set(ops)];
}

export class CuaAdapter implements AutomationAdapter {
  readonly kind = "desktop" as const;
  readonly #options: CuaAdapterOptions;
  readonly #resolveData: DataResolver;
  readonly #bindings = new Map<string, Binding>();
  readonly #protectedTargetIds = new Set<string>();
  #closed = false;

  constructor(options: CuaAdapterOptions) {
    const allowed = options.route.desktop.applications.find((app) => app.appId === options.appId);
    if (allowed === undefined) throw wayfinderError("policy-denied", "observe", "Desktop application is not allowed by the route");
    this.#options = options;
    this.#resolveData = options.resolveData ?? defaultDataResolver;
  }

  observe(context: AdapterExecutionContext) { return adapterEffect("observe", () => this.#observe(context)); }
  execute(intent: ActionIntent, context: AdapterExecutionContext) { return adapterEffect("act", () => this.#execute(intent, context)); }
  verify(checkpoint: Checkpoint, observation: AdapterObservation, context: AdapterExecutionContext) {
    return adapterEffect("verify", () => this.#verify(checkpoint, observation, context));
  }
  close(context: AdapterExecutionContext) {
    return adapterEffect("cleanup", async () => {
      if (this.#closed) return;
      this.#assertContext(context, "cleanup");
      await this.#options.transport.close(context.signal);
      this.#closed = true;
    });
  }

  async #observe(context: AdapterExecutionContext): Promise<AdapterObservation> {
    this.#assertContext(context, "observe");
    const [windowsResult, result] = await Promise.all([
      this.#options.transport.call("list_windows", { pid: this.#options.pid, on_screen_only: true }, context.signal),
      this.#options.transport.call("get_window_state", {
      pid: this.#options.pid,
      window_id: this.#options.windowId,
      include_screenshot: false,
      include_accessibility_tree: true,
      max_elements: 1_000,
      max_depth: 30,
      }, context.signal),
    ]);
    const allowedApp = this.#options.route.desktop.applications.find((app) => app.appId === this.#options.appId)!;
    const windowsData = content(windowsResult);
    const windows = Array.isArray(windowsData.windows) ? windowsData.windows as Array<Record<string, unknown>> : [];
    const boundWindow = windows.find((window) => Number(window.pid) === this.#options.pid && Number(window.window_id ?? window.id) === this.#options.windowId);
    if (boundWindow === undefined) throw wayfinderError("stale-observation", "observe", "The exact Cua window is no longer visible", { retryable: true });
    const liveTitle = String(boundWindow.title ?? boundWindow.window_title ?? "");
    const titleMatches = allowedApp.titleMatch === "exact" ? liveTitle === allowedApp.windowTitle : liveTitle.startsWith(allowedApp.windowTitle);
    const executable = String(boundWindow.executable ?? boundWindow.process_name ?? boundWindow.app_name ?? "");
    if (!titleMatches || (executable.length > 0 && basename(executable) !== basename(allowedApp.executable))) {
      throw wayfinderError("policy-denied", "observe", "The live Cua window does not match the allowed application identity");
    }
    const data = content(result);
    const rawElements = Array.isArray(data.elements) ? data.elements as CuaElement[] : [];
    const snapshotIdRaw = typeof data.snapshot_id === "string" ? data.snapshot_id : `s${sha256(rawElements).slice(0, 8)}`;
    const snapshotId = `snapshot_${sha256(snapshotIdRaw).slice(0, 24)}`;
    const targets: AdapterObservation["targets"] = [];
    const bindings = new Map<string, Binding>();
    for (const element of rawElements.slice(0, 1_000)) {
      if (!Number.isInteger(element.element_index) || element.enabled === false) continue;
      const operations = allowedOperations(element);
      const name = String(element.label ?? "").replace(/\s+/gu, " ").trim().slice(0, 300);
      if (operations.length === 0 || name.length === 0) continue;
      const targetId = `desktop_${sha256(`${element.element_index}:${element.role ?? ""}:${name}`).slice(0, 24)}`;
      bindings.set(targetId, {
        elementIndex: element.element_index!,
        ...(typeof element.element_token === "string" ? { elementToken: element.element_token } : {}),
        snapshotId: snapshotIdRaw,
      });
      const frame = element.frame;
      const bounds = frame !== undefined && [frame.x, frame.y, frame.w, frame.h].every((value) => typeof value === "number") && frame.w! > 0 && frame.h! > 0
        ? { x: frame.x!, y: frame.y!, width: frame.w!, height: frame.h! }
        : null;
      const value = element.value == null ? "" : String(element.value);
      targets.push({
        targetId,
        resourceGeneration: this.#options.resourceGeneration,
        role: String(element.role ?? "unknown").slice(0, 80),
        name,
        valueSummary: value.length === 0 || isSensitiveLabel(name) || this.#protectedTargetIds.has(targetId) ? null : value.slice(0, 500),
        bounds,
        allowedOperations: operations,
      });
    }
    this.#bindings.clear();
    for (const [id, binding] of bindings) this.#bindings.set(id, binding);
    const title = String(data.window_title ?? data.title ?? "").slice(0, 500);
    const text = targets.map((target) => target.name).join(" ").slice(0, 32_000);
    const stateHash = sha256({ title, text, targets });
    return {
      identity: {
        adapter: "desktop",
        hostId: this.#options.hostId,
        resourceId: `window_${this.#options.windowId}`,
        resourceGeneration: this.#options.resourceGeneration,
        snapshotId,
        observedAt: Date.now(),
      },
      title,
      location: null,
      text,
      targets,
      stateHash,
      changedTargetIds: targets.map((target) => target.targetId),
      humanActivityDetected: false,
    };
  }

  async #execute(intent: ActionIntent, context: AdapterExecutionContext): Promise<AdapterOutcome> {
    const current = await this.#observe(context);
    assertActionAllowed(this.#options.route, intent, current);
    const action = intent.action;
    if (["desktop.click", "desktop.type", "desktop.shortcut", "desktop.invoke-menu"].includes(action.kind) && this.#options.syntheticFixture !== true) {
      throw wayfinderError("policy-denied", "act", "Native mutations are limited to integration-classified synthetic fixtures in v1");
    }
    let dispatchedAt: number | null = null;
    const exactWindow = { pid: this.#options.pid, window_id: this.#options.windowId };
    const callTarget = (targetId: string) => {
      const binding = this.#bindings.get(targetId);
      if (binding === undefined) throw wayfinderError("stale-observation", "act", "Native target binding is stale", { retryable: true });
      return {
        ...exactWindow,
        ...(binding.elementToken === undefined ? { element_index: binding.elementIndex, snapshot_id: binding.snapshotId } : { element_token: binding.elementToken }),
      };
    };
    switch (action.kind) {
      case "desktop.activate":
        if (action.appId !== this.#options.appId || action.resourceGeneration !== this.#options.resourceGeneration) throw wayfinderError("stale-observation", "act", "Desktop activation binding is stale");
        dispatchedAt = Date.now();
        await this.#options.transport.call("bring_to_front", exactWindow, context.signal);
        break;
      case "desktop.click":
        dispatchedAt = Date.now();
        await this.#options.transport.call("click", callTarget(action.target.targetId), context.signal);
        break;
      case "desktop.type": {
        const value = await this.#resolveData(action.value, context.signal);
        if (action.value.kind === "protected-ref") this.#protectedTargetIds.add(action.target.targetId);
        dispatchedAt = Date.now();
        await this.#options.transport.call("type_text", { ...callTarget(action.target.targetId), text: value, delivery_mode: "background" }, context.signal);
        break;
      }
      case "desktop.scroll":
        dispatchedAt = Date.now();
        await this.#options.transport.call("scroll", { ...callTarget(action.target.targetId), direction: action.direction, by: action.amount === "page" ? "page" : "line", amount: action.amount === "page" ? 1 : 3 }, context.signal);
        break;
      case "desktop.shortcut": {
        const keys = this.#options.shortcuts?.get(action.shortcutId);
        if (keys === undefined) throw wayfinderError("policy-denied", "act", "Desktop shortcut is not in the trusted shortcut registry");
        dispatchedAt = Date.now();
        await this.#options.transport.call("hotkey", { ...exactWindow, keys: [...keys], delivery_mode: "background" }, context.signal);
        break;
      }
      case "desktop.invoke-menu": {
        const target = current.targets.find((candidate) => candidate.targetId === action.target.targetId)!;
        dispatchedAt = Date.now();
        await this.#options.transport.call("invoke_menu", { ...exactWindow, path: [target.name] }, context.signal);
        break;
      }
      default:
        throw wayfinderError("policy-denied", "act", `Cua adapter cannot execute ${action.kind}`);
    }
    const post = await this.#observe(context);
    return { actionId: intent.actionId, state: "completed", dispatchedAt, outcomeRecordedAt: Date.now(), summary: `Executed ${action.kind}`, postObservation: post, error: null };
  }

  async #verify(checkpoint: Checkpoint, observation: AdapterObservation, context: AdapterExecutionContext): Promise<CheckpointResult> {
    this.#assertContext(context, "verify");
    return verifyObservationCheckpoint(checkpoint, observation, this.#resolveData, context.signal);
  }

  #assertContext(context: AdapterExecutionContext, phase: "observe" | "verify" | "cleanup"): void {
    if (this.#closed) throw wayfinderError("provider-unavailable", phase, "Cua adapter is closed");
    if (context.expectedHostId !== this.#options.hostId) throw wayfinderError("host-mismatch", phase, "Cua window belongs to another host");
    if (context.signal.aborted) throw wayfinderError("cancelled", phase, "Cua operation cancelled");
  }
}
