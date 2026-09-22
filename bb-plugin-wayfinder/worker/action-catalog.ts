import type { ActionIntent, AdapterObservation, DecisionResponse } from "../src/contracts/adapter.js";
import type { DataReference, WayfinderRoute } from "../src/contracts/route.js";
import { wayfinderError } from "../src/core/errors.js";
import { assertAllowedUrl } from "../src/policy/origins.js";

export interface BoundedChoices {
  readonly operationChoices: ReadonlyArray<{ readonly choiceId: string; readonly label: string }>;
  readonly targetChoices: ReadonlyArray<{ readonly choiceId: string; readonly targetId: string; readonly label: string }>;
  resolve(decision: DecisionResponse): ActionIntent["action"];
}

export interface ActionCatalog {
  choices(route: WayfinderRoute, observation: AdapterObservation): BoundedChoices;
}

export interface ObservedActionCatalogOptions {
  readonly navigationUrls?: readonly string[];
  readonly dataBindings?: ReadonlyMap<string, DataReference>;
  readonly downloadRootId?: string;
}

type TargetOperation = AdapterObservation["targets"][number]["allowedOperations"][number];

function actionKind(adapter: AdapterObservation["identity"]["adapter"], operation: TargetOperation): ActionIntent["action"]["kind"] | null {
  if (adapter === "browser") {
    if (operation === "click") return "browser.click";
    if (operation === "type") return "browser.type";
    if (operation === "scroll") return "browser.scroll";
    if (operation === "select") return "browser.select";
  }
  if (adapter === "desktop") {
    if (operation === "click") return "desktop.click";
    if (operation === "type") return "desktop.type";
    if (operation === "scroll") return "desktop.scroll";
    if (operation === "invoke-menu") return "desktop.invoke-menu";
  }
  return null;
}

export class ObservedActionCatalog implements ActionCatalog {
  readonly #options: ObservedActionCatalogOptions;
  readonly #usedDataBindings = new Set<string>();

  constructor(options: ObservedActionCatalogOptions = {}) { this.#options = options; }

  choices(route: WayfinderRoute, observation: AdapterObservation): BoundedChoices {
    const kinds = new Set<string>();
    for (const target of observation.targets) {
      for (const operation of target.allowedOperations) {
        const kind = actionKind(observation.identity.adapter, operation);
        if (kind !== null && route.allowedActions.includes(kind)) {
          if (kind.endsWith(".type") && this.#dataBinding(route, target) === undefined) continue;
          kinds.add(kind);
        }
      }
    }
    if (observation.identity.adapter === "browser") {
      if (route.allowedActions.includes("browser.back")) kinds.add("browser.back");
      if (route.allowedActions.includes("browser.navigate")) {
        for (const url of this.#options.navigationUrls ?? []) assertAllowedUrl(route, url, "navigation");
        if ((this.#options.navigationUrls?.length ?? 0) > 0) kinds.add("browser.navigate");
      }
    }
    if (route.allowedActions.includes("wait")) kinds.add("wait");
    const operationChoices = [...kinds].flatMap((kind) => {
      if (kind === "browser.navigate") return (this.#options.navigationUrls ?? []).map((url, index) => ({ choiceId: `op_navigate_${index}`, label: `Navigate to approved URL ${url}` }));
      return [{ choiceId: `op_${kind.replace(".", "_")}`, label: kind }];
    });
    const targetChoices = observation.targets.map((target) => ({
      choiceId: `target_${target.targetId}`,
      targetId: target.targetId,
      label: `${target.role}: ${target.name}`.slice(0, 500),
    }));
    return {
      operationChoices,
      targetChoices,
      resolve: (decision) => this.#resolve(route, observation, decision, targetChoices),
    };
  }

  #resolve(route: WayfinderRoute, observation: AdapterObservation, decision: DecisionResponse, targets: BoundedChoices["targetChoices"]): ActionIntent["action"] {
    const operation = decision.operationChoiceId;
    if (operation.startsWith("op_navigate_")) {
      const index = Number(operation.slice("op_navigate_".length));
      const url = this.#options.navigationUrls?.[index];
      if (url === undefined) throw wayfinderError("provider-unavailable", "decide", "Jev chose an unknown navigation candidate");
      assertAllowedUrl(route, url, "navigation");
      return { kind: "browser.navigate", url };
    }
    if (operation === "op_wait") return { kind: "wait", reason: "Bounded settle requested", maxWaitMs: 100 };
    if (operation === "op_browser_back") return { kind: "browser.back" };
    const kind = operation.slice(3).replace("_", ".") as ActionIntent["action"]["kind"];
    if (!route.allowedActions.includes(kind)) throw wayfinderError("policy-denied", "decide", "Chosen operation is not route-allowed");
    const selected = decision.targetChoiceId === null ? undefined : targets.find((target) => target.choiceId === decision.targetChoiceId);
    if (selected === undefined) throw wayfinderError("ambiguous-target", "decide", "Chosen operation requires one observed target");
    const target = observation.targets.find((candidate) => candidate.targetId === selected.targetId);
    if (target === undefined) throw wayfinderError("stale-observation", "decide", "Chosen target is no longer observed");
    const reference = { targetId: target.targetId, resourceGeneration: target.resourceGeneration, snapshotId: observation.identity.snapshotId };
    switch (kind) {
      case "browser.click": return { kind, target: reference };
      case "desktop.click": return { kind, target: reference };
      case "browser.type": {
        const value = this.#dataBinding(route, target);
        if (value === undefined) throw wayfinderError("policy-denied", "decide", "No trusted data binding exists for the chosen target");
        this.#usedDataBindings.add(target.targetId);
        return { kind, target: reference, value };
      }
      case "desktop.type": {
        const value = this.#dataBinding(route, target);
        if (value === undefined) throw wayfinderError("policy-denied", "decide", "No trusted data binding exists for the chosen target");
        this.#usedDataBindings.add(target.targetId);
        return { kind, target: reference, value };
      }
      case "browser.scroll": return { kind, target: reference, direction: "down", amount: "small" };
      case "desktop.scroll": return { kind, target: reference, direction: "down", amount: "small" };
      case "desktop.invoke-menu": return { kind, target: reference };
      default: throw wayfinderError("setup-required", "decide", `No trusted builder exists for ${kind}`);
    }
  }

  #dataBinding(route: WayfinderRoute, target: AdapterObservation["targets"][number]): DataReference | undefined {
    if (this.#usedDataBindings.has(target.targetId)) return undefined;
    const configured = this.#options.dataBindings?.get(target.targetId);
    if (configured !== undefined) return configured;
    const normalize = (value: string) => value.trim().toLocaleLowerCase();
    const matches = (actual: string, expected: string, match: "exact" | "contains") => match === "exact"
      ? normalize(actual) === normalize(expected)
      : normalize(actual).includes(normalize(expected));
    for (const checkpoint of route.checkpoints) {
      if (checkpoint.kind !== "field-value" || checkpoint.target.surface !== "browser" || checkpoint.expected.kind !== "synthetic-literal") continue;
      if (!matches(target.role, checkpoint.target.role, checkpoint.target.match) || !matches(target.name, checkpoint.target.name, checkpoint.target.match)) continue;
      return checkpoint.expected;
    }
    return undefined;
  }
}
