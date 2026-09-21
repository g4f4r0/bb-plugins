import { Effect } from "effect";

import type {
  ActionIntent,
  AdapterExecutionContext,
  AdapterObservation,
  AdapterOutcome,
  AutomationAdapter,
} from "../contracts/adapter.js";
import type { Checkpoint, WayfinderRoute } from "../contracts/route.js";
import type { CheckpointResult } from "../contracts/run.js";
import { verifyObservationCheckpoint } from "../core/checkpoints.js";
import { errorMessage, wayfinderError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import type { DataResolver } from "../fs/scoped-filesystem.js";
import { defaultDataResolver } from "../fs/scoped-filesystem.js";
import { assertActionAllowed } from "../policy/actions.js";
import { assertAllowedUrl, assertResolvedUrlAllowed } from "../policy/origins.js";
import { isSensitiveLabel } from "../policy/privacy.js";
import type { CdpEvent, CdpTransport } from "./cdp-client.js";
import { WebSocketCdpTransport } from "./cdp-client.js";
import { adapterEffect, abortableDelay, isWayfinderError } from "./effect.js";

interface AxValue { readonly value?: unknown }
interface AxProperty { readonly name?: string; readonly value?: AxValue }
interface AxNode {
  readonly nodeId?: string;
  readonly backendDOMNodeId?: number;
  readonly role?: AxValue;
  readonly name?: AxValue;
  readonly value?: AxValue;
  readonly properties?: readonly AxProperty[];
}

interface BrowserTargetBinding {
  readonly targetId: string;
  readonly backendNodeId: number;
  readonly nodeId: string;
}

export interface BrowserAdapterOptions {
  readonly route: WayfinderRoute;
  readonly hostId: string;
  readonly tabId: string;
  readonly resourceGeneration: string;
  readonly transport: CdpTransport;
  readonly sessionId?: string;
  readonly resolveData?: DataResolver;
  readonly downloadRoots?: ReadonlyMap<string, string>;
  readonly settleMs?: number;
}

export interface FortressConnectionOptions extends Omit<BrowserAdapterOptions, "transport" | "sessionId"> {
  readonly wsEndpoint: string;
  readonly signal: AbortSignal;
}

const CLICK_ROLES = new Set(["button", "link", "checkbox", "radio", "menuitem", "tab", "option", "switch"]);
const TYPE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

function axString(value: AxValue | undefined): string {
  return typeof value?.value === "string" ? value.value : value?.value == null ? "" : String(value.value);
}

function propertyBoolean(node: AxNode, name: string): boolean | undefined {
  const value = node.properties?.find((property) => property.name === name)?.value?.value;
  return typeof value === "boolean" ? value : undefined;
}

function bounded(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

export class BrowserAdapter implements AutomationAdapter {
  readonly kind = "browser" as const;
  readonly #route: WayfinderRoute;
  readonly #hostId: string;
  readonly #tabId: string;
  readonly #generation: string;
  readonly #transport: CdpTransport;
  readonly #sessionId?: string;
  readonly #resolveData: DataResolver;
  readonly #downloadRoots: ReadonlyMap<string, string>;
  readonly #settleMs: number;
  readonly #bindings = new Map<string, BrowserTargetBinding>();
  readonly #networkOutcomes: Array<{ method: string; url: string; status: number }> = [];
  readonly #requestMethods = new Map<string, string>();
  readonly #protectedTargetIds = new Set<string>();
  readonly #disposeEvent: () => void;
  #closed = false;

  constructor(options: BrowserAdapterOptions) {
    this.#route = options.route;
    this.#hostId = options.hostId;
    this.#tabId = options.tabId;
    this.#generation = options.resourceGeneration;
    this.#transport = options.transport;
    this.#sessionId = options.sessionId;
    this.#resolveData = options.resolveData ?? defaultDataResolver;
    this.#downloadRoots = options.downloadRoots ?? new Map();
    this.#settleMs = options.settleMs ?? 80;
    this.#disposeEvent = this.#transport.onEvent((event) => this.#event(event));
  }

  static async connectFortress(options: FortressConnectionOptions): Promise<BrowserAdapter> {
    const transport = await WebSocketCdpTransport.connect(options.wsEndpoint, { signal: options.signal });
    try {
      const attached = await transport.command<{ sessionId?: string }>(
        "Target.attachToTarget",
        { targetId: options.tabId, flatten: true },
        options.signal,
      );
      if (typeof attached.sessionId !== "string") {
        throw wayfinderError("provider-unavailable", "observe", "Fortress did not return a target session");
      }
      const adapter = new BrowserAdapter({ ...options, transport, sessionId: attached.sessionId });
      await adapter.#initialize(options.signal);
      return adapter;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  /** Capture the bound viewport for the host live view/evidence path. */
  async captureScreenshot(signal: AbortSignal): Promise<Buffer> {
    this.#assertContext({ signal, expectedHostId: this.#hostId }, "observe");
    const result = await this.#command<{ data?: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, signal);
    if (typeof result.data !== "string" || result.data.length === 0) throw wayfinderError("provider-unavailable", "capture", "Fortress returned an empty screenshot");
    return Buffer.from(result.data, "base64");
  }

  observe(context: AdapterExecutionContext) {
    return adapterEffect("observe", () => this.#observe(context));
  }

  execute(intent: ActionIntent, context: AdapterExecutionContext) {
    return adapterEffect("act", () => this.#execute(intent, context));
  }

  verify(checkpoint: Checkpoint, observation: AdapterObservation, context: AdapterExecutionContext) {
    return adapterEffect("verify", () => this.#verify(checkpoint, observation, context));
  }

  close(context: AdapterExecutionContext) {
    return adapterEffect("cleanup", async () => {
      if (context.expectedHostId !== this.#hostId) throw wayfinderError("host-mismatch", "cleanup", "Browser belongs to another host");
      if (this.#closed) return;
      this.#closed = true;
      this.#disposeEvent();
      await this.#transport.close();
    });
  }

  async #initialize(signal: AbortSignal): Promise<void> {
    if (this.#route.browser.allowPopups) {
      throw wayfinderError("setup-required", "observe", "Popup control is not supported by the bounded Fortress adapter");
    }
    await Promise.all([
      this.#command("Page.enable", {}, signal),
      this.#command("DOM.enable", {}, signal),
      this.#command("Accessibility.enable", {}, signal),
      this.#command("Network.enable", { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 100_000 }, signal),
      this.#command("Fetch.enable", { patterns: [{ urlPattern: "http://*/*" }, { urlPattern: "https://*/*" }] }, signal),
      this.#transport.command("Target.setDiscoverTargets", { discover: true }, signal),
      this.#transport.command("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true }, signal),
    ]);
  }

  async #observe(context: AdapterExecutionContext): Promise<AdapterObservation> {
    this.#assertContext(context, "observe");
    const [tree, targetInfo] = await Promise.all([
      this.#command<{ nodes?: AxNode[] }>("Accessibility.getFullAXTree", { depth: 30 }, context.signal),
      this.#transport.command<{ targetInfo?: { targetId?: string; title?: string; url?: string } }>(
        "Target.getTargetInfo",
        { targetId: this.#tabId },
        context.signal,
      ),
    ]);
    const nodes = (tree.nodes ?? []).slice(0, 5_000);
    if (targetInfo.targetInfo?.targetId !== this.#tabId) {
      throw wayfinderError("stale-observation", "observe", "Fortress target identity changed", { retryable: true });
    }
    const targets: AdapterObservation["targets"] = [];
    const text: string[] = [];
    const nextBindings = new Map<string, BrowserTargetBinding>();
    for (const node of nodes) {
      const role = bounded(axString(node.role), 80).toLocaleLowerCase();
      const name = bounded(axString(node.name), 300);
      if ((role === "statictext" || role === "heading") && name.length > 0) text.push(name);
      if (node.backendDOMNodeId === undefined || node.nodeId === undefined || name.length === 0) continue;
      const operations: AdapterObservation["targets"][number]["allowedOperations"] = [];
      if (CLICK_ROLES.has(role)) operations.push("click");
      if (TYPE_ROLES.has(role)) operations.push("click", "type");
      if (role === "scrollbar") operations.push("scroll");
      if (operations.length === 0 || propertyBoolean(node, "disabled") === true) continue;
      const targetId = `browser_${sha256(`${node.backendDOMNodeId}:${role}:${name}`).slice(0, 24)}`;
      nextBindings.set(targetId, { targetId, backendNodeId: node.backendDOMNodeId, nodeId: node.nodeId });
      const rawValue = axString(node.value);
      targets.push({
        targetId,
        resourceGeneration: this.#generation,
        role,
        name,
        valueSummary: rawValue.length === 0 || isSensitiveLabel(name) || this.#protectedTargetIds.has(targetId) ? null : bounded(rawValue, 500),
        bounds: null,
        allowedOperations: [...new Set(operations)],
      });
      if (targets.length >= 1_000) break;
    }
    const title = bounded(targetInfo.targetInfo?.title ?? "", 500);
    const location = bounded(targetInfo.targetInfo?.url ?? "", 2_048) || null;
    const visibleText = bounded(text.join(" "), 32_000);
    const stateHash = sha256({ title, location, visibleText, targets });
    const changedTargetIds = targets
      .filter((target) => sha256(this.#bindings.get(target.targetId) ?? null) !== sha256(nextBindings.get(target.targetId)))
      .map((target) => target.targetId);
    this.#bindings.clear();
    for (const [id, binding] of nextBindings) this.#bindings.set(id, binding);
    return {
      identity: {
        adapter: "browser",
        hostId: this.#hostId,
        resourceId: this.#tabId,
        resourceGeneration: this.#generation,
        snapshotId: `snapshot_${stateHash.slice(0, 24)}`,
        observedAt: Date.now(),
      },
      title,
      location,
      text: visibleText,
      targets,
      stateHash,
      changedTargetIds,
      humanActivityDetected: false,
    };
  }

  async #execute(intent: ActionIntent, context: AdapterExecutionContext): Promise<AdapterOutcome> {
    const current = await this.#observe(context);
    const target = assertActionAllowed(this.#route, intent, current);
    let dispatchedAt: number | null = null;
    try {
      const action = intent.action;
      if (["browser.click", "browser.type", "browser.select", "browser.download"].includes(action.kind)) {
        let origin: string | null = null;
        try { origin = current.location === null ? null : new URL(current.location).origin; } catch { /* denied below */ }
        const fixture = origin !== null && this.#route.browser.navigationOrigins.some((entry) => entry.origin === origin && entry.purpose === "fixture");
        if (!fixture) throw wayfinderError("policy-denied", "act", "Browser mutations are limited to explicitly classified fixture origins in v1");
      }
      switch (action.kind) {
        case "browser.navigate":
          await assertResolvedUrlAllowed(this.#route, action.url, "navigation");
          dispatchedAt = Date.now();
          await this.#command("Page.navigate", { url: action.url }, context.signal);
          break;
        case "browser.click":
          dispatchedAt = Date.now();
          await this.#click(action.target.targetId, context.signal);
          break;
        case "browser.type": {
          const binding = this.#binding(action.target.targetId);
          const value = await this.#resolveData(action.value, context.signal);
          if (action.value.kind === "protected-ref") this.#protectedTargetIds.add(action.target.targetId);
          dispatchedAt = Date.now();
          await this.#command("DOM.focus", { backendNodeId: binding.backendNodeId }, context.signal);
          await this.#command("Input.insertText", { text: value }, context.signal);
          break;
        }
        case "browser.scroll": {
          const deltaY = (action.direction === "down" ? 1 : -1) * (action.amount === "page" ? 640 : 180);
          dispatchedAt = Date.now();
          await this.#command("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY }, context.signal);
          break;
        }
        case "browser.back": {
          const history = await this.#command<{ currentIndex?: number; entries?: Array<{ id?: number }> }>("Page.getNavigationHistory", {}, context.signal);
          const entry = history.entries?.[(history.currentIndex ?? 0) - 1];
          if (entry?.id === undefined) return this.#outcome(intent.actionId, "no-op", null, "No previous browser history entry", current, null);
          dispatchedAt = Date.now();
          await this.#command("Page.navigateToHistoryEntry", { entryId: entry.id }, context.signal);
          break;
        }
        case "browser.download": {
          if (!this.#route.browser.allowDownloads) throw wayfinderError("policy-denied", "act", "Downloads are disabled by the route");
          const path = this.#downloadRoots.get(action.outputRootId);
          if (path === undefined) throw wayfinderError("policy-denied", "act", "Download output root is unavailable");
          await this.#transport.command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path, eventsEnabled: true }, context.signal);
          dispatchedAt = Date.now();
          try { await this.#click(action.target.targetId, context.signal); }
          finally { await this.#transport.command("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true }, new AbortController().signal).catch(() => undefined); }
          break;
        }
        case "browser.select":
          throw wayfinderError("setup-required", "act", "Native select control execution is not supported by the CDP adapter yet");
        default:
          throw wayfinderError("policy-denied", "act", `Browser adapter cannot execute ${action.kind}`);
      }
      await abortableDelay(this.#settleMs, context.signal);
      const post = await this.#observe(context);
      return this.#outcome(intent.actionId, "completed", dispatchedAt, `Executed ${intent.action.kind}`, post, null);
    } catch (error) {
      if (dispatchedAt !== null) {
        return this.#outcome(intent.actionId, "uncertain", dispatchedAt, "Browser mutation outcome is uncertain", null,
          wayfinderError("uncertain-mutation", "act", isWayfinderError(error) ? error.message : errorMessage(error)));
      }
      throw error;
    }
  }

  async #verify(checkpoint: Checkpoint, observation: AdapterObservation, context: AdapterExecutionContext): Promise<CheckpointResult> {
    this.#assertContext(context, "verify");
    if (checkpoint.kind === "url") {
      let pass = false;
      try {
        const url = new URL(observation.location ?? "");
        pass = url.origin === checkpoint.origin && (checkpoint.match === "exact" ? url.pathname === checkpoint.pathname : url.pathname.startsWith(checkpoint.pathname));
      } catch { /* malformed observations fail */ }
      return { checkpoint, outcome: pass ? "pass" : "fail", observedAt: Date.now(), summary: pass ? "Browser URL matches" : "Browser URL differs", evidenceArtifactIds: [] };
    }
    if (checkpoint.kind === "network-outcome") {
      const pass = this.#networkOutcomes.some((entry) => {
        const url = new URL(entry.url);
        return entry.method === checkpoint.method && url.origin === checkpoint.origin && url.pathname === checkpoint.pathname && entry.status === checkpoint.status;
      });
      return { checkpoint, outcome: pass ? "pass" : "unknown", observedAt: Date.now(), summary: pass ? "Observed matching network outcome" : "Matching network outcome was not observed", evidenceArtifactIds: [] };
    }
    return verifyObservationCheckpoint(checkpoint, observation, this.#resolveData, context.signal);
  }

  async #click(targetId: string, signal: AbortSignal): Promise<void> {
    const binding = this.#binding(targetId);
    const model = await this.#command<{ model?: { content?: number[]; border?: number[] } }>("DOM.getBoxModel", { backendNodeId: binding.backendNodeId }, signal);
    const quad = model.model?.content ?? model.model?.border;
    if (!Array.isArray(quad) || quad.length < 8) throw wayfinderError("ambiguous-target", "act", "Browser target has no usable geometry");
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const x = xs.reduce((sum, value) => sum + value, 0) / 4;
    const y = ys.reduce((sum, value) => sum + value, 0) / 4;
    await this.#command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, signal);
    await this.#command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, signal);
  }

  #binding(targetId: string): BrowserTargetBinding {
    const binding = this.#bindings.get(targetId);
    if (binding === undefined) throw wayfinderError("stale-observation", "act", "Browser target binding is stale", { retryable: true });
    return binding;
  }

  #assertContext(context: AdapterExecutionContext, phase: "observe" | "verify"): void {
    if (this.#closed) throw wayfinderError("provider-unavailable", phase, "Browser adapter is closed");
    if (context.expectedHostId !== this.#hostId) throw wayfinderError("host-mismatch", phase, "Browser belongs to another host");
    if (context.signal.aborted) throw wayfinderError("cancelled", phase, "Browser operation was cancelled");
  }

  #command<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    return this.#transport.command<T>(method, params, signal, this.#sessionId);
  }

  #event(event: CdpEvent): void {
    if (event.sessionId !== undefined && this.#sessionId !== undefined && event.sessionId !== this.#sessionId) return;
    if (event.method === "Target.targetCreated") {
      const info = event.params.targetInfo as Record<string, unknown> | undefined;
      if (info?.openerId === this.#tabId && typeof info.targetId === "string") {
        void this.#transport.command("Target.closeTarget", { targetId: info.targetId }, new AbortController().signal).catch(() => undefined);
      }
    }
    if (event.method === "Network.requestWillBeSent") {
      const requestId = event.params.requestId;
      const request = event.params.request as Record<string, unknown> | undefined;
      if (typeof requestId === "string" && typeof request?.method === "string") {
        this.#requestMethods.set(requestId, request.method);
        if (this.#requestMethods.size > 500) this.#requestMethods.delete(this.#requestMethods.keys().next().value as string);
      }
    }
    if (event.method === "Network.responseReceived") {
      const response = event.params.response as Record<string, unknown> | undefined;
      const requestId = event.params.requestId;
      const url = response?.url;
      const status = response?.status;
      const method = typeof requestId === "string" ? this.#requestMethods.get(requestId) : undefined;
      if (typeof url === "string" && typeof status === "number" && typeof method === "string") {
        this.#networkOutcomes.push({ method, url, status });
        if (this.#networkOutcomes.length > 200) this.#networkOutcomes.shift();
      }
    }
    if (event.method === "Fetch.requestPaused") {
      const requestId = event.params.requestId;
      const request = event.params.request as Record<string, unknown> | undefined;
      const url = request?.url;
      if (typeof requestId !== "string" || typeof url !== "string") return;
      const signal = new AbortController().signal;
      void assertResolvedUrlAllowed(this.#route, url, event.params.resourceType === "Document" ? "navigation" : "resource")
        .then(() => this.#command("Fetch.continueRequest", { requestId }, signal))
        .catch(() => this.#command("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, signal).catch(() => undefined));
    }
  }

  #outcome(actionId: string, state: AdapterOutcome["state"], dispatchedAt: number | null, summary: string, postObservation: AdapterObservation | null, error: AdapterOutcome["error"]): AdapterOutcome {
    return { actionId, state, dispatchedAt, outcomeRecordedAt: Date.now(), summary, postObservation, error };
  }
}
