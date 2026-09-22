import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import type { ComputerDiagnostics } from "../contracts/host.js";
import { selectH264Encoder } from "../media/video.js";
import { resolveFortressExecutable } from "./browser-runtime.js";
import { DesktopRuntime, resolveCuaExecutable } from "./desktop-runtime.js";

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const SUPPORTED_CUA_VERSION = "0.28.2";
const INSTALLER_URL = process.platform === "win32" ? "https://cua.ai/driver/install.ps1" : "https://cua.ai/driver/install.sh";

function runCommand(binary: string, args: readonly string[], signal: AbortSignal, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      result();
    };
    const abort = () => { child.kill("SIGTERM"); finish(() => reject(new Error("Computer setup cancelled"))); };
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(() => reject(new Error("Computer setup command timed out"))); }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(0, 128_000); });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 8_000); });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

interface CuaDoctorProbe {
  readonly label?: string;
  readonly message?: string;
  readonly detail?: string;
  readonly status?: string;
}

function doctorProbe(probes: readonly CuaDoctorProbe[], pattern: RegExp): CuaDoctorProbe | undefined {
  return probes.find((probe) => pattern.test(probe.label ?? ""));
}

function probeDetail(probe: CuaDoctorProbe | undefined, fallback: string): string {
  if (!probe) return fallback;
  return [probe.message, probe.detail].filter(Boolean).join(" ").slice(0, 1_000) || fallback;
}

export async function inspectComputer(dataDir: string, signal: AbortSignal): Promise<ComputerDiagnostics> {
  const checkedAt = Date.now();
  const binary = await resolveCuaExecutable();
  if (binary === null) {
    const missing = { state: "missing" as const, detail: "Cua Driver is not installed or is not on PATH. Install it on this machine, then run setup again." };
    return {
      platform: { os: process.platform, arch: process.arch },
      graphicalSession: { state: "missing", detail: "A graphical session cannot be verified without Cua Driver." },
      cua: { ...missing, version: null },
      capture: { ...missing, latencyMs: null, width: null, height: null },
      accessibility: missing,
      input: missing,
      video: { state: "missing", detail: "Video recording was not checked because desktop capture is unavailable.", encoder: null },
      browser: { state: "warning", detail: "Browser availability was not checked because computer control is unavailable." },
      ready: false,
      checkedAt,
    };
  }

  const [versionResult, doctorResult, browser] = await Promise.all([
    runCommand(binary, ["--version"], signal, 5_000).catch(() => ({ code: null, stdout: "", stderr: "" })),
    runCommand(binary, ["doctor", "--json"], signal, 10_000).catch(() => ({ code: null, stdout: "", stderr: "" })),
    resolveFortressExecutable(),
  ]);
  const version = versionResult.code === 0 ? versionResult.stdout.trim().slice(0, 100) || null : null;
  let probes: readonly CuaDoctorProbe[] = [];
  try {
    const report = JSON.parse(doctorResult.stdout) as { probes?: CuaDoctorProbe[] };
    probes = Array.isArray(report.probes) ? report.probes : [];
  } catch { /* The capture test below remains authoritative. */ }

  const displayProbe = doctorProbe(probes, /display server|desktop session|window station|screen recording/iu);
  const displayOk = displayProbe?.status === "ok" || (displayProbe === undefined && (process.platform === "win32" || process.platform === "darwin" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)));
  const graphicalSession = {
    state: displayOk ? "ready" as const : "missing" as const,
    detail: probeDetail(displayProbe, displayOk ? "An interactive graphical session is available." : "No interactive graphical session was detected."),
  };

  let capture: ComputerDiagnostics["capture"] = { state: "missing", detail: "Whole-desktop capture failed.", latencyMs: null, width: null, height: null };
  let tree: { available: boolean; detail: string } = { available: false, detail: "Accessibility tree was not checked." };
  const runtime = new DesktopRuntime(`${dataDir}/setup-probe`);
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const started = Date.now();
    const frame = await runtime.capture(signal);
    capture = { state: "ready", detail: "Whole-desktop screenshot capture succeeded.", latencyMs: Date.now() - started, width: frame.width, height: frame.height };
  } catch (error) {
    capture = { state: "missing", detail: error instanceof Error ? error.message.slice(0, 1_000) : "Whole-desktop capture failed.", latencyMs: null, width: null, height: null };
  }
  try {
    tree = await runtime.inspectAccessibility(signal);
  } catch (error) {
    tree = { available: false, detail: error instanceof Error ? error.message.slice(0, 1_000) : "Accessibility tree probe failed." };
  } finally {
    await runtime.dispose().catch(() => undefined);
  }

  const accessibilityProbe = doctorProbe(probes, /AT-SPI|accessibility|UI Automation/iu);
  const explicitAccessibilityFailure = accessibilityProbe !== undefined && accessibilityProbe.status !== "ok";
  const accessibilityReady = tree.available && !explicitAccessibilityFailure;
  const accessibility = {
    state: accessibilityReady ? "ready" as const : capture.state === "ready" ? "warning" as const : "missing" as const,
    detail: explicitAccessibilityFailure ? probeDetail(accessibilityProbe, tree.detail) : tree.detail,
  };
  const inputBlocked = process.platform === "darwin" && !accessibilityReady;
  const input = {
    state: capture.state !== "ready" || inputBlocked ? "missing" as const : accessibilityReady ? "ready" as const : "warning" as const,
    detail: capture.state !== "ready"
      ? "Input is disabled until desktop capture succeeds."
      : inputBlocked
        ? "macOS Accessibility permission is required for input control."
        : accessibilityReady
          ? "Bounded keyboard and pointer control is available."
          : "Pixel input may work, but semantic accessibility control is not ready.",
  };

  let video: ComputerDiagnostics["video"];
  try {
    const selected = await selectH264Encoder({ signal });
    video = { state: "ready", detail: `H.264 test encoding succeeded with ${selected.encoder}.`, encoder: selected.encoder };
  } catch (error) {
    video = { state: "missing", detail: error instanceof Error ? error.message.slice(0, 1_000) : "No functional H.264 encoder was found.", encoder: null };
  }

  const ready = graphicalSession.state === "ready" && capture.state === "ready" && accessibility.state === "ready" && input.state === "ready" && video.state === "ready";
  return {
    platform: { os: process.platform, arch: process.arch },
    graphicalSession,
    cua: { state: doctorResult.code === 0 ? "ready" : "warning", detail: doctorResult.code === 0 ? "Cua Driver diagnostics completed." : "Cua Driver responded, but its doctor command did not complete cleanly.", version },
    capture,
    accessibility,
    input,
    video,
    browser: { state: browser === null ? "warning" : "ready", detail: browser === null ? "No supported browser was found. Desktop control remains available." : "Fortress is available for browser tasks." },
    ready,
    checkedAt,
  };
}

async function installCuaDriver(dataDir: string, signal: AbortSignal): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const response = await fetch(INSTALLER_URL, { signal, redirect: "follow" });
  if (!response.ok) throw new Error(`Cua Driver installer download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 1_048_576) throw new Error("Cua Driver installer exceeded the download limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 1_048_576) throw new Error("Cua Driver installer was empty or exceeded the download limit");
  const directory = await mkdtemp(join(dataDir, "installer-"));
  const script = join(directory, process.platform === "win32" ? "install.ps1" : "install.sh");
  try {
    await writeFile(script, bytes, { mode: 0o700 });
    await chmod(script, 0o700).catch(() => undefined);
    const env = { ...process.env, CUA_DRIVER_RS_VERSION: SUPPORTED_CUA_VERSION, CUA_DRIVER_RS_NO_MODIFY_PATH: "1" };
    const result = process.platform === "win32"
      ? await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-NoAutoStart", "-NoPathUpdate"], signal, 180_000, env)
      : await runCommand("/bin/bash", [script, "--no-modify-path"], signal, 180_000, env);
    if (result.code !== 0) throw new Error(`Cua Driver installer failed: ${(result.stderr || result.stdout || `exit ${result.code ?? "signal"}`).slice(0, 1_000)}`);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function setupComputer(dataDir: string, options: { requestPermissions: boolean }, signal: AbortSignal): Promise<ComputerDiagnostics> {
  let binary = await resolveCuaExecutable();
  const installedVersion = binary === null ? null : await runCommand(binary, ["--version"], signal, 5_000).catch(() => null);
  if (binary === null || installedVersion?.code !== 0 || !installedVersion.stdout.includes(SUPPORTED_CUA_VERSION)) {
    await installCuaDriver(dataDir, signal);
    binary = await resolveCuaExecutable();
    if (binary === null) return inspectComputer(dataDir, signal);
  }
  if (options.requestPermissions && process.platform === "darwin") {
    const child = spawn(binary, ["permissions", "grant"], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const report = await inspectComputer(dataDir, signal);
    if (!report.ready) {
      return {
        ...report,
        capture: report.capture.state === "ready" ? report.capture : { ...report.capture, detail: `macOS permission request opened. Approve Screen Recording, then rerun doctor. ${report.capture.detail}`.slice(0, 1_000) },
        accessibility: report.accessibility.state === "ready" ? report.accessibility : { ...report.accessibility, detail: `macOS permission request opened. Approve Accessibility, then rerun doctor. ${report.accessibility.detail}`.slice(0, 1_000) },
      };
    }
    return report;
  }
  return inspectComputer(dataDir, signal);
}
