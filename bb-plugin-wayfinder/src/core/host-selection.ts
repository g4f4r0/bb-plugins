import type { WayfinderRoute } from "../contracts/route.js";

const PORTABLE_ACTIONS = new Set([
  "browser.navigate", "browser.click", "browser.type", "browser.select",
  "browser.scroll", "browser.back", "browser.download", "wait",
]);

/** A route may leave its thread host only when it uses browser-scoped state exclusively. */
export function isPortableBrowserRoute(route: WayfinderRoute): boolean {
  if (route.filesystem.roots.length > 0 || route.desktop.applications.length > 0) return false;
  if (route.allowedActions.some((action) => !PORTABLE_ACTIONS.has(action))) return false;
  return route.checkpoints.every((checkpoint) => {
    if (checkpoint.kind === "filesystem") return false;
    if (checkpoint.kind === "visible-text") return checkpoint.surface === "browser";
    if (checkpoint.kind === "control-state" || checkpoint.kind === "field-value") return checkpoint.target.surface === "browser";
    if (checkpoint.kind === "structured-value") return checkpoint.source === "browser-dom" || checkpoint.source === "browser-network";
    return true;
  });
}

/** Stable preference order: thread host, explicit fallback, then other connected hosts. */
export function orderedHostCandidates(threadHostId: string, fallbackHostId: string | null, connectedHostIds: readonly string[]): string[] {
  const candidates = [threadHostId, fallbackHostId, ...[...connectedHostIds].sort()].filter((value): value is string => value !== null);
  return [...new Set(candidates)];
}
