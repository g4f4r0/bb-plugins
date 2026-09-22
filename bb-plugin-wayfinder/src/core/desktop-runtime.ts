import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { HumanInput } from "../contracts/run.js";
import { ProcessCuaTransport, type CuaToolResult } from "../adapters/cua-client.js";
import { errorMessage } from "./errors.js";

export const DESKTOP_CAPABILITY_TOOLS = ["get_desktop_state", "get_accessibility_tree", "get_window_state", "list_windows", "health_report", "click", "drag", "scroll", "type_text", "press_key", "start_recording", "stop_recording", "get_recording_state"] as const;
function capabilityManifest(recordingRoot: string): string {
  return JSON.stringify({
    version: 3,
    expires_after: "12h",
    idle_timeout: "10m",
    resources: { desktop: { display: true }, files: { write: [{ dir: recordingRoot, recursive: true }] } },
    allow: { tools: DESKTOP_CAPABILITY_TOOLS },
  });
}
const MAX_FRAME_BYTES = 1_100_000;
const DESKTOP_TARGET = { kind: "desktop", display_id: "primary" } as const;

export function cuaLaunchStrategy(platform: NodeJS.Platform): "launchservices" | "embedded" {
  return platform === "darwin" ? "launchservices" : "embedded";
}

export function desktopInputCall(input: HumanInput): { tool: "click" | "drag" | "scroll" | "type_text" | "press_key"; payload: Record<string, unknown> } {
  // Cua's portable target contract forbids combining `target` with the
  // legacy flat `scope` field. Mixing both is refused on macOS.
  const common = { target: DESKTOP_TARGET, delivery_mode: "foreground" };
  if (input.kind === "click") return { tool: "click", payload: { ...common, x: input.x, y: input.y, button: input.button } };
  if (input.kind === "drag") return { tool: "drag", payload: { ...common, from_x: input.fromX, from_y: input.fromY, to_x: input.toX, to_y: input.toY, button: input.button, duration_ms: input.durationMs, steps: 20 } };
  if (input.kind === "wheel") {
    const horizontal = Math.abs(input.deltaX) > Math.abs(input.deltaY);
    const delta = horizontal ? input.deltaX : input.deltaY;
    return { tool: "scroll", payload: { ...common, x: input.x, y: input.y, direction: horizontal ? (delta < 0 ? "left" : "right") : (delta < 0 ? "up" : "down"), by: "line", amount: Math.max(1, Math.min(50, Math.ceil(Math.abs(delta) / 40))) } };
  }
  if (input.kind === "text") return { tool: "type_text", payload: { ...common, text: input.text } };
  const modifiers = [input.modifiers & 1 ? "alt" : null, input.modifiers & 2 ? "ctrl" : null, input.modifiers & 4 ? "cmd" : null, input.modifiers & 8 ? "shift" : null].filter((value): value is string => value !== null);
  return { tool: "press_key", payload: { ...common, key: input.key, modifiers } };
}

export interface DesktopFrame {
  readonly bytes: Buffer;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
}

export async function resolveCuaExecutable(): Promise<string | null> {
  const name = process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
  const candidates = [
    process.env.WAYFINDER_CUA_DRIVER,
    join(homedir(), ".local", "bin", name),
    join(homedir(), ".cua-driver", "packages", "current", name),
    ...(process.platform === "darwin" ? ["/Applications/CuaDriver.app/Contents/MacOS/cua-driver"] : []),
    ...(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean).map((directory) => join(directory, name)),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* next */ }
  }
  return null;
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") throw new Error("Cua returned an invalid desktop image");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function run(binary: string, args: string[], input: Buffer, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_FRAME_BYTES) chunks.push(chunk); else child.kill("SIGTERM"); });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new Error("Desktop capture cancelled"));
      else if (code !== 0 || size > MAX_FRAME_BYTES) reject(new Error("Desktop frame could not be compressed within the private preview limit"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

async function compress(bytes: Buffer, width: number, height: number, signal: AbortSignal): Promise<DesktopFrame> {
  if (bytes.length <= MAX_FRAME_BYTES && width <= 1_920 && height <= 1_080) return { bytes, mimeType: "image/png", width, height, capturedAt: Date.now() };
  const scale = Math.min(1, 1_920 / width, 1_080 / height);
  const targetWidth = Math.max(2, Math.floor(width * scale / 2) * 2);
  const targetHeight = Math.max(2, Math.floor(height * scale / 2) * 2);
  const jpeg = await run(process.env.WAYFINDER_FFMPEG ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0", "-vf", `scale=${targetWidth}:${targetHeight}`, "-frames:v", "1", "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], bytes, signal);
  return { bytes: jpeg, mimeType: "image/jpeg", width: targetWidth, height: targetHeight, capturedAt: Date.now() };
}

export class DesktopRuntime {
  readonly #dataDir: string;
  #binary: string | null = null;
  #socket = "";
  #process: ChildProcess | null = null;
  #transport: ProcessCuaTransport | null = null;
  #starting: Promise<void> | null = null;
  #capture: Promise<DesktopFrame> | null = null;

  constructor(dataDir: string) { this.#dataDir = dataDir; }

  async available(): Promise<boolean> { return await resolveCuaExecutable() !== null; }

  async capture(signal: AbortSignal): Promise<DesktopFrame> {
    if (this.#capture) return this.#capture;
    this.#capture = this.#captureOnce(signal).finally(() => { this.#capture = null; });
    return this.#capture;
  }

  async inspectAccessibility(signal: AbortSignal): Promise<{ available: boolean; detail: string }> {
    await this.#start(signal);
    const listed = await this.#transport!.call("list_windows", { on_screen_only: true }, signal);
    const windows = Array.isArray(listed.structuredContent?.windows) ? listed.structuredContent.windows : [];
    let failure = "No visible window was available for a semantic accessibility probe.";
    for (const window of windows.slice(0, 6)) {
      if (window === null || typeof window !== "object") continue;
      const candidate = window as Record<string, unknown>;
      if (typeof candidate.pid !== "number" || typeof candidate.window_id !== "number") continue;
      try {
        const result = await this.#transport!.call("get_window_state", {
          pid: candidate.pid,
          window_id: candidate.window_id,
          include_screenshot: false,
          max_elements: 100,
        }, signal);
        const data = result.structuredContent ?? {};
        if (data.degraded === true) {
          failure = typeof data.degraded_reason === "string" ? data.degraded_reason.slice(0, 1_000) : "Semantic accessibility used a degraded non-semantic fallback.";
          continue;
        }
        const elements = data.elements;
        if (Array.isArray(elements)) return { available: true, detail: `Semantic accessibility responded (${elements.length} elements).` };
        failure = "Semantic accessibility returned no element data.";
      } catch (error) {
        failure = errorMessage(error).slice(0, 1_000);
      }
    }
    return { available: false, detail: failure };
  }

  async input(input: HumanInput, signal: AbortSignal): Promise<void> {
    await this.#start(signal);
    const transport = this.#transport!;
    const call = desktopInputCall(input);
    await transport.call(call.tool, call.payload, signal);
  }

  async startRecording(outputDir: string, signal: AbortSignal): Promise<void> {
    await this.#start(signal);
    const state = await this.#transport!.call("start_recording", { output_dir: outputDir, record_video: true }, signal);
    if (state.structuredContent?.video_active !== true) throw new Error("Cua did not start desktop video capture");
  }

  async stopRecording(signal: AbortSignal): Promise<void> {
    if (this.#transport === null) throw new Error("Cua recording runtime is unavailable");
    await this.#transport.call("stop_recording", {}, signal);
  }

  async dispose(): Promise<void> {
    const child = this.#process;
    const transport = this.#transport;
    this.#process = null;
    this.#transport = null;
    if (transport !== null) await transport.close(AbortSignal.timeout(1_000)).catch(() => undefined);
    await this.#stopChild(child);
    if (process.platform === "darwin" && this.#binary !== null && this.#socket !== "") {
      const stopper = spawn(this.#binary, ["stop", "--socket", this.#socket], { stdio: "ignore", env: process.env });
      await this.#waitForExit(stopper, 2_000);
      if (stopper.exitCode === null && stopper.signalCode === null) stopper.kill("SIGKILL");
    }
    await rm(this.#socket, { force: true }).catch(() => undefined);
  }

  async #stopChild(child: ChildProcess | null): Promise<void> {
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (!await this.#waitForExit(child, 1_000)) {
      child.kill("SIGKILL");
      await this.#waitForExit(child, 1_000);
    }
  }

  async #waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.removeListener("exit", exited); resolve(false); }, timeoutMs);
      const exited = () => { clearTimeout(timer); resolve(true); };
      child.once("exit", exited);
    });
  }

  async #captureOnce(signal: AbortSignal): Promise<DesktopFrame> {
    await this.#start(signal);
    let result: CuaToolResult;
    try {
      result = await this.#transport!.call("get_desktop_state", {}, signal);
    } catch (error) {
      const detail = errorMessage(error);
      if (process.platform === "darwin") {
        throw new Error(`Desktop capture failed. Grant Screen Recording to Cua Driver in System Settings > Privacy & Security, then reopen Computer. ${detail}`);
      }
      throw new Error(`Desktop capture failed. ${detail}`);
    }
    const data = result.structuredContent ?? {};
    const encoded = data.screenshot_png_b64;
    if (typeof encoded !== "string" || encoded.length === 0) throw new Error("Cua did not return a desktop screenshot");
    const bytes = Buffer.from(encoded, "base64");
    const declaredWidth = Number(data.screenshot_width ?? data.screen_width);
    const declaredHeight = Number(data.screenshot_height ?? data.screen_height);
    const parsed = pngSize(bytes);
    const width = Number.isInteger(declaredWidth) && declaredWidth > 0 ? declaredWidth : parsed.width;
    const height = Number.isInteger(declaredHeight) && declaredHeight > 0 ? declaredHeight : parsed.height;
    return compress(bytes, width, height, signal);
  }

  async #start(signal: AbortSignal): Promise<void> {
    if (this.#transport !== null) return;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      this.#binary = await resolveCuaExecutable();
      if (this.#binary === null) throw new Error(`Cua Driver is not installed for ${process.platform}/${process.arch}`);
      await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
      const recordingRoot = join(this.#dataDir, "recordings");
      await mkdir(recordingRoot, { recursive: true, mode: 0o700 });
      const manifest = join(this.#dataDir, "desktop-capabilities.json");
      this.#socket = process.platform === "win32" ? `\\\\.\\pipe\\wayfinder-cua-${process.pid}` : join(tmpdir(), `wayfinder-cua-${process.pid}.sock`);
      await writeFile(manifest, capabilityManifest(recordingRoot), { mode: 0o600 });
      await chmod(manifest, 0o600).catch(() => undefined);
      await rm(this.#socket, { force: true }).catch(() => undefined);
      const serveArgs = ["serve", "--socket", this.#socket, "--permission-mode", "bounded", "--capability-manifest", manifest, "--approve-capability-manifest"];
      const runtimeEnv = { ...process.env };
      if (process.platform === "linux" && !runtimeEnv.AT_SPI_BUS_ADDRESS) {
        const cacheBus = join(homedir(), ".cache", "at-spi", "bus");
        try { await access(cacheBus); runtimeEnv.AT_SPI_BUS_ADDRESS = `unix:path=${cacheBus}`; } catch { /* Normal login sessions discover AT-SPI through D-Bus. */ }
      }
      if (cuaLaunchStrategy(process.platform) === "launchservices") {
        // LaunchServices makes the signed CuaDriver.app, not BB's generic Node
        // daemon, the macOS TCC owner shown in Privacy & Security.
        const launcher = spawn("/usr/bin/open", ["-n", "-g", "-a", "CuaDriver", "--args", ...serveArgs], { stdio: "ignore", env: runtimeEnv });
        if (!await this.#waitForExit(launcher, 5_000) || launcher.exitCode !== 0) throw new Error("CuaDriver.app could not be started through LaunchServices");
      } else {
        this.#process = spawn(this.#binary, [serveArgs[0]!, "--embedded", ...serveArgs.slice(1)], { stdio: "ignore", env: runtimeEnv });
        this.#process.once("exit", () => { this.#process = null; this.#transport = null; });
      }
      const deadline = Date.now() + 5_000;
      while (process.platform !== "win32" && Date.now() < deadline) {
        signal.throwIfAborted();
        try { await access(this.#socket); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      if (process.platform !== "darwin" && this.#process === null) throw new Error("Cua Driver stopped before desktop capture became ready");
      this.#transport = new ProcessCuaTransport({ binaryPath: this.#binary, socketPath: this.#socket, session: `wayfinder-${process.pid}`, timeoutMs: 5_000, maxOutputBytes: 16_000_000 });
    })().finally(() => { this.#starting = null; });
    return this.#starting;
  }
}
