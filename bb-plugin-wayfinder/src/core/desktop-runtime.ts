import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { HumanInput } from "../contracts/run.js";
import { ProcessCuaTransport } from "../adapters/cua-client.js";
import { resolveFortressExecutable } from "./browser-runtime.js";

const MANIFEST = JSON.stringify({
  version: 1,
  mode: "bounded",
  expires_after: "12h",
  idle_timeout: "10m",
  resources: { desktop: { display: true } },
  allow: { tools: ["get_desktop_state", "click", "scroll", "type_text", "press_key"] },
});
const MAX_FRAME_BYTES = 1_100_000;
const DESKTOP_TARGET = { kind: "desktop", display_id: "primary" } as const;
const IDLE_DESKTOP_HTML = "<!doctype html><meta name=color-scheme content=dark><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0b0b0d;color:#a1a1aa;font:14px system-ui,sans-serif}.shell{text-align:center}.mark{margin:auto auto 16px;width:40px;height:40px;border:1px solid #3f3f46;border-radius:10px;display:grid;place-items:center;color:#fafafa;font-size:20px}strong{display:block;color:#fafafa;font-size:16px;margin-bottom:6px}</style><div class=shell><div class=mark>W</div><strong>Wayfinder Computer</strong><span>Ready for browser and desktop tasks</span></div>";

export interface DesktopFrame {
  readonly bytes: Buffer;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
}

async function executable(): Promise<string | null> {
  const name = process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
  const candidates = [process.env.WAYFINDER_CUA_DRIVER, join(homedir(), ".local", "bin", name), ...(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean).map((directory) => join(directory, name))].filter((value): value is string => Boolean(value));
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
  #shellProcess: ChildProcess | null = null;
  #shellProfile: string | null = null;
  #starting: Promise<void> | null = null;
  #capture: Promise<DesktopFrame> | null = null;

  constructor(dataDir: string) { this.#dataDir = dataDir; }

  async available(): Promise<boolean> { return await executable() !== null; }

  async capture(signal: AbortSignal): Promise<DesktopFrame> {
    if (this.#capture) return this.#capture;
    this.#capture = this.#captureOnce(signal).finally(() => { this.#capture = null; });
    return this.#capture;
  }

  async input(input: HumanInput, signal: AbortSignal): Promise<void> {
    await this.#start(signal);
    const transport = this.#transport!;
    const common = { target: DESKTOP_TARGET, scope: "desktop", delivery_mode: "foreground" };
    if (input.kind === "click") await transport.call("click", { ...common, x: input.x, y: input.y, button: input.button }, signal);
    else if (input.kind === "wheel") {
      const horizontal = Math.abs(input.deltaX) > Math.abs(input.deltaY);
      const delta = horizontal ? input.deltaX : input.deltaY;
      await transport.call("scroll", { ...common, x: input.x, y: input.y, direction: horizontal ? (delta < 0 ? "left" : "right") : (delta < 0 ? "up" : "down"), by: "line", amount: Math.max(1, Math.min(50, Math.ceil(Math.abs(delta) / 40))) }, signal);
    } else if (input.kind === "text") await transport.call("type_text", { ...common, text: input.text }, signal);
    else {
      const modifiers = [input.modifiers & 1 ? "alt" : null, input.modifiers & 2 ? "ctrl" : null, input.modifiers & 4 ? "cmd" : null, input.modifiers & 8 ? "shift" : null].filter((value): value is string => value !== null);
      await transport.call("press_key", { ...common, key: input.key, modifiers }, signal);
    }
  }

  async dispose(): Promise<void> {
    const child = this.#process;
    this.#process = null;
    this.#transport = null;
    await this.#stopChild(child);
    await this.#stopChild(this.#shellProcess);
    this.#shellProcess = null;
    if (this.#shellProfile !== null) await rm(this.#shellProfile, { recursive: true, force: true }).catch(() => undefined);
    this.#shellProfile = null;
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
    const result = await this.#transport!.call("get_desktop_state", {}, signal);
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
      this.#binary = await executable();
      if (this.#binary === null) throw new Error(`Cua Driver is not installed for ${process.platform}/${process.arch}`);
      await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
      const manifest = join(this.#dataDir, "desktop-capabilities.json");
      this.#socket = process.platform === "win32" ? `\\\\.\\pipe\\wayfinder-cua-${process.pid}` : join(tmpdir(), `wayfinder-cua-${process.pid}.sock`);
      await writeFile(manifest, MANIFEST, { mode: 0o600 });
      await chmod(manifest, 0o600).catch(() => undefined);
      await rm(this.#socket, { force: true }).catch(() => undefined);
      await this.#startDesktopShell();
      this.#process = spawn(this.#binary, ["serve", "--embedded", "--socket", this.#socket, "--permission-mode", "bounded", "--capability-manifest", manifest, "--approve-capability-manifest", "--no-overlay"], { stdio: "ignore", env: process.env });
      this.#process.once("exit", () => { this.#process = null; this.#transport = null; });
      const deadline = Date.now() + 5_000;
      while (process.platform !== "win32" && Date.now() < deadline) {
        signal.throwIfAborted();
        try { await access(this.#socket); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      if (this.#process === null) throw new Error("Cua Driver stopped before desktop capture became ready");
      this.#transport = new ProcessCuaTransport({ binaryPath: this.#binary, socketPath: this.#socket, session: `wayfinder-${process.pid}`, timeoutMs: 10_000, maxOutputBytes: 16_000_000 });
    })().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  async #startDesktopShell(): Promise<void> {
    if (process.platform !== "linux" || process.env.DISPLAY === undefined || this.#shellProcess !== null) return;
    const fortress = await resolveFortressExecutable();
    if (fortress === null) return;
    this.#shellProfile = await mkdtemp(join(this.#dataDir, "shell-profile-"));
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(IDLE_DESKTOP_HTML)}`;
    this.#shellProcess = spawn(fortress, [
      `--user-data-dir=${this.#shellProfile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
      "--start-maximized", "--window-size=1280,720", url,
    ], { stdio: "ignore", env: process.env });
    this.#shellProcess.once("exit", () => { this.#shellProcess = null; });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
