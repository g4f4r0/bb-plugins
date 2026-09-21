import type { ActionIntent, AdapterObservation } from "../contracts/adapter.js";
import type { WayfinderRoute } from "../contracts/route.js";
import { wayfinderError } from "../core/errors.js";
import { assertAllowedUrl } from "./origins.js";

type ObservedTarget = AdapterObservation["targets"][number];
type Operation = ObservedTarget["allowedOperations"][number];

function targetOperation(kind: ActionIntent["action"]["kind"]): Operation | null {
  switch (kind) {
    case "browser.click":
    case "desktop.click": return "click";
    case "browser.type":
    case "desktop.type": return "type";
    case "browser.select": return "select";
    case "browser.scroll":
    case "desktop.scroll": return "scroll";
    case "desktop.activate": return "activate";
    case "desktop.invoke-menu": return "invoke-menu";
    default: return null;
  }
}

function referencedTarget(intent: ActionIntent): ActionIntent["action"] extends infer _T ? { targetId: string; resourceGeneration: string; snapshotId: string } | null : never {
  const action = intent.action;
  if ("target" in action && action.target !== null) return action.target;
  return null;
}

export function assertActionAllowed(route: WayfinderRoute, intent: ActionIntent, observation: AdapterObservation): ObservedTarget | null {
  if (route.identity.hostId !== intent.observation.hostId || route.identity.hostId !== observation.identity.hostId) {
    throw wayfinderError("host-mismatch", "act", "Action does not belong to the selected host");
  }
  if (!route.allowedActions.includes(intent.action.kind)) {
    throw wayfinderError("policy-denied", "act", "Action kind is not allowed by the route", {
      details: [{ key: "action", value: intent.action.kind }],
    });
  }
  const expectedAdapter = intent.action.kind.startsWith("browser.")
    ? "browser"
    : intent.action.kind.startsWith("desktop.")
      ? "desktop"
      : intent.action.kind.startsWith("filesystem.")
        ? "filesystem"
        : observation.identity.adapter;
  if (observation.identity.adapter !== expectedAdapter || intent.observation.adapter !== expectedAdapter) {
    throw wayfinderError("policy-denied", "act", "Action kind does not match the observed adapter");
  }
  if (
    intent.observation.resourceId !== observation.identity.resourceId ||
    intent.observation.resourceGeneration !== observation.identity.resourceGeneration ||
    intent.observation.snapshotId !== observation.identity.snapshotId
  ) {
    throw wayfinderError("stale-observation", "act", "The observed resource changed before dispatch", { retryable: true });
  }
  if (intent.action.kind === "browser.navigate") assertAllowedUrl(route, intent.action.url, "navigation");

  const reference = referencedTarget(intent);
  if (reference === null) return null;
  if (
    reference.resourceGeneration !== observation.identity.resourceGeneration ||
    reference.snapshotId !== observation.identity.snapshotId
  ) {
    throw wayfinderError("stale-observation", "act", "Target generation or snapshot is stale", { retryable: true });
  }
  const target = observation.targets.find(({ targetId }) => targetId === reference.targetId);
  if (target === undefined) throw wayfinderError("stale-observation", "act", "Target is absent from the current observation", { retryable: true });
  const operation = targetOperation(intent.action.kind);
  if (operation !== null && !target.allowedOperations.includes(operation)) {
    throw wayfinderError("policy-denied", "act", "Observed target does not allow this operation");
  }
  return target;
}
