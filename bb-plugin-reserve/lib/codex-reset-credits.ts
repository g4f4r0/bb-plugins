import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { z } from "zod";
import { canonicalWindowLabel, clampPercent, type UsageWindow } from "./usage.ts";

/** Miss CLI usage rather than stall the popover. */
const USAGE_PROBE_TIMEOUT_MS = 3_000;
const CONSUME_TIMEOUT_MS = 15_000;
const CODEX_EXECUTABLE = process.env.CODEX_BIN?.trim() || "codex";
const DEFAULT_CODEX_LIMIT_ID = "codex";
const EXTRA_POOL_NAMES: Readonly<Record<string, string>> = {
  "gpt-reserve": "Luna Reserve",
  "gpt-5.3-codex-spark": "Spark",
};

const resetCreditCountSchema = z.preprocess(
  (value) =>
    typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value,
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
);

const rateLimitResetCreditsSchema = z
  .object({
    availableCount: resetCreditCountSchema,
  })
  .passthrough();

const rateLimitWindowSchema = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullable().optional(),
    resetsAt: z.number().nullable().optional(),
  })
  .passthrough();

const rateLimitSnapshotSchema = z
  .object({
    limitId: z.string().nullable().optional(),
    limitName: z.string().nullable().optional(),
    planType: z.string().nullable().optional(),
    primary: rateLimitWindowSchema.nullable().optional(),
    secondary: rateLimitWindowSchema.nullable().optional(),
  })
  .passthrough();

const accountRateLimitsResponseSchema = z
  .object({
    rateLimitResetCredits: rateLimitResetCreditsSchema.nullable().optional(),
    rateLimits: rateLimitSnapshotSchema.optional(),
    rateLimitsByLimitId: z.record(z.string(), rateLimitSnapshotSchema).nullable().optional(),
  })
  .passthrough();

const accountReadSchema = z
  .object({
    account: z
      .object({
        type: z.string(),
        email: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export interface CodexCliEnrichment {
  accountEmail: string | null;
  availableCount: number | null;
  coreWindows: UsageWindow[];
  extraWindows: UsageWindow[];
}

export const EMPTY_CODEX_CLI: CodexCliEnrichment = {
  accountEmail: null,
  availableCount: null,
  coreWindows: [],
  extraWindows: [],
};

const consumeResponseSchema = z
  .object({
    outcome: z.enum([
      "reset",
      "nothingToReset",
      "noCredit",
      "alreadyRedeemed",
    ]),
  })
  .passthrough();

interface JsonRpcError {
  message?: unknown;
}

interface JsonRpcMessage {
  id?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

function parseJsonRpcMessage(line: string): JsonRpcMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object") return null;
    return value as JsonRpcMessage;
  } catch {
    return null;
  }
}

function rpcError(message: JsonRpcMessage, fallback: string): Error {
  const detail = message.error?.message;
  return new Error(
    typeof detail === "string" && detail.trim().length > 0
      ? detail.trim()
      : fallback,
  );
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 250);
  forceKill.unref();
  child.once("close", () => clearTimeout(forceKill));
}

interface AppServerCall {
  method: string;
  params?: unknown;
}

function runCodexAppServerRequests(
  calls: readonly AppServerCall[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown[]> {
  if (calls.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams | null = null;
    let reader: Interface | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let outputBytes = 0;
    const abort = () => finish(new Error("Codex request cancelled."));
    const countOutput = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 2 * 1024 * 1024) finish(new Error("Codex response exceeded 2 MiB."));
    };
    let requestSent = false;
    const results: unknown[] = Array.from({ length: calls.length });
    const pending = new Set(calls.map((_, index) => index + 2));

    const finish = (error: Error | null, value?: unknown[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      child?.stdout.removeListener("data", countOutput);
      reader?.removeAllListeners("line");
      reader?.close();
      if (child !== null) terminate(child);
      if (error !== null) {
        reject(error);
      } else {
        resolve(value ?? results);
      }
    };

    const send = (message: Record<string, unknown>): void => {
      if (settled || child === null) return;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== undefined && error !== null) finish(error);
      });
    };

    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child = spawn(CODEX_EXECUTABLE, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    timeout = setTimeout(() => {
      finish(new Error("Codex app-server timed out."));
    }, timeoutMs);
    timeout.unref();

    child.stderr.resume();
    child.stdout.on("data", countOutput);
    const stdinError = (error: Error) => finish(error);
    child.stdin.on("error", stdinError);
    const childError = (error: Error) => finish(error);
    child.once("error", childError);
    child.once("close", (code, signal) => {
      child?.stdin.removeListener("error", stdinError);
      child?.removeListener("error", childError);
      if (settled) return;
      const reason = signal === null ? `exit code ${code ?? "unknown"}` : signal;
      finish(new Error(`Codex app-server exited before responding (${reason}).`));
    });

    reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      const message = parseJsonRpcMessage(line);
      if (message === null || message.id === undefined) return;

      if (message.id === 1) {
        if (message.error !== undefined) {
          finish(rpcError(message, "Codex app-server initialization failed."));
          return;
        }
        if (requestSent) return;
        requestSent = true;
        send({ method: "initialized" });
        for (const [index, call] of calls.entries()) {
          send({
            id: index + 2,
            method: call.method,
            ...(call.params === undefined ? {} : { params: call.params }),
          });
        }
        return;
      }

      const index = typeof message.id === "number" ? message.id - 2 : -1;
      if (!pending.has(message.id as number) || index < 0 || index >= calls.length) return;
      pending.delete(message.id as number);
      if (message.error !== undefined) {
        finish(rpcError(message, `Codex app-server request failed: ${calls[index]!.method}.`));
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(message, "result")) {
        finish(new Error(`Codex app-server returned no result for ${calls[index]!.method}.`));
        return;
      }
      results[index] = message.result;
      if (pending.size === 0) finish(null, results);
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "bb-plugin-reserve",
          title: "Reserve",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
  });
}

function runCodexAppServerRequest(
  method: string,
  params: unknown | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return runCodexAppServerRequests([{ method, params }], timeoutMs, signal).then((results) => results[0]);
}

function resetsAtIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const ms = value > 1e12 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function periodLabel(
  window: z.infer<typeof rateLimitWindowSchema>,
  fallback: "5-hour" | "Weekly" | "Monthly",
): string {
  const mins = window.windowDurationMins;
  if (mins === 300) return "5-hour";
  if (mins === 1440) return "Daily";
  if (mins === 10080) return "Weekly";
  if (typeof mins === "number" && mins >= 30 * 24 * 60) return "Monthly";
  return fallback;
}

function usageWindow(
  period: string,
  window: z.infer<typeof rateLimitWindowSchema>,
): UsageWindow {
  return {
    label: canonicalWindowLabel(period),
    usedPercent: window.usedPercent,
    barPercent: clampPercent(window.usedPercent),
    resetsAt: resetsAtIso(window.resetsAt),
    cost: null,
  };
}

function poolName(limitId: string, limitName: string | null | undefined): string {
  const id = limitId.trim();
  const named = limitName?.trim() ?? "";
  return EXTRA_POOL_NAMES[id.toLowerCase()]
    ?? EXTRA_POOL_NAMES[named.toLowerCase()]
    ?? (named.length > 0 && named !== id ? named : id);
}

function extraWindow(
  pool: string,
  period: string,
  window: z.infer<typeof rateLimitWindowSchema>,
): UsageWindow {
  return {
    ...usageWindow(period, window),
    label: `${pool} · ${period}`,
  };
}

function windowsFromSnapshot(
  limitId: string,
  snapshot: z.infer<typeof rateLimitSnapshotSchema>,
): { core: UsageWindow[]; extra: UsageWindow[] } {
  const id = snapshot.limitId ?? limitId;
  if (id === DEFAULT_CODEX_LIMIT_ID || id.trim() === "") {
    return { core: coreWindowsFromSnapshot(snapshot), extra: [] };
  }
  const pool = poolName(id, snapshot.limitName);
  const extra: UsageWindow[] = [];
  if (snapshot.primary) extra.push(extraWindow(pool, periodLabel(snapshot.primary, "5-hour"), snapshot.primary));
  if (snapshot.secondary) extra.push(extraWindow(pool, periodLabel(snapshot.secondary, "Weekly"), snapshot.secondary));
  return { core: [], extra };
}

function coreWindowsFromSnapshot(
  snapshot: z.infer<typeof rateLimitSnapshotSchema>,
): UsageWindow[] {
  const monthly = snapshot.planType === "free" || snapshot.planType === "go";
  const windows: UsageWindow[] = [];
  if (snapshot.primary) {
    windows.push(usageWindow(periodLabel(snapshot.primary, monthly ? "Monthly" : "5-hour"), snapshot.primary));
  }
  if (snapshot.secondary) {
    windows.push(usageWindow(periodLabel(snapshot.secondary, "Weekly"), snapshot.secondary));
  }
  return windows;
}

export function emailFromAccountRead(result: unknown): string | null {
  const parsed = accountReadSchema.safeParse(result);
  if (!parsed.success) return null;
  const account = parsed.data.account;
  if (!account || account.type !== "chatgpt") return null;
  const email = account.email?.trim() ?? "";
  return email.includes("@") ? email : null;
}

export function normalizeCodexResetCreditsResponse(
  result: unknown,
): number | null {
  return normalizeCodexAccountLimits(result).availableCount;
}

export function normalizeCodexAccountLimits(
  result: unknown,
): Pick<CodexCliEnrichment, "availableCount" | "coreWindows" | "extraWindows"> {
  const parsed = accountRateLimitsResponseSchema.safeParse(result);
  if (!parsed.success) return { availableCount: null, coreWindows: [], extraWindows: [] };
  const coreWindows: UsageWindow[] = [];
  const extraWindows: UsageWindow[] = [];
  const byId = parsed.data.rateLimitsByLimitId;
  if (byId) {
    for (const [limitId, snapshot] of Object.entries(byId)) {
      const split = windowsFromSnapshot(snapshot.limitId ?? limitId, snapshot);
      coreWindows.push(...split.core);
      extraWindows.push(...split.extra);
    }
  } else if (parsed.data.rateLimits) {
    const split = windowsFromSnapshot(
      parsed.data.rateLimits.limitId ?? DEFAULT_CODEX_LIMIT_ID,
      parsed.data.rateLimits,
    );
    coreWindows.push(...split.core);
    extraWindows.push(...split.extra);
  }
  return {
    availableCount: parsed.data.rateLimitResetCredits?.availableCount ?? null,
    coreWindows,
    extraWindows,
  };
}

export function normalizeCodexCliEnrichment(account: unknown, limits: unknown): CodexCliEnrichment {
  return {
    accountEmail: emailFromAccountRead(account),
    ...normalizeCodexAccountLimits(limits),
  };
}

export async function readCodexCliEnrichment(signal?: AbortSignal): Promise<CodexCliEnrichment> {
  const [account, limits] = await runCodexAppServerRequests(
    [
      { method: "account/read", params: {} },
      { method: "account/rateLimits/read" },
    ],
    USAGE_PROBE_TIMEOUT_MS,
    signal,
  );
  return normalizeCodexCliEnrichment(account, limits);
}

export type CodexResetConsumptionOutcome =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed";

export async function consumeCodexRateLimitResetCredit(
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<CodexResetConsumptionOutcome> {
  const result = await runCodexAppServerRequest(
    "account/rateLimitResetCredit/consume",
    { idempotencyKey },
    CONSUME_TIMEOUT_MS,
    signal,
  );
  return consumeResponseSchema.parse(result).outcome;
}
