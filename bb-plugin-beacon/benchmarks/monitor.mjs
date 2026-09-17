// Production plugin + real /proc reads and SDK-owned SQLite. Only time is accelerated.
// Run with: node --expose-gc benchmarks/monitor.mjs [samples=10000]
import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const count = Number(process.argv[2] ?? 10000);
assert.ok(Number.isInteger(count) && count >= 100 && count <= 50000);
const ns = () => process.hrtime.bigint();
const ms = (start) => Number(ns() - start) / 1e6;
// Use the checkout filesystem, not /tmp (which may be RAM-backed).
const directory = await mkdtemp(join(import.meta.dirname, ".monitor-"));
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = directory;
const { bb, harness } = createFakePluginHost({ pluginId: "beacon", settings: { backgroundMonitoring: true, pressureNotifications: false } });
if (previousTmpdir === undefined) delete process.env.TMPDIR;
else process.env.TMPDIR = previousTmpdir;
const db = bb.storage.database();
// The SDK harness defaults to DELETE; the live SDK contract specifies WAL.
db.pragma("journal_mode = WAL");
const originalNow = performance.now;
const originalTransaction = db.transaction.bind(db);
let completed, commitMs = 0, commits = 0;
db.transaction = (fn) => {
  const transaction = originalTransaction(fn);
  const originalImmediate = transaction.immediate;
  const measured = (...args) => {
    const start = ns();
    const result = originalImmediate(...args);
    commitMs = ms(start);
    commits++;
    completed?.();
    return result;
  };
  return Object.assign((...args) => transaction(...args), { immediate: measured, deferred: transaction.deferred, exclusive: transaction.exclusive });
};
const io = async () => {
  const text = await readFile("/proc/self/io", "utf8");
  return Object.fromEntries(text.trim().split("\n").map((line) => { const [key, value] = line.split(":"); return [key, Number(value.trim())]; }));
};
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n) => Math.round(n * 1000) / 1000;
  return { mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length), median: round(sorted[Math.floor(sorted.length / 2)]), p95: round(sorted[Math.floor(sorted.length * .95)]), max: round(sorted.at(-1)) };
};
let service;
try {
  await plugin(bb);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const origin = ns();
  // Avoid mock.method: its call-history retention would contaminate heap measurements.
  performance.now = () => Date.now() + ms(origin);
  const times = new Float64Array(count);
  const writes = new Float64Array(count);
  const retainedHeap = [];
  async function cycle(first = false) {
    let finish;
    const committed = new Promise((resolve) => { finish = resolve; });
    completed = finish;
    const start = ns();
    if (first) service = harness.behavior.runService("pressure-monitor");
    else mock.timers.tick(30_000);
    await committed;
    // Let the continuation publish state and arm the next timer before advancing.
    await immediate();
    return ms(start);
  }
  for (let i = 0; i < 200; i++) await cycle(i === 0);
  global.gc?.();
  const startHeap = process.memoryUsage().heapUsed;
  const startCpu = process.cpuUsage();
  const startIo = await io();
  const startChanges = db.prepare("SELECT total_changes() AS n").get().n;
  const started = ns();
  for (let i = 0; i < count; i++) {
    times[i] = await cycle();
    writes[i] = commitMs;
    if ((i + 1) % 2000 === 0) { global.gc?.(); retainedHeap.push({ samples: i + 1, heapBytes: process.memoryUsage().heapUsed }); }
  }
  const elapsedMs = ms(started);
  const cpu = process.cpuUsage(startCpu);
  const endIo = await io();
  global.gc?.();
  const endHeap = process.memoryUsage().heapUsed;
  const file = db.prepare("PRAGMA database_list").all().find((r) => r.name === "main").file;
  const size = async (path) => (await stat(path).catch(() => ({ size: 0 }))).size;
  const beforeStop = commits;
  service.controller.abort(); await service.done;
  mock.timers.tick(600_000); await immediate();
  assert.equal(commits, beforeStop, "stopping service must cancel future samples");
  const rows = db.prepare("SELECT COUNT(*) AS n FROM pressure_logs").get().n;
  assert.ok(rows <= 4096);
  console.log(JSON.stringify({ samples: count, simulatedHours: count / 120, elapsedMs, sampleMs: distribution(times), commitMs: distribution(writes), cpuMs: (cpu.user + cpu.system) / 1000, cpuMsPerSample: (cpu.user + cpu.system) / 1000 / count, retainedHeap: { start: startHeap, end: endHeap, delta: endHeap - startHeap, checkpoints: retainedHeap }, storage: { journalMode: db.pragma("journal_mode", { simple: true }), synchronous: db.pragma("synchronous", { simple: true }), logRows: rows, stateRows: db.prepare("SELECT COUNT(*) AS n FROM pressure_state").get().n, noticeRows: db.prepare("SELECT COUNT(*) AS n FROM pressure_notices").get().n, rowChanges: db.prepare("SELECT total_changes() AS n").get().n - startChanges, mainBytes: await size(file), walBytes: await size(file + "-wal"), processWriteBytes: endIo.write_bytes - startIo.write_bytes }, writesAfterStop: commits - beforeStop, errors: harness.logEntries.filter((e) => e.level === "warn" || e.level === "error").length }, null, 2));
} finally {
  service?.controller.abort();
  await service?.done;
  await harness.lifecycle.dispose();
  performance.now = originalNow;
  mock.restoreAll(); mock.timers.reset();
  await rm(directory, { recursive: true, force: true });
}
