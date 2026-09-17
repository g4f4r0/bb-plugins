import { formatter } from "./formatters.ts";
export const PROVIDER_IDS = [
  "codex",
  "claudeCode",
  "cursor",
  "grok",
  "openCode",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type RawProviderId =
  | ProviderId
  | "claude-code"
  | "claude"
  | "acp-cursor"
  | "acp-grok"
  | "acp-opencode";
export type ProviderStatus =
  | "ok"
  | "not_installed"
  | "unauthenticated"
  | "expired"
  | "error";

export interface UsageCost {
  usedUsdCents: number;
  limitUsdCents: number;
}

export interface UsageResetCredits {
  availableCount: number;
}

export interface RawUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  cost?: UsageCost;
}

export interface RawHealthyProviderUsage {
  status: "ok";
  accountEmail: string | null;
  planLabel: string | null;
  windows: RawUsageWindow[];
}

export type RawProviderUsage =
  | RawHealthyProviderUsage
  | { status: "not_installed" }
  | { status: "unauthenticated" }
  | { status: "expired" }
  | {
      status: "error";
      message: string;
      planLabel?: string | null;
      accountEmail?: string | null;
    };

export type RawUsageResponse = Partial<
  Record<RawProviderId, RawProviderUsage>
>;

export interface UsageWindow {
  label: string;
  usedPercent: number;
  barPercent: number;
  resetsAt: string | null;
  cost: UsageCost | null;
}

export interface ProviderUsage {
  id: ProviderId;
  name: string;
  status: ProviderStatus;
  accountEmail: string | null;
  planLabel: string | null;
  message: string | null;
  windows: UsageWindow[];
}

export interface UsageSnapshot {
  fetchedAt: string;
  host: {
    id: string | null;
    name: string | null;
  };
  providers: ProviderUsage[];
}

interface ProviderDefinition {
  id: ProviderId;
  wireIds: readonly RawProviderId[];
  name: string;
  loginCommand: string;
}

const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "codex",
    wireIds: ["codex"],
    name: "Codex",
    loginCommand: "codex login",
  },
  {
    id: "claudeCode",
    wireIds: ["claude-code", "claudeCode", "claude"],
    name: "Claude Code",
    loginCommand: "claude",
  },
  {
    id: "cursor",
    wireIds: ["acp-cursor", "cursor"],
    name: "Cursor",
    loginCommand: "cursor-agent login",
  },
  {
    id: "grok",
    wireIds: ["acp-grok", "grok"],
    name: "Grok",
    loginCommand: "grok login",
  },
  {
    id: "openCode",
    wireIds: ["acp-opencode", "openCode"],
    name: "OpenCode",
    loginCommand: "opencode auth login",
  },
];

/** BB's agent-provider id, for host ProviderIcon / logo URLs. */
export function bbAgentProviderId(id: ProviderId): string {
  return PROVIDERS.find((provider) => provider.id === id)?.wireIds[0] ?? id;
}

/** BB names the 5-hour window "Current session". */
export function canonicalWindowLabel(label: string): string {
  const trimmed = label.trim();
  if (/^(current session|five-hour(?:\s+limit)?|5-hour(?:\s+limit)?)$/iu.test(trimmed)) return "5-hour";
  if (/^weekly(?:\s+limit)?$/iu.test(trimmed)) return "Weekly";
  return trimmed.replace(/\s+limit$/iu, "");
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("Usage percentages must be finite numbers");
  }
  return Math.min(100, Math.max(0, value));
}

export function remainingPercent(usedPercent: number): number {
  return clampPercent(100 - usedPercent);
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function statusMessage(
  provider: ProviderDefinition,
  usage: Exclude<RawProviderUsage, RawHealthyProviderUsage>,
): string {
  switch (usage.status) {
    case "not_installed":
      return `${provider.name} is not installed on this machine.`;
    case "unauthenticated":
      return `Sign in with \`${provider.loginCommand}\`, then refresh usage.`;
    case "expired":
      return `The ${provider.name} session expired. Run \`${provider.loginCommand}\`, then refresh usage.`;
    case "error":
      return usage.message.trim() || `${provider.name} usage is unavailable.`;
  }
}

function normalizeProvider(
  definition: ProviderDefinition,
  usage: RawProviderUsage | undefined,
): ProviderUsage {
  if (usage === undefined) {
    return {
      id: definition.id,
      name: definition.name,
      status: "error",
      accountEmail: null,
      planLabel: null,
      message: `${definition.name} usage was not reported by bb.`,
      windows: [],
    };
  }

  if (usage.status !== "ok") {
    return {
      id: definition.id,
      name: definition.name,
      status: usage.status,
      accountEmail: usage.status === "error" ? (usage.accountEmail ?? null) : null,
      planLabel: usage.status === "error" ? (usage.planLabel ?? null) : null,
      message: statusMessage(definition, usage),
      windows: [],
    };
  }

  return {
    id: definition.id,
    name: definition.name,
    status: "ok",
    accountEmail: usage.accountEmail,
    planLabel: usage.planLabel,
    message: null,
    windows: usage.windows.map((window) => ({
      label: canonicalWindowLabel(window.label),
      usedPercent: finiteNumber(window.usedPercent, "usedPercent"),
      barPercent: clampPercent(window.usedPercent),
      resetsAt: window.resetsAt,
      cost:
        window.cost === undefined
          ? null
          : {
              usedUsdCents: finiteNumber(
                window.cost.usedUsdCents,
                "usedUsdCents",
              ),
              limitUsdCents: finiteNumber(
                window.cost.limitUsdCents,
                "limitUsdCents",
              ),
            },
    })),
  };
}

function providerUsage(
  response: RawUsageResponse,
  definition: ProviderDefinition,
): RawProviderUsage | undefined {
  for (const wireId of definition.wireIds) {
    const usage = response[wireId];
    if (usage !== undefined) return usage;
  }
  return undefined;
}

export function normalizeUsage(
  response: RawUsageResponse,
  host: UsageSnapshot["host"],
  fetchedAt = new Date(),
): UsageSnapshot {
  return {
    fetchedAt: fetchedAt.toISOString(),
    host,
    providers: PROVIDERS.map((provider) => {
      try {
        return normalizeProvider(provider, providerUsage(response, provider));
      } catch (error) {
        return {
          id: provider.id,
          name: provider.name,
          status: "error",
          accountEmail: null,
          planLabel: null,
          message: error instanceof Error ? error.message : String(error),
          windows: [],
        };
      }
    }),
  };
}

export function formatUsedPercent(value: number, locale?: string): string {
  if (!Number.isFinite(value)) return "Unavailable";
  return formatter("percent", locale, () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })).format(value);
}

export function formatRemainingPercent(usedPercent: number, locale?: string): string {
  return `${formatUsedPercent(remainingPercent(usedPercent), locale)}% left`;
}

export function formatResetCredits(availableCount: number): string {
  return `${availableCount} reset${availableCount === 1 ? "" : "s"} available`;
}

export function formatResetTime(
  value: string | null,
  locale?: string,
): string {
  if (value === null) return "Reset unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Reset unavailable";
  return `Resets ${formatter("reset", locale, () => new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric", minute: "2-digit" })).format(date)}`;
}

export function formatFetchedAt(value: string, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Updated recently";
  return `Updated at ${formatter("fetched", locale, () => new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" })).format(date)}`;
}

export function formatCost(cost: UsageCost, locale?: string): string {
  const format = formatter("cost", locale, () => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }));
  return `${format.format(cost.usedUsdCents / 100)} of ${format.format(cost.limitUsdCents / 100)}`;
}
