import type { ActionIntent, AdapterExecutionContext, AdapterObservation, AdapterOutcome, AutomationAdapter } from "../contracts/adapter.js";
import type { Checkpoint, WayfinderRoute } from "../contracts/route.js";
import type { CheckpointResult } from "../contracts/run.js";
import type { DesktopRuntime, DesktopWindow } from "../core/desktop-runtime.js";
import type { ControlGate } from "../core/control-gate.js";
import { sha256 } from "../core/hash.js";
import { wayfinderError } from "../core/errors.js";
import { assertActionAllowed } from "../policy/actions.js";
import { verifyObservationCheckpoint, resolveSyntheticOnly } from "../core/checkpoints.js";
import { abortableDelay, adapterEffect } from "./effect.js";

interface CuaElement {
  element_index?: unknown;
  parent_index?: unknown;
  element_token?: unknown;
  label?: unknown;
  role?: unknown;
  enabled?: unknown;
  actions?: unknown;
  frame?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
}

/** Native Cua AT-SPI targets. Jev sees labels, never raw coordinates or tool arguments. */
export class DesktopAutomationAdapter implements AutomationAdapter {
  readonly kind = "desktop" as const;
  readonly #runtime: DesktopRuntime;
  readonly #route: WayfinderRoute;
  readonly #window: DesktopWindow;
  readonly #hostId: string;
  readonly #controlGate: ControlGate;
  readonly #generation: string;
  #tokens = new Map<string, string>();

  constructor(options: { runtime: DesktopRuntime; route: WayfinderRoute; window: DesktopWindow; hostId: string; controlGate: ControlGate }) {
    this.#runtime = options.runtime;
    this.#route = options.route;
    this.#window = options.window;
    this.#hostId = options.hostId;
    this.#controlGate = options.controlGate;
    this.#generation = `desktop_${options.window.pid}_${options.window.windowId}`;
  }

  observe(context: AdapterExecutionContext) { return adapterEffect("observe", () => this.#observe(context)); }
  execute(intent: ActionIntent, context: AdapterExecutionContext) { return adapterEffect("act", () => this.#controlGate.runAgent(context.signal, () => this.#execute(intent, context))); }
  verify(checkpoint: Checkpoint, observation: AdapterObservation, context: AdapterExecutionContext) {
    return adapterEffect("verify", () => verifyObservationCheckpoint(checkpoint, observation, resolveSyntheticOnly, context.signal));
  }
  close(_context: AdapterExecutionContext) { return adapterEffect("cleanup", async () => { this.#tokens.clear(); }); }

  async #observe(context: AdapterExecutionContext): Promise<AdapterObservation> {
    if (context.expectedHostId !== this.#hostId) throw wayfinderError("host-mismatch", "observe", "Desktop host changed");
    const { pid, windowId } = this.#window;
    const data = await this.#runtime.windowState(pid, windowId, context.signal);
    const title = String(data.window_title ?? "").slice(0, 500);
    const elements = data.elements as CuaElement[];
    const windowFrame = data.window_bounds as { x?: number; y?: number; width?: number; height?: number } | undefined;
    const left = typeof windowFrame?.x === "number" ? windowFrame.x : this.#window.x;
    const top = typeof windowFrame?.y === "number" ? windowFrame.y : this.#window.y;
    const right = left + (typeof windowFrame?.width === "number" ? windowFrame.width : this.#window.width);
    const bottom = top + (typeof windowFrame?.height === "number" ? windowFrame.height : this.#window.height);
    const text = [title, ...elements.map((element) => typeof element.label === "string" ? element.label : "").filter(Boolean)].join(" ").slice(0, 32_000);
    const allow = this.#route.desktop.allowedTargetNames?.map((name) => name.toLocaleLowerCase());
    const modal = elements.find((element) => ["alert", "dialog"].includes(String(element.role)) && element.frame &&
      typeof element.frame.w === "number" && element.frame.w > 100 && typeof element.frame.h === "number" && element.frame.h > 100);
    const byIndex = new Map(elements.map((element) => [element.element_index, element]));
    const inModal = (element: CuaElement) => {
      if (!modal) return true;
      let parent = element.parent_index;
      for (let depth = 0; depth < 32 && typeof parent === "number"; depth += 1) {
        if (parent === modal.element_index) return true;
        parent = byIndex.get(parent)?.parent_index;
      }
      return false;
    };
    const bindings = new Map<string, string>();
    const targets: AdapterObservation["targets"] = [];
    for (const element of elements) {
      const name = typeof element.label === "string" ? element.label.trim().slice(0, 300) : "";
      const role = typeof element.role === "string" ? element.role.toLowerCase().slice(0, 80) : "";
      const token = element.element_token;
      const frame = element.frame;
      if (!name || typeof token !== "string" || element.enabled === false || !frame ||
          ![frame.x, frame.y, frame.w, frame.h].every((value) => typeof value === "number" && Number.isFinite(value)) ||
          Number(frame.w) < 1 || Number(frame.h) < 1) continue;
      const x = Number(frame.x) + Number(frame.w) / 2, y = Number(frame.y) + Number(frame.h) / 2;
      if (x < left || x > right || y < top || y > bottom || !inModal(element)) continue;
      const actions = Array.isArray(element.actions) ? element.actions : [];
      const click = ["button", "radio button", "link", "check box"].includes(role) &&
        actions.some((action) => ["press", "click", "check", "jump"].includes(action));
      const scroll = actions.some((action) => ["scrollDown", "scrollForward"].includes(action)) &&
        ["section", "scroll pane", "panel"].includes(role);
      if ((!click || (allow && !allow.includes(name.toLocaleLowerCase()))) && !scroll) continue;
      const id = `ax_${element.element_index}`;
      bindings.set(id, token);
      targets.push({ targetId: id, resourceGeneration: this.#generation, role, name, valueSummary: null,
        bounds: { x: Number(frame.x), y: Number(frame.y), width: Number(frame.w), height: Number(frame.h) },
        allowedOperations: [...(click && (!allow || allow.includes(name.toLocaleLowerCase())) ? ["click" as const] : []), ...(scroll ? ["scroll" as const] : [])] });
      if (targets.length === 120) break;
    }
    if (!modal && this.#route.allowedActions.includes("desktop.scroll")) {
      targets.push({ targetId: "page_scroll", resourceGeneration: this.#generation, role: "scroll area", name: "Scroll visible application page",
        valueSummary: null, bounds: { x: left + Math.floor((right - left) / 2), y: top + Math.floor((bottom - top) / 2), width: 1, height: 1 },
        allowedOperations: ["scroll"] });
    }
    this.#tokens = bindings;
    const stateHash = sha256({ title, text, targets });
    return { identity: { adapter: "desktop", hostId: this.#hostId, resourceId: `window_${pid}_${windowId}`,
      resourceGeneration: this.#generation, snapshotId: `snapshot_${stateHash.slice(0, 24)}`, observedAt: Date.now() },
      title, location: null, text, targets, stateHash, changedTargetIds: targets.map((target) => target.targetId), humanActivityDetected: false };
  }

  async #execute(intent: ActionIntent, context: AdapterExecutionContext): Promise<AdapterOutcome> {
    const current = await this.#observe(context);
    const target = assertActionAllowed(this.#route, intent, current);
    if (!target || (intent.action.kind !== "desktop.click" && intent.action.kind !== "desktop.scroll"))
      throw wayfinderError("policy-denied", "act", "Only observed native click and scroll targets are supported");
    const token = this.#tokens.get(target.targetId);
    if (!token && target.targetId !== "page_scroll") throw wayfinderError("stale-observation", "act", "Cua target token expired before dispatch", { retryable: true });
    const dispatchedAt = Date.now();
    try {
      if (intent.action.kind === "desktop.click" && token) await this.#runtime.clickElement(this.#window.pid, this.#window.windowId, token, context.signal);
      else if (intent.action.kind === "desktop.scroll" && target.targetId === "page_scroll") {
        await this.#runtime.input({ kind: "wheel", x: this.#window.x + Math.floor(this.#window.width * 0.75),
          y: this.#window.y + Math.floor(this.#window.height * 0.55), deltaX: 0, deltaY: intent.action.direction === "down" ? 340 : -340 }, context.signal);
      } else if (intent.action.kind === "desktop.scroll" && token) await this.#runtime.scrollElement(this.#window.pid, this.#window.windowId, token, intent.action.direction, context.signal);
      else throw wayfinderError("policy-denied", "act", "Invalid native action target");
      await abortableDelay(350, context.signal);
      const post = await this.#observe(context);
      if (post.stateHash === current.stateHash) return { actionId: intent.actionId, state: "uncertain", dispatchedAt, outcomeRecordedAt: Date.now(),
        summary: "Native action was dispatched but no state change was observed; not replaying it", postObservation: post,
        error: wayfinderError("uncertain-mutation", "act", "Native action had no verified effect") };
      return { actionId: intent.actionId, state: "completed", dispatchedAt, outcomeRecordedAt: Date.now(),
        summary: `Native ${intent.action.kind} on ${target.role}: ${target.name}`.slice(0, 1_000), postObservation: post, error: null };
    } catch {
      return { actionId: intent.actionId, state: "uncertain", dispatchedAt, outcomeRecordedAt: Date.now(),
        summary: "Native action result is uncertain; not replaying it", postObservation: null,
        error: wayfinderError("uncertain-mutation", "act", "Native action failed after dispatch may have begun") };
    }
  }
}
