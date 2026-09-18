import { execFile } from "node:child_process";
import { readFile, readlink, statfs } from "node:fs/promises";
import { arch, cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import { basename } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createDemandSampler } from "./lib/demand-sampler.ts";
import { createPressureMonitor } from "./lib/pressure-monitor.ts";
import { PRESSURE_CHANNEL } from "./lib/pressure.ts";

const percentageSchema = z.number().min(0).max(100);
const metricPointSchema = z.object({
  timestamp: z.number(),
  cpuPercent: percentageSchema.nullable(),
  memoryPercent: percentageSchema,
  networkRxBytesPerSecond: z.number().nullable(),
  networkTxBytesPerSecond: z.number().nullable(),
});
const issueSchema = z.object({
  severity: z.enum(["warning", "critical"]),
  label: z.string(),
  message: z.string(),
});
const processSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().max(128),
  cpuPercent: z.number().nonnegative(),
  memoryPercent: z.number().nonnegative(),
  rssBytes: z.number().nonnegative(),
});
const snapshotSchema = z.object({
  timestamp: z.string(),
  refreshIntervalMs: z.number().int().min(2000).max(60_000),
  host: z.object({
    hostname: z.string(),
    platform: z.string(),
    release: z.string(),
    arch: z.string(),
    uptimeSeconds: z.number(),
  }),
  cpu: z.object({
    model: z.string(),
    cores: z.number().int().positive(),
    speedMHz: z.number().nonnegative(),
    usagePercent: percentageSchema.nullable(),
    perCoreUsagePercent: z.array(percentageSchema.nullable()),
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
  }),
  memory: z.object({
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    availableBytes: z.number(),
    cachedBytes: z.number(),
    buffersBytes: z.number(),
    swapTotalBytes: z.number(),
    swapUsedBytes: z.number(),
    usagePercent: percentageSchema,
  }),
  disk: z.object({
    mount: z.string(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    usagePercent: percentageSchema,
  }).nullable(),
  network: z.object({
    interface: z.string(),
    rxBytesPerSecond: z.number().nullable(),
    txBytesPerSecond: z.number().nullable(),
    rxTotalBytes: z.number(),
    txTotalBytes: z.number(),
  }).nullable(),
  processes: z.object({
    available: z.boolean(),
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    top: z.array(processSchema).max(6),
  }),
  runtime: z.object({
    pid: z.number().int().positive(),
    nodeVersion: z.string(),
    processUptimeSeconds: z.number(),
    rssBytes: z.number(),
    heapUsedBytes: z.number(),
    heapTotalBytes: z.number(),
    externalBytes: z.number(),
  }),
  health: z.object({
    status: z.enum(["healthy", "warning", "critical"]),
    issues: z.array(issueSchema),
  }),
  history: z.array(metricPointSchema).max(72),
});

export type ServerSnapshot = z.infer<typeof snapshotSchema>;
type MetricPoint = z.infer<typeof metricPointSchema>;
type Processes = z.infer<typeof snapshotSchema>["processes"];

export const rpcContract = defineRpcContract({
  metrics_snapshot: { input: z.null(), output: snapshotSchema },
  metrics_refresh: { input: z.null(), output: snapshotSchema },
  monitor_status: { input: z.null(), output: z.object({ enabled: z.boolean(), notifications: z.boolean(), cursor: z.number(), active: z.array(z.object({ sequence: z.number(), type: z.enum(["incident", "recovery"]), metric: z.enum(["cpu", "memory"]), timestamp: z.number(), value: z.number(), peak: z.number(), durationSeconds: z.number(), threshold: z.number() })).max(2), recent: z.array(z.object({ sequence: z.number(), type: z.enum(["incident", "recovery"]), metric: z.enum(["cpu", "memory"]), timestamp: z.number(), value: z.number(), peak: z.number(), durationSeconds: z.number(), threshold: z.number() })).max(32) }) },
});

const ROOT_MOUNT = "/";
const HISTORY_LIMIT = 72;
const execFileAsync = promisify(execFile);

interface CpuTimes { idle: number; total: number }
interface NetworkTotals { interface: string; rxBytes: number; txBytes: number }
interface MemoryDetails {
  availableBytes: number;
  cachedBytes: number;
  buffersBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function calculateNetworkRates(previous: NetworkTotals | null, current: NetworkTotals, elapsedSeconds: number | null) {
  if (!previous || previous.interface !== current.interface || elapsedSeconds === null || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || current.rxBytes < previous.rxBytes || current.txBytes < previous.txBytes) {
    return { rxBytesPerSecond: null, txBytesPerSecond: null };
  }
  return { rxBytesPerSecond: (current.rxBytes - previous.rxBytes) / elapsedSeconds, txBytesPerSecond: (current.txBytes - previous.txBytes) / elapsedSeconds };
}

export function calculateCpuUsage(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (previous === null) return null;
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  return clampPercentage(((totalDelta - idleDelta) / totalDelta) * 100);
}

function cpuTimesFor(cpu: ReturnType<typeof cpus>[number]): CpuTimes {
  return {
    idle: cpu.times.idle,
    total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
  };
}

function readCpuTimes(cpuList: ReturnType<typeof cpus>): CpuTimes {
  return cpuList.map(cpuTimesFor).reduce(
    (result, current) => ({ idle: result.idle + current.idle, total: result.total + current.total }),
    { idle: 0, total: 0 },
  );
}

async function readMemoryDetails(signal: AbortSignal): Promise<MemoryDetails> {
  const fallbackAvailable = freemem();
  const fallback: MemoryDetails = {
    availableBytes: fallbackAvailable,
    cachedBytes: 0,
    buffersBytes: 0,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
  };
  if (platform() !== "linux") return fallback;
  try {
    const source = await readFile("/proc/meminfo", { encoding: "utf8", signal });
    const values = new Map<string, number>();
    for (const line of source.split("\n")) {
      const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line.trim());
      if (match) values.set(match[1], Number(match[2]) * 1024);
    }
    const swapTotalBytes = values.get("SwapTotal") ?? 0;
    const swapFreeBytes = values.get("SwapFree") ?? 0;
    return {
      availableBytes: values.get("MemAvailable") ?? fallbackAvailable,
      cachedBytes: (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0),
      buffersBytes: values.get("Buffers") ?? 0,
      swapTotalBytes,
      swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
    };
  } catch {
    return fallback;
  }
}

async function readDisk() {
  try {
    const stats = await statfs(ROOT_MOUNT);
    const totalBytes = stats.blocks * stats.bsize;
    const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return {
      mount: ROOT_MOUNT,
      totalBytes,
      usedBytes,
      freeBytes,
      usagePercent: totalBytes === 0 ? 0 : clampPercentage((usedBytes / totalBytes) * 100),
    };
  } catch {
    return null;
  }
}

async function readNetworkTotals(signal: AbortSignal): Promise<NetworkTotals | null> {
  if (platform() !== "linux") return null;
  try {
    const source = await readFile("/proc/net/dev", { encoding: "utf8", signal });
    const candidates = source.split("\n").slice(2).map((line) => {
      const [rawName, rawStats] = line.split(":");
      if (!rawName || !rawStats) return null;
      const name = rawName.trim();
      const stats = rawStats.trim().split(/\s+/).map(Number);
      if (name === "lo" || stats.length < 9 || !Number.isFinite(stats[0]) || !Number.isFinite(stats[8]) || stats[0] < 0 || stats[8] < 0) return null;
      return { interface: name, rxBytes: stats[0] ?? 0, txBytes: stats[8] ?? 0 };
    }).filter((value): value is NetworkTotals => value !== null);
    return candidates.sort(
      (left, right) => right.rxBytes + right.txBytes - left.rxBytes - left.txBytes,
    )[0] ?? null;
  } catch {
    return null;
  }
}

export function parseProcesses(source: string): Processes {
  const rows = source.split("\n").flatMap((line) => {
    // comm comes last: executable names may contain whitespace. Never read cmdline.
    const match = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[6] === "ps") return [];
    const [pid, cpuPercent, memoryPercent, rssKiB] = match.slice(1, 5).map(Number);
    if (!Number.isSafeInteger(pid) || pid <= 0 || ![cpuPercent, memoryPercent, rssKiB * 1024].every(Number.isFinite)) return [];
    return [{ pid, name: match[6].slice(0, 128), cpuPercent, memoryPercent, rssBytes: rssKiB * 1024, running: match[5].startsWith("R") }];
  });
  return {
    available: true,
    total: rows.length,
    running: rows.filter((row) => row.running).length,
    top: rows.sort((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid).slice(0, 6).map(({ running: _running, ...row }) => row),
  };
}

async function readProcesses(signal: AbortSignal): Promise<Processes> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-eo", "pid=,%cpu=,%mem=,rss=,stat=,comm="],
      { timeout: 1500, maxBuffer: 512 * 1024, signal, env: { ...process.env, LC_ALL: "C" } },
    );
    const processes = parseProcesses(stdout);
    if (platform() === "linux") {
      // Node can rename comm to MainThread. Resolve six symlinks, not command-line
      // contents (which can be large or include credentials and arguments).
      await Promise.all(processes.top.map(async (entry) => {
        try { entry.name = basename((await readlink(`/proc/${entry.pid}/exe`)).replace(/ \(deleted\)$/, "")).slice(0, 128); }
        catch { /* The process may have exited, or ptrace permissions may deny access. */ }
      }));
    }
    return processes;
  } catch {
    return { available: false, total: 0, running: 0, top: [] };
  }
}

function assessHealth(
  cpuPercent: number | null,
  memoryPercent: number,
  diskPercent: number | null,
  fiveMinuteLoad: number,
  coreCount: number,
): ServerSnapshot["health"] {
  const issues: ServerSnapshot["health"]["issues"] = [];
  const addThresholdIssue = (label: string, value: number) => {
    if (value >= 95) issues.push({ severity: "critical", label, message: `${label} is at ${value.toFixed(1)}%.` });
    else if (value >= 85) issues.push({ severity: "warning", label, message: `${label} is at ${value.toFixed(1)}%.` });
  };
  if (cpuPercent !== null) addThresholdIssue("CPU", cpuPercent);
  addThresholdIssue("Memory", memoryPercent);
  if (diskPercent !== null) addThresholdIssue("Disk", diskPercent);
  const normalizedLoad = fiveMinuteLoad / coreCount;
  if (normalizedLoad >= 1.5) {
    issues.push({ severity: "critical", label: "System load", message: `Five-minute load is ${fiveMinuteLoad.toFixed(2)} across ${coreCount} cores.` });
  } else if (normalizedLoad >= 1) {
    issues.push({ severity: "warning", label: "System load", message: `Five-minute load is ${fiveMinuteLoad.toFixed(2)} across ${coreCount} cores.` });
  }
  return {
    status: issues.some((issue) => issue.severity === "critical") ? "critical" : issues.length > 0 ? "warning" : "healthy",
    issues,
  };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    refreshIntervalSeconds: {
      type: "number",
      label: "Refresh interval (seconds)",
      experimental_schema: z.number().int().min(2).max(60),
      default: 5,
    },
    backgroundMonitoring: { type: "boolean", label: "Background CPU and memory monitoring", default: false },
    pressureNotifications: { type: "boolean", label: "In-app overload and recovery alerts", default: true },
  });
  const initialSettings = await settings.get();
  let refreshIntervalMs = initialSettings.refreshIntervalSeconds * 1000;
  let monitorCpu: CpuTimes | null = null;
  const monitor = createPressureMonitor(bb, async (signal) => {
    let current: CpuTimes;
    let availableBytes: number;
    if (platform() === "linux") {
      const [stat, meminfo] = await Promise.all([
        readFile("/proc/stat", { encoding: "utf8", signal }),
        readFile("/proc/meminfo", { encoding: "utf8", signal }),
      ]);
      const times = stat.split("\n", 1)[0].trim().split(/\s+/).slice(1, 9).map(Number);
      if (times.length < 8 || !times.every(Number.isFinite)) throw new Error("CPU counters unavailable");
      current = { idle: times[3] + times[4], total: times.reduce((sum, value) => sum + value, 0) };
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
      if (!available) throw new Error("Available memory counter unavailable");
      availableBytes = Number(available[1]) * 1024;
    } else {
      current = readCpuTimes(cpus());
      availableBytes = freemem();
    }
    signal.throwIfAborted();
    const cpu = calculateCpuUsage(monitorCpu, current);
    monitorCpu = current;
    const totalBytes = totalmem();
    const runtime = process.memoryUsage();
    return { cpu, memory: totalBytes > 0 ? clampPercentage((1 - availableBytes / totalBytes) * 100) : null, load1: loadavg()[0] ?? 0, rssBytes: runtime.rss, heapUsedBytes: runtime.heapUsed, availableBytes, totalBytes };
  }, () => { monitorCpu = null; });
  monitor.configure(initialSettings.backgroundMonitoring, initialSettings.pressureNotifications);
  settings.onChange((next) => {
    refreshIntervalMs = next.refreshIntervalSeconds * 1000;
    sampler.intervalChanged();
    monitor.configure(next.backgroundMonitoring, next.pressureNotifications);
  });
  bb.background.service("pressure-monitor", { start: (signal) => monitor.start(signal) });

  let previousCpuTimes: CpuTimes | null = null;
  let previousPerCoreTimes: CpuTimes[] | null = null;
  let previousNetworkTotals: NetworkTotals | null = null;
  let previousNetworkTimestamp: number | null = null;
  const history: MetricPoint[] = [];

  async function collect(signal: AbortSignal): Promise<ServerSnapshot> {
    const cpuList = cpus();
    const cpuTimes = readCpuTimes(cpuList);
    const perCoreTimes = cpuList.map(cpuTimesFor);
    const sameCoreCount = previousPerCoreTimes?.length === perCoreTimes.length;
    const usagePercent = calculateCpuUsage(sameCoreCount ? previousCpuTimes : null, cpuTimes);
    const perCoreUsagePercent = perCoreTimes.map((current, index) =>
      calculateCpuUsage(sameCoreCount ? previousPerCoreTimes?.[index] ?? null : null, current),
    );
    previousCpuTimes = cpuTimes;
    previousPerCoreTimes = perCoreTimes;

    const [memoryDetails, disk, networkReading, processes] = await Promise.all([
      readMemoryDetails(signal), readDisk(), readNetworkTotals(signal).then((totals) => ({ totals, time: performance.now() })), readProcesses(signal),
    ]);
    signal.throwIfAborted();
    const totalBytes = totalmem();
    const freeBytes = freemem();
    const availableBytes = Math.min(totalBytes, Math.max(0, memoryDetails.availableBytes));
    const usedBytes = totalBytes - availableBytes;
    const memoryPercent = totalBytes === 0 ? 0 : clampPercentage((usedBytes / totalBytes) * 100);
    const loads = loadavg();
    const coreCount = Math.max(1, cpuList.length);
    const memoryUsage = process.memoryUsage();
    const timestamp = Date.now();
    const { totals: networkTotals, time: networkTimestamp } = networkReading;
    const elapsedSeconds = previousNetworkTimestamp === null ? null : (networkTimestamp - previousNetworkTimestamp) / 1000;
    const network = networkTotals === null ? null : {
      interface: networkTotals.interface,
      ...calculateNetworkRates(previousNetworkTotals, networkTotals, elapsedSeconds),
      rxTotalBytes: networkTotals.rxBytes,
      txTotalBytes: networkTotals.txBytes,
    };
    previousNetworkTotals = networkTotals;
    previousNetworkTimestamp = networkTimestamp;

    history.push({
      timestamp,
      cpuPercent: usagePercent,
      memoryPercent,
      networkRxBytesPerSecond: network?.rxBytesPerSecond ?? null,
      networkTxBytesPerSecond: network?.txBytesPerSecond ?? null,
    });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);

    const snapshot: ServerSnapshot = {
      timestamp: new Date(timestamp).toISOString(),
      refreshIntervalMs,
      host: { hostname: hostname(), platform: platform(), release: release(), arch: arch(), uptimeSeconds: uptime() },
      cpu: {
        model: cpuList[0]?.model.trim() || "Unknown CPU",
        cores: coreCount,
        speedMHz: cpuList.length === 0 ? 0 : cpuList.reduce((sum, cpu) => sum + cpu.speed, 0) / cpuList.length,
        usagePercent,
        perCoreUsagePercent,
        loadAverage: [loads[0] ?? 0, loads[1] ?? 0, loads[2] ?? 0],
      },
      memory: {
        totalBytes,
        usedBytes,
        freeBytes,
        availableBytes,
        cachedBytes: memoryDetails.cachedBytes,
        buffersBytes: memoryDetails.buffersBytes,
        swapTotalBytes: memoryDetails.swapTotalBytes,
        swapUsedBytes: memoryDetails.swapUsedBytes,
        usagePercent: memoryPercent,
      },
      disk,
      network,
      processes,
      runtime: {
        pid: process.pid,
        nodeVersion: process.version,
        processUptimeSeconds: process.uptime(),
        rssBytes: memoryUsage.rss,
        heapUsedBytes: memoryUsage.heapUsed,
        heapTotalBytes: memoryUsage.heapTotal,
        externalBytes: memoryUsage.external,
      },
      health: assessHealth(usagePercent, memoryPercent, disk?.usagePercent ?? null, loads[1] ?? 0, coreCount),
      history: [...history],
    };
    return snapshot;
  }

  const sampler = createDemandSampler({
    collect,
    intervalMs: () => refreshIntervalMs,
    reset() {
      previousCpuTimes = null;
      previousPerCoreTimes = null;
      previousNetworkTotals = null;
      previousNetworkTimestamp = null;
      history.length = 0;
    },
  });
  const sample = async () => {
    const snapshot = await sampler.sample();
    // Settings may change while a snapshot is cached; clients need the new cadence now.
    return snapshot.refreshIntervalMs === refreshIntervalMs ? snapshot : { ...snapshot, refreshIntervalMs };
  };

  bb.rpc.register(rpcContract, {
    metrics_snapshot: () => sample(),
    metrics_refresh: () => sampler.sample(true),
    monitor_status: () => monitor.status(),
  });

  const usage = ["Usage:", "  bb beacon snapshot [--json]", "  bb beacon health [--json]", "  bb beacon logs [--json] [--limit 1..500]", "  bb beacon test-alert"].join("\n");
  bb.cli.register({
    name: "beacon",
    summary: "Inspect BB server resource usage and health",
    commands: [
      { name: "snapshot", summary: "Show current server statistics", usage: "bb beacon snapshot [--json]" },
      { name: "health", summary: "Show the current pressure assessment", usage: "bb beacon health [--json]" },
      { name: "logs", summary: "Read bounded monitoring history; --json exports JSONL", usage: "bb beacon logs [--json] [--limit 1..500]" },
      { name: "test-alert", summary: "Send a labeled in-app alert preview to visible BB clients", usage: "bb beacon test-alert" },
    ],
    async run(argv) {
      if (argv[0] === "test-alert") {
        if (argv.length !== 1) return { exitCode: 1, stderr: usage };
        const current = await settings.get();
        if (!current.backgroundMonitoring || !current.pressureNotifications) return { exitCode: 1, stderr: "Enable backgroundMonitoring and pressureNotifications before testing in-app alerts." };
        // Ephemeral preview only: no incident state, cursor, log, or metric changes.
        bb.realtime.publish(PRESSURE_CHANNEL, { type: "test" });
        return { exitCode: 0, stdout: "Test alert broadcast to connected BB clients. Keep BB visible to see it; this is not an OS push notification." };
      }
      if (argv[0] === "logs") {
        let limit = 100;
        let json = false;
        for (let i = 1; i < argv.length; i++) {
          if (argv[i] === "--json" && !json) json = true;
          else if (argv[i] === "--limit" && /^\d+$/.test(argv[i + 1] ?? "")) {
            limit = Number(argv[++i]);
            if (limit < 1 || limit > 500) return { exitCode: 1, stderr: usage };
          } else return { exitCode: 1, stderr: usage };
        }
        const entries = monitor.logs(limit);
        return { exitCode: 0, stdout: json ? entries.map((entry) => JSON.stringify(entry)).join("\n") : entries.length ? entries.map((entry) => `${new Date(entry.timestamp).toISOString()} ${entry.type} ${JSON.stringify(entry)}`).join("\n") : "No monitoring logs yet. Enable backgroundMonitoring to collect diagnostics." };
      }
      const json = argv.includes("--json");
      const command = argv.find((argument) => argument !== "--json");
      if (argv.filter((argument) => argument !== "--json").length > 1) return { exitCode: 1, stderr: usage };
      if (command === undefined || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      if (command !== "snapshot" && command !== "health") return { exitCode: 1, stderr: usage };
      const snapshot = await sample();
      if (command === "snapshot") {
        if (json) return { exitCode: 0, stdout: JSON.stringify(snapshot) };
        return {
          exitCode: 0,
          stdout: [
            `CPU: ${snapshot.cpu.usagePercent === null ? "sampling" : `${snapshot.cpu.usagePercent.toFixed(1)}%`} (${snapshot.cpu.cores} cores)`,
            `Load: ${snapshot.cpu.loadAverage.map((value) => value.toFixed(2)).join(" / ")}`,
            `Memory: ${snapshot.memory.usagePercent.toFixed(1)}% used`,
            `Disk: ${snapshot.disk ? `${snapshot.disk.usagePercent.toFixed(1)}% used` : "unavailable"}`,
            snapshot.processes.available ? `Processes: ${snapshot.processes.total} total, ${snapshot.processes.running} running` : "Processes: unavailable",
            `Updated: ${snapshot.timestamp}`,
          ].join("\n"),
        };
      }
      if (command === "health") {
        if (json) return { exitCode: 0, stdout: JSON.stringify(snapshot.health) };
        return {
          exitCode: snapshot.health.status === "critical" ? 2 : 0,
          stdout: snapshot.health.issues.length === 0 ? "healthy — no resource pressure detected" : `${snapshot.health.status}\n${snapshot.health.issues.map((issue) => `- ${issue.message}`).join("\n")}`,
        };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.log.info("Beacon loaded");
  bb.onDispose(() => { monitor.dispose(); sampler.dispose(); bb.log.info("Beacon disposed"); });
}
