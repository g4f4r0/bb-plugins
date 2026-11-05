import { readFile } from "node:fs/promises";
import { cpus, platform } from "node:os";

export interface CpuTimes { idle: number; total: number }
export interface CpuReading { overall: CpuTimes; cores: CpuTimes[] }

// One CPU definition for the dashboard and the background monitor, so both
// report the same number. On Linux: user, nice, system, idle, iowait, irq,
// softirq and steal from /proc/stat; iowait counts as idle and steal as busy.
const PROC_STAT_FIELDS = 8;

function procStatTimes(fields: string[]): CpuTimes | null {
  const times = fields.slice(1, 1 + PROC_STAT_FIELDS).map(Number);
  if (times.length < PROC_STAT_FIELDS || !times.every((value) => Number.isFinite(value) && value >= 0)) return null;
  return { idle: times[3] + times[4], total: times.reduce((sum, value) => sum + value, 0) };
}

/** Parse the aggregate `cpu` line and every `cpuN` line of /proc/stat. */
export function parseProcStat(source: string): CpuReading {
  let overall: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of source.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const fields = line.trim().split(/\s+/);
    const times = procStatTimes(fields);
    if (!times) throw new Error("CPU counters unavailable");
    if (fields[0] === "cpu") overall = times;
    else cores.push(times);
  }
  if (!overall) throw new Error("CPU counters unavailable");
  return { overall, cores };
}

function fromNode(): CpuReading {
  const cores = cpus().map((cpu) => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }));
  return { overall: cores.reduce((sum, core) => ({ idle: sum.idle + core.idle, total: sum.total + core.total }), { idle: 0, total: 0 }), cores };
}

/** Cumulative CPU times. Throws on Linux when /proc/stat is unreadable or malformed. */
export async function readCpu(signal: AbortSignal): Promise<CpuReading> {
  if (platform() !== "linux") return fromNode();
  return parseProcStat(await readFile("/proc/stat", { encoding: "utf8", signal }));
}

export function calculateCpuUsage(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (previous === null) return null;
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  return Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100));
}
