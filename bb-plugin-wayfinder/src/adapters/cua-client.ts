import { spawn } from "node:child_process";

import { errorMessage, wayfinderError } from "../core/errors.js";

export interface CuaToolResult {
  readonly structuredContent?: Record<string, unknown>;
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly isError?: boolean;
}

export interface CuaTransport {
  call(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CuaToolResult>;
  close(signal: AbortSignal): Promise<void>;
}

export interface ProcessCuaTransportOptions {
  readonly binaryPath: string;
  readonly socketPath: string;
  readonly session: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function parseResult(stdout: string): CuaToolResult {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const candidate = parsed.result !== null && typeof parsed.result === "object"
    ? parsed.result as Record<string, unknown>
    : parsed;
  const structured = candidate.structuredContent ?? candidate.structured_content;
  return {
    ...(structured !== null && typeof structured === "object" ? { structuredContent: structured as Record<string, unknown> } : {}),
    ...(Array.isArray(candidate.content) ? { content: candidate.content as CuaToolResult["content"] } : {}),
    ...(typeof candidate.isError === "boolean" ? { isError: candidate.isError } : {}),
  };
}

export class ProcessCuaTransport implements CuaTransport {
  readonly #options: Required<ProcessCuaTransportOptions>;
  #closed = false;

  constructor(options: ProcessCuaTransportOptions) {
    this.#options = {
      ...options,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxOutputBytes: options.maxOutputBytes ?? 2_000_000,
    };
  }

  call(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CuaToolResult> {
    if (this.#closed) return Promise.reject(wayfinderError("provider-unavailable", "act", "Cua transport is closed"));
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(tool)) return Promise.reject(wayfinderError("policy-denied", "act", "Invalid Cua tool name"));
    const payload = { ...input, session: this.#options.session };
    return new Promise((resolve, reject) => {
      const child = spawn(this.#options.binaryPath, ["call", tool, "--socket", this.#options.socketPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "",
          DISPLAY: process.env.DISPLAY ?? "",
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? "",
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
        },
      });
      let stdout = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        fn();
      };
      const abort = () => {
        child.kill("SIGTERM");
        finish(() => reject(wayfinderError("cancelled", "act", "Cua operation cancelled")));
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(wayfinderError("provider-unavailable", "act", "Cua operation timed out", { retryable: true })));
      }, this.#options.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > this.#options.maxOutputBytes) child.kill("SIGTERM");
      });
      child.stderr.on("data", () => { /* Never retain driver stderr; it may reflect protected input. */ });
      child.on("error", (error) => finish(() => reject(wayfinderError("setup-required", "act", `Cua runtime unavailable: ${errorMessage(error)}`))));
      child.on("close", (code) => finish(() => {
        if (Buffer.byteLength(stdout) > this.#options.maxOutputBytes) {
          reject(wayfinderError("limit-exceeded", "act", "Cua response exceeded the output limit"));
          return;
        }
        if (code !== 0) {
          reject(wayfinderError("provider-unavailable", "act", `Cua tool ${tool} failed (${code ?? "signal"})`, { retryable: true }));
          return;
        }
        try {
          const result = parseResult(stdout);
          if (result.isError === true) {
            const message = result.content?.find((part) => part.type === "text")?.text ?? "Cua tool returned an error";
            reject(wayfinderError(/stale/iu.test(message) ? "stale-observation" : "provider-unavailable", "act", message.slice(0, 1_000), { retryable: /stale/iu.test(message) }));
          } else resolve(result);
        } catch (error) {
          reject(wayfinderError("provider-unavailable", "act", `Invalid Cua response: ${errorMessage(error)}`));
        }
      }));
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async close(signal: AbortSignal): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (signal.aborted) return;
    // Closing the named session releases only resources owned by this run.
    this.#closed = false;
    try { await this.call("end_session", {}, signal); } finally { this.#closed = true; }
  }
}

export interface CuaProbeResult {
  readonly state: "ready" | "setup-required" | "unavailable";
  readonly message: string;
  readonly version: string | null;
}

async function runProbe(binaryPath: string, args: string[], signal: AbortSignal, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const abort = () => { child.kill("SIGTERM"); reject(wayfinderError("cancelled", "observe", "Cua readiness probe cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { stdout = (stdout + value).slice(0, 100_000); });
    child.stderr.on("data", (value: string) => { stderr = (stderr + value).slice(0, 2_000); });
    child.on("error", (error) => { signal.removeEventListener("abort", abort); reject(error); });
    child.on("close", (code) => { signal.removeEventListener("abort", abort); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin ?? "");
  });
}

export async function probeCuaRuntime(binaryPath: string, signal: AbortSignal): Promise<CuaProbeResult> {
  try {
    const [version, doctor, status] = await Promise.all([
      runProbe(binaryPath, ["--version"], signal),
      runProbe(binaryPath, ["doctor", "--json"], signal),
      runProbe(binaryPath, ["status"], signal),
    ]);
    const versionText = version.code === 0 ? version.stdout.trim().slice(0, 100) : null;
    if (doctor.code !== 0) return { state: "unavailable", message: "Cua doctor probe failed", version: versionText };
    const report = JSON.parse(doctor.stdout) as { probes?: Array<{ label?: string; status?: string; message?: string }> };
    const blockers = (report.probes ?? []).filter((probe) => probe.status !== "ok");
    if (status.code !== 0) return { state: "setup-required", message: "Cua daemon is not running with a reviewed bounded capability manifest", version: versionText };
    if (blockers.length > 0) {
      return { state: "setup-required", message: blockers.map((probe) => `${probe.label ?? "probe"}: ${probe.message ?? probe.status}`).join("; ").slice(0, 1_000), version: versionText };
    }
    const [health, windows] = await Promise.all([
      runProbe(binaryPath, ["call", "health_report"], signal, "{}"),
      runProbe(binaryPath, ["call", "list_windows"], signal, JSON.stringify({ on_screen_only: true })),
    ]);
    if (health.code !== 0) return { state: "setup-required", message: "Cua daemon is running but the end-to-end health probe failed", version: versionText };
    if (windows.code !== 0) return { state: "setup-required", message: "Cua daemon cannot list accessible windows", version: versionText };
    const windowResult = parseResult(windows.stdout);
    const windowList = windowResult.structuredContent?.windows;
    if (!Array.isArray(windowList) || windowList.length === 0) return { state: "setup-required", message: "Cua runtime has no accessible on-screen window", version: versionText };
    return { state: "ready", message: "Cua daemon and platform probes are ready", version: versionText };
  } catch (error) {
    return { state: "unavailable", message: `Cua runtime is unavailable: ${errorMessage(error)}`.slice(0, 1_000), version: null };
  }
}
