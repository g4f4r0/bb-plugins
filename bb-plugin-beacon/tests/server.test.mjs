import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { calculateCpuUsage, calculateNetworkRates, parseNetstatInterfaces, parseProcesses, parseSwapUsage, parseVmStatMemory } from "../server.ts";

test("CPU deltas handle warmup, idle, full utilization, and counter resets", () => {
  assert.equal(calculateCpuUsage(null, { idle: 0, total: 100 }), null);
  assert.equal(calculateCpuUsage({ idle: 50, total: 100 }, { idle: 100, total: 200 }), 50);
  assert.equal(calculateCpuUsage({ idle: 0, total: 100 }, { idle: 0, total: 200 }), 100);
  assert.equal(calculateCpuUsage({ idle: 0, total: 100 }, { idle: 100, total: 200 }), 0);
  for (const next of [{ idle: 20, total: 90 }, { idle: 20, total: 200 }, { idle: 500, total: 200 }, { idle: 50, total: 100 }]) {
    assert.equal(calculateCpuUsage({ idle: 50, total: 100 }, next), null);
  }
});
test("process parsing preserves spaced names and multi-core CPU and rejects malformed lines", () => {
  const result = parseProcesses(" 42 250.5 1.2 2048 Rl app with spaces\n 43 3.2 5.1 100 S node\n 44 1.0 0.0 100 R ps\n 0 1.0 0.0 20 S bad\ninvalid\n 45 ... 1 30 S bad");
  assert.equal(result.total, 2); assert.equal(result.running, 1); assert.equal(result.available, true);
  assert.deepEqual(result.top[0], { pid: 42, name: "app with spaces", cpuPercent: 250.5, memoryPercent: 1.2, rssBytes: 2097152 });
});
test("process results and names are bounded and ties have deterministic order", () => {
  const result = parseProcesses(Array.from({ length: 200 }, (_, i) => `${200 - i} 5.0 1.0 100 S ${"n".repeat(200)}`).join("\n"));
  assert.equal(result.total, 200); assert.equal(result.top.length, 6);
  assert.equal(result.top[0].pid, 1); assert.ok(result.top.every((p) => p.name.length === 128));
});

test("vm_stat parsing counts cache as available, not as used memory", () => {
  const source = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                    29748.",
    "Pages active:                                 721115.",
    "Pages inactive:                               675403.",
    "Pages speculative:                             54077.",
    "Pages throttled:                                   0.",
    "Pages wired down:                             186701.",
    "Pages purgeable:                               16171.",
    '"Translation faults":                      470950592.',
    "Pages stored in compressor:                   776024.",
    "Pages occupied by compressor:                 377951.",
    "File-backed pages:                            749755.",
    "Anonymous pages:                              700840.",
  ].join("\n");
  const parsed = parseVmStatMemory(source);
  assert.equal(parsed?.availableBytes, 12704137216); // free + inactive + speculative + purgeable
  assert.equal(parsed?.cachedBytes, 12283985920);
  // Counting free pages only (os.freemem) made this machine read 96% used.
  const totalBytes = 34359738368;
  assert.equal(((totalBytes - (parsed?.availableBytes ?? 0)) / totalBytes * 100).toFixed(1), "63.0");
  assert.equal(parseVmStatMemory("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active: 10."), null);
  assert.equal(parseVmStatMemory("no page size here\nPages free: 10."), null);
  assert.equal(parseVmStatMemory(""), null);
  // Truncated output: bytes would count the cache as used memory if this parsed.
  assert.equal(parseVmStatMemory("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 29748.\nPages active: 721115."), null);
  // Truncated after the last counter that availability depends on.
  assert.equal(parseVmStatMemory("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\nPages wired down: 4."), null);
  // File-backed pages is informational, so its absence is not a truncation signal.
  assert.deepEqual(parseVmStatMemory("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\nPages purgeable: 4."), { availableBytes: 40960, cachedBytes: 0 });
});

test("swapusage parsing reads units and never exceeds the total", () => {
  assert.deepEqual(parseSwapUsage("total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)"), { swapTotalBytes: 2147483648, swapUsedBytes: 536870912 });
  assert.deepEqual(parseSwapUsage("total = 1024.00M  used = 4096.00M  free = 0.00M"), { swapTotalBytes: 1073741824, swapUsedBytes: 1073741824 });
  assert.deepEqual(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)"), { swapTotalBytes: 0, swapUsedBytes: 0 });
  assert.deepEqual(parseSwapUsage(""), { swapTotalBytes: 0, swapUsedBytes: 0 });
});

test("netstat parsing skips loopback/inactive rows and ranks by traffic", () => {
  const source = [
    "Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll",
    "lo0 16384 <Link#1> 2085336 0 1314274984 2085336 0 1314274984 0",
    "gif0* 1280 <Link#2> 0 0 0 0 0 0 0",
    "en0 1500 <Link#15> 02:00:00:00:00:00 11963783 0 10437412649 15981632 0 20307530479 0",
    "en0 1500 192.168.1 192.168.1.5 11963783 - 10437412649 15981632 - 20307530479 -",
    "utun4 1500 <Link#20> 100 0 500 200 0 600 0",
    "bad* 1500 <Link#21> x y z",
  ].join("\n");
  assert.deepEqual(parseNetstatInterfaces(source), [
    { interface: "en0", rxBytes: 10437412649, txBytes: 20307530479 },
    { interface: "utun4", rxBytes: 500, txBytes: 600 },
  ]);
  assert.deepEqual(parseNetstatInterfaces("nothing here\n"), []);
});

test("network rates use actual elapsed time and reject warmup, resets and interface changes", () => {
  const previous = { interface: "eth0", rxBytes: 100, txBytes: 200 };
  const current = { interface: "eth0", rxBytes: 110, txBytes: 230 };
  assert.deepEqual(calculateNetworkRates(previous, current, 5), { rxBytesPerSecond: 2, txBytesPerSecond: 6 });
  assert.deepEqual(calculateNetworkRates(previous, previous, 5), { rxBytesPerSecond: 0, txBytesPerSecond: 0 });
  for (const [prior, next, elapsed] of [[null, current, 5], [previous, current, null], [previous, current, 0], [previous, current, -5], [previous, current, NaN], [previous, { ...current, rxBytes: 1 }, 5], [previous, { ...current, txBytes: 1 }, 5], [previous, { ...current, interface: "eth1" }, 5]]) {
    assert.deepEqual(calculateNetworkRates(prior, next, elapsed), { rxBytesPerSecond: null, txBytesPerSecond: null });
  }
});

test("bounded history expires on idle, not just reload, and no cold-start deltas bridge the gap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_789_000_000_000 });
  t.mock.method(performance, "now", () => Date.now());
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  let snapshot;
  for (let i = 0; i < 80; i++) {
    snapshot = await harness.behavior.callRpc("metrics_snapshot", null);
    assert.equal(snapshot.history.length, Math.min(i + 1, 72));
    if (i < 79) t.mock.timers.tick(5000);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 128 * 1024);
  t.mock.timers.tick(15_000);
  const resumed = await harness.behavior.callRpc("metrics_snapshot", null);
  assert.equal(resumed.history.length, 1); assert.equal(resumed.cpu.usagePercent, null);
  assert.equal(resumed.network?.rxBytesPerSecond ?? null, null);
  assert.ok(resumed.cpu.perCoreUsagePercent.every((v) => v === null));
});

// Only macOS reaches this path by blanking PATH; Linux reads /proc/meminfo directly.
test("unreadable memory counters keep memory unknown and drop the memory health claim", { skip: process.platform === "darwin" ? false : "exercises the macOS command readers" }, async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent-beacon-test"; // vm_stat, sysctl, ps and netstat all fail
  try {
    const snapshot = await harness.behavior.callRpc("metrics_snapshot", null);
    // No free-page substitute: that reading counts the file cache as used memory.
    assert.equal(snapshot.memory.usedBytes, null);
    assert.equal(snapshot.memory.availableBytes, null);
    assert.equal(snapshot.memory.usagePercent, null);
    assert.equal(snapshot.memory.cachedBytes, 0);
    assert.equal(snapshot.history[0].memoryPercent, null);
    assert.equal(snapshot.memory.totalBytes, (await import("node:os")).totalmem());
    // Memory only: disk and load issues belong to the host, not to this path.
    assert.deepEqual(snapshot.health.issues.filter((issue) => issue.label === "Memory"), []);
    const cli = await harness.behavior.runCli(["snapshot"]);
    assert.match(cli.stdout, /Memory: unavailable/);
  } finally {
    process.env.PATH = path;
  }
});

test("settings changes reach clients even while the previous snapshot is cached", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const initial = await harness.behavior.callRpc("metrics_snapshot", null);
  await harness.behavior.setSettings({ refreshIntervalSeconds: 60 });
  const changed = await harness.behavior.callRpc("metrics_snapshot", null);
  assert.equal(changed.timestamp, initial.timestamp); assert.equal(changed.refreshIntervalMs, 60_000);
});

test("manual refresh bypasses the shared snapshot cache", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const initial = await harness.behavior.callRpc("metrics_snapshot", null);
  const refreshed = await harness.behavior.callRpc("metrics_refresh", null);
  assert.equal(initial.history.length, 1); assert.equal(refreshed.history.length, 2);
});

test("reload clears old history and does not introduce duplicate services or signals", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  await harness.behavior.callRpc("metrics_snapshot", null);
  const replacement = await harness.lifecycle.reload(plugin);
  t.after(() => replacement.harness.lifecycle.dispose());
  await assert.rejects(harness.behavior.callRpc("metrics_snapshot", null), /disposed|stale/i);
  const next = await replacement.harness.behavior.callRpc("metrics_snapshot", null);
  assert.equal(next.history.length, 1); assert.equal(next.cpu.usagePercent, null);
  assert.equal(replacement.harness.registrations.services.length, 1); assert.equal(replacement.harness.realtimeSignals.length, 0);
});
test("real backend leaves monitoring off by default and concurrent RPC/CLI readers share a bounded snapshot", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  assert.equal(harness.registrations.services.length, 1);
  assert.equal((await harness.behavior.callRpc("monitor_status", null)).enabled, false);
  assert.equal(harness.registrations.schedules.length, 0);
  const results = await Promise.all(Array.from({ length: 20 }, () => harness.behavior.callRpc("metrics_snapshot", null)));
  // callRpc validates and JSON-round-trips the result, then unwraps the envelope.
  const snapshot = results[0];
  assert.ok(results.every((r) => r.timestamp === snapshot.timestamp));
  assert.equal(snapshot.history.length, 1); assert.equal(snapshot.cpu.usagePercent, null);
  assert.equal(snapshot.refreshIntervalMs, 5000); assert.ok(snapshot.processes.top.length <= 6);
  if (snapshot.memory.availableBytes === null) {
    // Counters can be unreadable on a supported host; unavailable is a valid result.
    assert.equal(snapshot.memory.usedBytes, null);
    assert.equal(snapshot.memory.usagePercent, null);
  } else {
    assert.equal(snapshot.memory.usedBytes + snapshot.memory.availableBytes, snapshot.memory.totalBytes);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 128 * 1024);
  const cli = await harness.behavior.runCli(["snapshot", "--json"]);
  assert.equal(cli.exitCode, 0); assert.equal(JSON.parse(cli.stdout).timestamp, snapshot.timestamp);
  assert.equal(harness.realtimeSignals.length, 0);
});
test("invalid CLI input does not sample, and settings retain enforced bounds", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  assert.equal((await harness.behavior.runCli(["nope"])).exitCode, 1);
  assert.equal((await harness.behavior.runCli(["snapshot", "junk"])).exitCode, 1);
  assert.equal((await harness.behavior.runCli(["--help"])).exitCode, 0);
  await assert.rejects(harness.behavior.setSettings({ refreshIntervalSeconds: 1 }));
  await assert.rejects(harness.behavior.setSettings({ refreshIntervalSeconds: 61 }));
  await harness.behavior.setSettings({ refreshIntervalSeconds: 2 });
  const response = await harness.behavior.callRpc("metrics_snapshot", null);
  assert.equal(response.refreshIntervalMs, 2000); assert.equal(response.history.length, 1);
});
