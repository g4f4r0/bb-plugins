import { spawn } from "node:child_process";

export class MediaProcessError extends Error {
  override readonly name = "MediaProcessError";

  constructor(
    readonly code: "timeout" | "output-too-large" | "failed" | "aborted" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface RunMediaProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly signal?: AbortSignal;
}

/**
 * Runs ffmpeg/ffprobe with an argument array (never a shell), a hard timeout,
 * a stdout cap, and a short stderr tail. Kills the child on any bound.
 */
export function runMediaProcess(options: RunMediaProcessOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new MediaProcessError("aborted", "Media process aborted"));
      return;
    }
    const child = spawn(options.executable, [...options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";
    let failure: MediaProcessError | null = null;
    const stop = (error: MediaProcessError) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new MediaProcessError("timeout", "Media process timed out")), options.timeoutMs);
    const onAbort = () => stop(new MediaProcessError("aborted", "Media process aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) {
        stop(new MediaProcessError("output-too-large", "Media process output exceeded its limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??= new MediaProcessError(error.code === "ENOENT" ? "unavailable" : "failed", `Cannot start ${options.executable}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure !== null) reject(failure);
      else if (code !== 0) reject(new MediaProcessError("failed", `${options.executable} exited ${code}: ${stderrTail.trim().slice(-500)}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(options.stdin === undefined ? undefined : Buffer.from(options.stdin));
  });
}
