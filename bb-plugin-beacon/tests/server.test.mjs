import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { calculateCpuUsage, calculateNetworkRates, parseProcesses } from "../server.ts";

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
  assert.equal(snapshot.memory.usedBytes + snapshot.memory.availableBytes, snapshot.memory.totalBytes);
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
