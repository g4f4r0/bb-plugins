import { mapLimited, withDeadline, withTimeBudget } from "./async-limits.ts";
import { buildFleetView, type CodexCliState, type FleetView, type HostRef, type HostUsageReading } from "./fleet.ts";
import { normalizeUsage, type ProviderId, type RawUsageResponse } from "./usage.ts";

export interface FleetHost {
  id: string;
  name: string;
  status: "connected" | "disconnected";
  type: "persistent" | "ephemeral";
}

/** Per-host cap so a hung remote cannot stall the popover. Raise if healthy remotes routinely exceed this. */
export const HOST_USAGE_TIMEOUT_MS = 5_000;

export interface FleetSdk {
  hosts: {
    list(args?: { includeCreating?: boolean }): Promise<FleetHost[]>;
  };
  providers?: {
    list(args?: { hostId?: string; capability?: "usage"; signal?: AbortSignal }): Promise<Array<{ id: string }>>;
  };
  system: {
    usageLimits(args?: {
      hostId?: string;
      providerId?: string;
      signal?: AbortSignal;
    }): Promise<RawUsageResponse>;
  };
}

function hostRef(host: FleetHost): HostRef {
  return { id: host.id, name: host.name, status: host.status };
}

async function usageProviderIds(
  sdk: FleetSdk,
  hostId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (sdk.providers?.list === undefined) return null;
  try {
    const providers = await withDeadline((signal) => sdk.providers!.list({
      hostId,
      capability: "usage",
      signal,
    }), timeoutMs, signal);
    const supported = new Set(["codex", "claude-code", "acp-cursor", "acp-grok", "acp-opencode"]);
    const ids = [...new Set(providers.map((provider) => provider.id))].filter((id) => supported.has(id));
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

async function readHostUsage(
  sdk: FleetSdk,
  hostId: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawUsageResponse> {
  try {
    return await withDeadline((signal) => sdk.system.usageLimits({
      ...(hostId === undefined ? {} : { hostId }),
      signal,
    }), timeoutMs, signal);
  } catch (error) {
    const ids = hostId === undefined ? null : await usageProviderIds(sdk, hostId, timeoutMs, signal);
    if (ids === null) throw error;
    const parts = await mapLimited(ids, 2, async (providerId) => {
      try {
        return await withDeadline((signal) => sdk.system.usageLimits({
          hostId,
          providerId,
          signal,
        }), timeoutMs, signal);
      } catch {
        return null;
      }
    });
    const completed = parts.filter((part) => part !== null);
    if (completed.length === 0) throw error;
    return Object.assign({}, ...completed);
  }
}

async function readHost(
  sdk: FleetSdk,
  host: FleetHost,
  fetchedAt: Date,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HostUsageReading> {
  const ref = hostRef(host);
  if (host.status !== "connected") {
    return { host: ref, error: null, snapshot: null };
  }
  try {
    const response = await readHostUsage(sdk, host.id, timeoutMs, signal);
    return {
      host: ref,
      error: null,
      snapshot: normalizeUsage(response, { id: host.id, name: host.name }, fetchedAt),
    };
  } catch (error) {
    return {
      host: ref,
      error: error instanceof Error ? error.message : String(error),
      snapshot: null,
    };
  }
}

async function readFleetReadings(
  sdk: FleetSdk,
  fetchedAt = new Date(),
  timeoutMs = HOST_USAGE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<HostUsageReading[]> {
  let hosts: FleetHost[];
  try {
    hosts = (await withDeadline(() => sdk.hosts.list(), timeoutMs, signal)).filter((host) => host.type === "persistent");
  } catch {
    hosts = [];
  }

  if (hosts.length === 0) {
    try {
      const response = await readHostUsage(sdk, undefined, timeoutMs, signal);
      return [{
        host: { id: "local", name: "This server", status: "connected" },
        error: null,
        snapshot: normalizeUsage(response, { id: null, name: "This server" }, fetchedAt),
      }];
    } catch (error) {
      return [{
        host: { id: "local", name: "This server", status: "connected" },
        error: error instanceof Error ? error.message : String(error),
        snapshot: null,
      }];
    }
  }

  return mapLimited(hosts, 8, (host) => readHost(sdk, host, fetchedAt, timeoutMs, signal));
}

export function loadFleetReadings(
  sdk: FleetSdk,
  fetchedAt = new Date(),
  timeoutMs = HOST_USAGE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<HostUsageReading[]> {
  return withTimeBudget((budget) => readFleetReadings(sdk, fetchedAt, timeoutMs, budget), 15_000, signal);
}

export function assembleFleetView(
  readings: readonly HostUsageReading[],
  enabledIds: readonly ProviderId[],
  fetchedAt: Date,
  codexCli: CodexCliState,
): FleetView {
  return buildFleetView(readings, enabledIds, fetchedAt.toISOString(), codexCli);
}
