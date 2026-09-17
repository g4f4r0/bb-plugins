import {
  canonicalWindowLabel,
  PROVIDER_IDS,
  remainingPercent,
  type ProviderId,
  type ProviderUsage,
  type UsageResetCredits,
  type UsageSnapshot,
  type UsageWindow,
} from "./usage.ts";

export interface HostRef {
  id: string;
  name: string;
  status: "connected" | "disconnected";
}

export interface HostUsageReading {
  host: HostRef;
  error: string | null;
  snapshot: UsageSnapshot | null;
}

export interface LoginTotal {
  key: string;
  providerId: ProviderId;
  providerName: string;
  accountEmail: string | null;
  planLabel: string | null;
  windows: UsageWindow[];
  remainingPercent: number;
  resetCredits: UsageResetCredits | null;
  hosts: HostRef[];
}

export interface CodexCliState {
  accountEmail: string | null;
  availableCount: number | null;
  coreWindows?: readonly UsageWindow[];
  extraWindows?: readonly UsageWindow[];
}

export interface FleetView {
  fetchedAt: string;
  totals: LoginTotal[];
}

function loginKey(providerId: ProviderId, accountEmail: string | null): string {
  return `${providerId}|${accountEmail ?? ""}`;
}

function providerIndex(id: ProviderId): number {
  return PROVIDER_IDS.indexOf(id);
}

function parseResetMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function mergeWindow(current: UsageWindow, incoming: UsageWindow): UsageWindow {
  if (incoming.usedPercent < current.usedPercent) return current;
  if (incoming.usedPercent > current.usedPercent) return incoming;
  const currentReset = parseResetMs(current.resetsAt);
  const incomingReset = parseResetMs(incoming.resetsAt);
  if (currentReset === null) return incoming;
  if (incomingReset === null) return current;
  return incomingReset < currentReset ? incoming : current;
}

function mergeWindowLists(windows: readonly UsageWindow[], incoming: readonly UsageWindow[]): UsageWindow[] {
  const byLabel = new Map(windows.map((window) => [window.label, window]));
  for (const window of incoming) {
    const existing = byLabel.get(window.label);
    byLabel.set(window.label, existing ? mergeWindow(existing, window) : window);
  }
  return [...byLabel.values()];
}

function tightestRemaining(windows: readonly UsageWindow[]): number {
  return remainingPercent(windows.reduce((used, window) => Math.max(used, window.usedPercent), 0));
}

function emailsEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function pickCodexCliOwner(totals: Iterable<LoginTotal>, email: string | null): LoginTotal | undefined {
  const codex = [...totals].filter((total) => total.providerId === "codex");
  if (email === null) return undefined;
  return codex.find((total) => emailsEqual(total.accountEmail, email));
}

function enabledProvider(provider: ProviderUsage, enabled: ReadonlySet<ProviderId>): boolean {
  return enabled.has(provider.id);
}

function coalesceAnonymousLogins(totals: Map<string, LoginTotal>): void {
  for (const [key, anonymous] of [...totals.entries()]) {
    if (anonymous.accountEmail !== null) continue;
    const candidates = [...totals.values()].filter(
      (total) =>
        total.key !== key &&
        total.providerId === anonymous.providerId &&
        total.accountEmail !== null,
    );
    if (candidates.length !== 1) continue;
    const target = candidates[0]!;
    const windows = mergeWindowLists(target.windows, anonymous.windows);
    totals.set(target.key, {
      ...target,
      planLabel: target.planLabel ?? anonymous.planLabel,
      windows,
      remainingPercent: tightestRemaining(windows),
    });
    totals.delete(key);
  }
}

export function buildFleetView(
  readings: readonly HostUsageReading[],
  enabledIds: readonly ProviderId[],
  fetchedAt: string,
  codexCli: CodexCliState = { availableCount: null, accountEmail: null },
): FleetView {
  const enabled = new Set(enabledIds);
  const totals = new Map<string, LoginTotal>();
  const windowMaps = new Map<string, Map<string, UsageWindow>>();

  for (const reading of readings) {
    if (reading.snapshot === null) continue;
    for (const provider of reading.snapshot.providers) {
      if (!enabledProvider(provider, enabled) || provider.status !== "ok") continue;
      const key = loginKey(provider.id, provider.accountEmail);
      const existing = totals.get(key);
      let byLabel = windowMaps.get(key);
      if (!byLabel) { byLabel = new Map(); windowMaps.set(key, byLabel); }
      for (const window of provider.windows) {
        const prior = byLabel.get(window.label);
        byLabel.set(window.label, prior ? mergeWindow(prior, window) : window);
      }
      const windows: UsageWindow[] = [];
      totals.set(key, {
        key,
        providerId: provider.id,
        providerName: provider.name,
        accountEmail: provider.accountEmail ?? existing?.accountEmail ?? null,
        planLabel: provider.planLabel ?? existing?.planLabel ?? null,
        windows,
        remainingPercent: tightestRemaining(windows),
        resetCredits: null,
        hosts: [],
      });
    }
  }

  for (const [key, total] of totals) {
    total.windows = [...windowMaps.get(key)!.values()];
    total.remainingPercent = tightestRemaining(total.windows);
  }
  coalesceAnonymousLogins(totals);

  const owner = pickCodexCliOwner(totals.values(), codexCli.accountEmail);
  if (owner !== undefined) {
    const windows = [...owner.windows];
    const labels = new Set(windows.map((window) => canonicalWindowLabel(window.label)));
    for (const window of [...(codexCli.coreWindows ?? []), ...(codexCli.extraWindows ?? [])]) {
      const label = canonicalWindowLabel(window.label);
      if (labels.has(label)) continue;
      labels.add(label);
      windows.push({ ...window, label });
    }
    totals.set(owner.key, {
      ...owner,
      windows,
      remainingPercent: tightestRemaining(windows),
    });
  }

  // Every login lists the whole fleet so disconnected machines stay visible.
  const hosts = readings.map((reading) => reading.host);
  const resetCount = owner !== undefined ? codexCli.availableCount : null;
  const orderedTotals = [...totals.values()].sort((left, right) => {
    const providerDelta = providerIndex(left.providerId) - providerIndex(right.providerId);
    if (providerDelta !== 0) return providerDelta;
    return (left.accountEmail ?? "").localeCompare(right.accountEmail ?? "");
  }).map((total) => ({
    ...total,
    windows: [...total.windows].sort((left, right) => left.label.localeCompare(right.label)),
    hosts,
    resetCredits: total.key === owner?.key && resetCount !== null && resetCount > 0
      ? { availableCount: resetCount }
      : null,
  }));

  return { fetchedAt, totals: orderedTotals };
}
