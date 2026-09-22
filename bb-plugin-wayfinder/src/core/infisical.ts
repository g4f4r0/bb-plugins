import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Verified project/environment/folder scope for one Infisical call. Never a secret itself. */
export interface InfisicalScope {
  readonly projectId: string;
  readonly env: string;
  readonly path: string;
}

export interface ProviderTestResult {
  readonly ok: boolean;
  readonly status: number;
  readonly message: string;
}

const MAX_STDOUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Runs the Infisical CLI as a bounded child process. stdout is captured only
 * when the caller asks for it (a secret value transiting a pipe, never a log
 * or a shell argument); stderr is always discarded. The caller decides what,
 * if anything, from stdout is safe to keep past this call.
 */
function runCli(bin: string, args: readonly string[], opts: { captureStdout: boolean; timeoutMs: number; input?: string }): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args as string[], { stdio: [opts.input === undefined ? "ignore" : "pipe", opts.captureStdout ? "pipe" : "ignore", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks) });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(1); }, opts.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) { child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
    if (opts.input !== undefined) { child.stdin!.write(opts.input); child.stdin!.end(); }
  });
}

export interface InfisicalClient {
  /** Resolves exactly one named secret's current value, or null if unset/unreachable. Never logs or persists the value. */
  resolveSecret(scope: InfisicalScope, name: string): Promise<string | null>;
  /** True only if the named secret currently resolves to a non-empty value. Never returns the value. */
  secretConfigured(scope: InfisicalScope, name: string): Promise<boolean>;
  /** Writes one named secret via a private 0600 temp file, deleted immediately after. Never logs the value. */
  setSecret(scope: InfisicalScope, name: string, value: string): Promise<boolean>;
  /** Injects the named secret into a bounded child that performs one readiness probe and reports only a status object. */
  testProviderKey(scope: InfisicalScope, name: string, probeUrl: string, authHeader: string, body?: Record<string, unknown>): Promise<ProviderTestResult>;
}

/** Real Infisical CLI-backed client. `bin` is overridable for tests only. */
export function createInfisicalClient(bin = "infisical", timeoutMs = DEFAULT_TIMEOUT_MS): InfisicalClient {
  const scopeArgs = (scope: InfisicalScope) => ["--env", scope.env, "--projectId", scope.projectId, "--path", scope.path, "--silent", "--log-level", "error"];

  async function resolveSecret(scope: InfisicalScope, name: string): Promise<string | null> {
    const script = `process.stdout.write(process.env[${JSON.stringify(name)}] ?? "")`;
    const args = ["run", ...scopeArgs(scope), "--", "node", "-e", script];
    const { code, stdout } = await runCli(bin, args, { captureStdout: true, timeoutMs });
    if (code !== 0) return null;
    const value = stdout.toString("utf8").trim();
    return value.length > 0 ? value : null;
  }

  return {
    resolveSecret,
    async secretConfigured(scope, name) {
      return (await resolveSecret(scope, name)) !== null;
    },
    async setSecret(scope, name, value) {
      const dir = await mkdtemp(join(tmpdir(), "wf-secret-"));
      await chmod(dir, 0o700);
      const file = join(dir, "value");
      try {
        await writeFile(file, value, { mode: 0o600 });
        await chmod(file, 0o600);
        const args = ["secrets", "set", `${name}=@${file}`, ...scopeArgs(scope)];
        const { code } = await runCli(bin, args, { captureStdout: false, timeoutMs });
        return code === 0;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    async testProviderKey(scope, name, probeUrl, authHeader, body) {
      const script = [
        `const key = process.env[${JSON.stringify(name)}];`,
        `if (!key) { process.stdout.write(JSON.stringify({ok:false,status:0,message:"missing"})); process.exit(1); }`,
        `fetch(${JSON.stringify(probeUrl)}, { method: ${JSON.stringify(body === undefined ? "GET" : "POST")}, headers: { ${JSON.stringify(authHeader)}: "Bearer " + key, "content-type": "application/json" }, body: ${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))}, signal: AbortSignal.timeout(8000) })`,
        `  .then((r) => { process.stdout.write(JSON.stringify({ok:r.ok,status:r.status,message:r.ok?"ready":"rejected"})); process.exit(r.ok?0:1); })`,
        `  .catch(() => { process.stdout.write(JSON.stringify({ok:false,status:0,message:"network-error"})); process.exit(1); });`,
      ].join("\n");
      const args = ["run", ...scopeArgs(scope), "--", "node", "-e", script];
      const { stdout } = await runCli(bin, args, { captureStdout: true, timeoutMs });
      try {
        const parsed: unknown = JSON.parse(stdout.toString("utf8").trim() || "{}");
        const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
        return {
          ok: record.ok === true,
          status: typeof record.status === "number" ? record.status : 0,
          message: typeof record.message === "string" ? record.message : "unreadable-response",
        };
      } catch {
        return { ok: false, status: 0, message: "unreadable-response" };
      }
    },
  };
}
