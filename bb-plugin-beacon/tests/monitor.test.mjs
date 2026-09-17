import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import { freshPressureState, stepPressure, isPressureState } from "../lib/pressure.ts";
import { createMonitorStore, LOG_LIMIT } from "../lib/monitor-store.ts";
import { createPressureMonitor } from "../lib/pressure-monitor.ts";
import { createAlertReceiver, isAlertNotice } from "../lib/alert-receiver.ts";
import plugin from "../server.ts";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const base = { cpu: 10, memory: 40, load1: 0.2, rssBytes: 1000, heapUsedBytes: 500, availableBytes: 6000, totalBytes: 10_000 };
function engine() { let state = freshPressureState(); return { read: () => state, step(now, cpu = 99, memory = 93) { const next = stepPressure(state, { cpu, memory }, now); state = next.state; return next.events; } }; }
function notice(sequence, type = "incident", metric = "cpu") { return { sequence, type, metric, timestamp: 100_000, value: 99, peak: 100, durationSeconds: 60, threshold: 95 }; }

test("brief peaks don't alert; both metrics need a full continuous minute", () => {
  const e = engine(); assert.deepEqual(e.step(0), []); assert.deepEqual(e.step(30_000), []);
  assert.deepEqual(e.step(59_999), []); const events = e.step(60_000);
  assert.equal(events.length, 2); assert.equal(events[0].type, "incident"); assert.equal(events[0].durationSeconds, 60);
  assert.deepEqual(e.step(90_000), []); assert.deepEqual(e.step(120_000), []);
});
test("a below-threshold or missing sample breaks the candidate streak", () => {
  const e = engine(); e.step(0); e.step(30_000, null, 20); assert.deepEqual(e.step(60_000), []);
  assert.deepEqual(e.step(90_000), []); assert.equal(e.step(120_000).length, 2);
});
test("long sample gaps and backwards clocks cannot prove sustained overload", () => {
  const e = engine(); e.step(100_000); assert.deepEqual(e.step(300_000), []);
  assert.deepEqual(e.step(290_000), []); assert.deepEqual(e.step(320_000), []); assert.equal(e.step(350_000).length, 2);
});
test("recovery requires a minute below the lower threshold and preserves incident peaks", () => {
  const e = engine(); e.step(0); e.step(30_000); e.step(60_000); e.step(90_000, 100, 98);
  assert.deepEqual(e.step(120_000, 80, 80), []); e.step(150_000, 86, 86);
  e.step(180_000, 80, 80); e.step(210_000, 80, 80); const events = e.step(240_000, 80, 80);
  assert.equal(events.length, 2); assert.equal(events[0].type, "recovery"); assert.equal(events[0].peak, 100); assert.equal(events[1].peak, 98);
  for (let time = 270_000; time < 540_000; time += 30_000) assert.deepEqual(e.step(time), []);
  assert.equal(e.step(540_000).length, 2);
});
test("invalid counters don't create incidents or false recoveries", () => {
  const e = engine(); for (const v of [null, NaN, Infinity, -1, 101]) assert.deepEqual(e.step(0, v, v), []);
  e.step(100_000); e.step(130_000); e.step(160_000); e.step(190_000, 0, 0); e.step(220_000, null, null);
  assert.deepEqual(e.step(250_000, 0, 0), []); assert.equal(isPressureState(e.read()), true);
  assert.equal(isPressureState({ cpu: { active: true } }), false);
});

test("log storage is a fixed ring with bounded payloads and monotonically increasing IDs", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" }); t.after(() => harness.lifecycle.dispose());
  const store = createMonitorStore(bb);
  for (let i = 0; i < LOG_LIMIT + 100; i++) store.write([{ type: "summary", timestamp: i, cpuPercent: 25, padding: "x".repeat(940) }]);
  const count = bb.storage.database().prepare("SELECT COUNT(*) AS n FROM pressure_logs").get().n;
  assert.equal(count, LOG_LIMIT); assert.equal(store.cursor(), LOG_LIMIT + 100); assert.equal(store.read(9999).length, 500);
  assert.equal(store.read(1)[0].sequence, LOG_LIMIT + 100);
  const before = store.cursor(); assert.throws(() => store.write([{ type: "error", timestamp: 1, message: "x".repeat(1100) }]));
  assert.equal(store.cursor(), before); assert.equal(store.read(1)[0].sequence, before);
  const pages = bb.storage.database().pragma("page_count", { simple: true });
  const pageSize = bb.storage.database().pragma("page_size", { simple: true }); assert.ok(pages * pageSize < 10 * 1024 * 1024);
});
test("multi-record writes roll back atomically and state survives a store reopen", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" }); t.after(() => harness.lifecycle.dispose());
  const store = createMonitorStore(bb); const e = engine(); e.step(0); e.step(30_000); const events = e.step(60_000);
  store.write(events, e.read()); const previous = store.cursor();
  assert.throws(() => store.write([{ type: "summary", timestamp: 2 }, { type: "error", timestamp: 2, message: "x".repeat(1100) }], freshPressureState()));
  assert.equal(store.cursor(), previous); assert.equal(createMonitorStore(bb).state().cpu.active, true);
  assert.equal(store.alerts().length, 2);
});

test("overlapping stores allocate fresh sequences without overwriting each other's logs", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" }); t.after(() => harness.lifecycle.dispose());
  const first = createMonitorStore(bb), second = createMonitorStore(bb);
  first.write([{ type: "summary", timestamp: 1 }]);
  assert.equal(second.cursor(), 1);
  second.write([{ ...notice(0) }]);
  first.write([{ type: "summary", timestamp: 3 }]);
  assert.deepEqual(second.read().map((entry) => entry.sequence), [1, 2, 3]);
  assert.equal(first.cursor(), 3);
  assert.equal(second.currentNotices()[0].sequence, 2);
});

async function setupMonitor(t, read = async () => base) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  t.mock.method(performance, "now", () => Date.now());
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" });
  let calls = 0, resets = 0;
  const monitor = createPressureMonitor(bb, async (signal) => { calls++; return read(signal); }, () => { resets++; });
  const controller = new AbortController(); const running = monitor.start(controller.signal);
  t.after(async () => { controller.abort(); monitor.dispose(); await running; await harness.lifecycle.dispose(); });
  const tick = async (ms = 30_000) => { t.mock.timers.tick(ms); await flush(); };
  return { bb, harness, monitor, controller, running, tick, calls: () => calls, resets: () => resets };
}
test("disabled monitor has no periodic work; enabling starts light reads and minute summaries", async (t) => {
  const s = await setupMonitor(t); await s.tick(3_600_000); assert.equal(s.calls(), 0);
  s.monitor.configure(true, true); await flush(); assert.equal(s.calls(), 1); assert.equal(s.monitor.logs(100).length, 1);
  await s.tick(); assert.equal(s.calls(), 2); assert.equal(s.monitor.logs(100).length, 1);
  await s.tick(); assert.equal(s.monitor.logs(100).length, 2); assert.equal(s.harness.realtimeSignals.length, 0);
  s.monitor.configure(false, true); const count = s.calls(); await s.tick(3_600_000); assert.equal(s.calls(), count);
});
test("sustained incidents publish only transitions and resume without repeating alerts", async (t) => {
  let sample = { ...base, cpu: 99, memory: 94 };
  const s = await setupMonitor(t, async () => sample); s.monitor.configure(true, true); await flush(); await s.tick(); await s.tick();
  assert.equal(s.harness.realtimeSignals.length, 2); assert.equal(s.monitor.status().active.length, 2);
  await s.tick(); assert.equal(s.harness.realtimeSignals.length, 2);
  sample = { ...base }; await s.tick(); await s.tick(); await s.tick();
  assert.equal(s.harness.realtimeSignals.length, 4); assert.equal(s.monitor.status().active.length, 0);
  assert.equal(s.monitor.logs(100).filter((entry) => entry.type === "recovery").length, 2);
});
test("notification opt-out keeps diagnostics without publishing messages", async (t) => {
  const s = await setupMonitor(t, async () => ({ ...base, cpu: 99, memory: 94 }));
  s.monitor.configure(true, false); await flush(); await s.tick(); await s.tick();
  assert.equal(s.harness.realtimeSignals.length, 0); assert.equal(s.monitor.logs(100).filter((e) => e.type === "incident").length, 2);
});
test("sampling failures are rate limited and abort on disable cannot emit a stale incident", async (t) => {
  let fail = true;
  const s = await setupMonitor(t, async () => { if (fail) throw new Error("read failed"); return base; });
  s.monitor.configure(true, true); await flush(); for (let i = 0; i < 9; i++) await s.tick();
  assert.equal(s.monitor.logs(100).filter((e) => e.type === "error").length, 1); assert.equal(s.harness.logEntries.length, 1);
  fail = false; await s.tick(); assert.ok(s.monitor.logs(100).some((e) => e.type === "summary"));
});
test("slow monitor reads never overlap and late results are discarded after disable", async (t) => {
  const pending = deferred(); let readSignal;
  const s = await setupMonitor(t, (signal) => { readSignal = signal; return pending.promise; });
  s.monitor.configure(true, true); await flush(); await s.tick(120_000); assert.equal(s.calls(), 1);
  s.monitor.configure(false, true); assert.equal(readSignal.aborted, true); pending.resolve({ ...base, cpu: 100, memory: 100 }); await flush();
  assert.equal(s.harness.realtimeSignals.length, 0);
  assert.deepEqual(s.monitor.logs(100).map((entry) => entry.type), ["monitor_disabled"]);
});
test("dispose wakes a disabled service and leaves no running loop", async (t) => {
  const s = await setupMonitor(t); s.monitor.dispose(); await s.running; assert.equal(s.calls(), 0);
});

test("failed samples persist broken streaks so reload cannot bridge the missing interval", async (t) => {
  let failed = false;
  const s = await setupMonitor(t, async () => { if (failed) throw new Error("read failed"); return { ...base, memory: 99 }; });
  s.monitor.configure(true, true); await flush(); await s.tick();
  failed = true; await s.tick();
  const restored = createMonitorStore(s.bb).state();
  assert.equal(restored.memory.since, null);
  assert.deepEqual(stepPressure(restored, { cpu: null, memory: 99 }, Date.now() + 1).events, []);
  failed = false; await s.tick(); failed = true; await s.tick();
  assert.equal(createMonitorStore(s.bb).state().memory.since, null);
  assert.equal(s.monitor.logs(100).filter((e) => e.type === "error").length, 1);
});

test("repeated read failures cannot keep old incidents fresh, including after a store reopen", async (t) => {
  let failed = false;
  const s = await setupMonitor(t, async () => {
    if (failed) throw new Error("read failed");
    return { ...base, cpu: 99, memory: 99 };
  });
  s.monitor.configure(true, true); await flush(); await s.tick(); await s.tick();
  assert.equal(s.monitor.status().active.length, 2);
  const sampledAt = Date.now();
  failed = true;
  for (let i = 0; i < 12; i++) await s.tick();
  assert.deepEqual(s.monitor.status().active, []);
  const restored = createMonitorStore(s.bb).state();
  assert.equal(restored.lastSampleAt, sampledAt);
  assert.equal(restored.cpu.active, true, "missing readings cannot prove recovery");
  failed = false; await s.tick();
  assert.equal(s.monitor.status().active.length, 2);
  assert.equal(s.harness.realtimeSignals.length, 2, "resuming must not duplicate incidents");
});

test("quiet samples persist broken candidates and recoveries before the next summary", async (t) => {
  let sample = { ...base, memory: 99 };
  const s = await setupMonitor(t, async () => sample);
  s.monitor.configure(true, true); await flush();
  sample = base; await s.tick();
  const restored = createMonitorStore(s.bb).state();
  assert.equal(restored.memory.since, null);
  assert.deepEqual(stepPressure(restored, { cpu: null, memory: 99 }, Date.now() + 30_000).events, []);
  sample = { ...base, memory: 99 }; await s.tick(); await s.tick(); await s.tick();
  sample = base; await s.tick();
  assert.equal(createMonitorStore(s.bb).state().memory.recoveringSince, Date.now());
  sample = { ...base, memory: 99 }; await s.tick();
  assert.equal(createMonitorStore(s.bb).state().memory.recoveringSince, null);
});

test("the first failed read after restart breaks persisted confirmation streaks", async (t) => {
  const s = await setupMonitor(t, async () => { throw new Error("read failed"); });
  const previous = stepPressure(freshPressureState(), { cpu: null, memory: 99 }, Date.now() - 30_000).state;
  createMonitorStore(s.bb).write([], previous);
  s.monitor.configure(true, true); await flush();
  assert.equal(createMonitorStore(s.bb).state().memory.since, null);
});

test("disable clears persisted incidents before a restarted monitor has sampled", async (t) => {
  const s = await setupMonitor(t);
  const previous = freshPressureState();
  Object.assign(previous.memory, { active: true, since: Date.now() - 60_000, peak: 99 });
  previous.lastSampleAt = Date.now();
  const storage = createMonitorStore(s.bb);
  storage.write([{ ...notice(1, "incident", "memory") }], previous);
  s.monitor.configure(true, true);
  s.monitor.configure(false, true);
  assert.equal(storage.state().memory.active, false);
  assert.deepEqual(storage.alerts(), []);
  await flush(); assert.equal(s.calls(), 0);
});

test("monitor restart preserves active incidents without duplicate alerts; disable clears them", async (t) => {
  const s = await setupMonitor(t, async () => ({ ...base, cpu: 99, memory: 99 }));
  s.monitor.configure(true, true); await flush(); await s.tick(); await s.tick();
  assert.equal(s.harness.realtimeSignals.length, 2);
  s.controller.abort(); s.monitor.dispose(); await s.running;
  const replacement = createPressureMonitor(s.bb, async () => ({ ...base, cpu: 99, memory: 99 }), () => {});
  replacement.configure(true, true);
  const controller = new AbortController(); const running = replacement.start(controller.signal);
  t.after(async () => { controller.abort(); replacement.dispose(); await running; });
  await flush(); await s.tick();
  assert.equal(replacement.status().active.length, 2);
  assert.equal(s.harness.realtimeSignals.length, 2);
  replacement.configure(false, true);
  assert.equal(createMonitorStore(s.bb).state().memory.active, false);
  replacement.configure(true, true); await flush(); await s.tick();
  assert.equal(replacement.status().active.length, 0);
  assert.equal(replacement.status().recent.length, 0, "disabled incidents cannot replay on re-enable");
});

test("active incident notices survive eviction from the diagnostic ring", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" }); t.after(() => harness.lifecycle.dispose());
  const store = createMonitorStore(bb);
  store.write([{ ...notice(1) }]);
  for (let i = 0; i < LOG_LIMIT; i++) store.write([{ type: "summary", timestamp: i }]);
  assert.equal(store.alerts().length, 0);
  assert.equal(store.currentNotices()[0].type, "incident");
  store.write([{ ...notice(2, "recovery") }]);
  assert.equal(store.currentNotices().length, 1);
  assert.equal(store.currentNotices()[0].type, "recovery");
});

test("a newer live CPU event cannot hide a missed memory alert during reconciliation", () => {
  const shown = [], saved = [];
  const r = createAlertReceiver(1, (n) => shown.push(n), (c) => saved.push(c));
  r.receive(notice(10));
  const resumed = createAlertReceiver(saved.at(-1), (n) => shown.push(n), () => {});
  resumed.reconcile({ enabled: true, notifications: true, cursor: 9, active: [notice(9, "incident", "memory")], recent: [] });
  assert.deepEqual(shown.map((n) => n.sequence), [10, 9]);
  resumed.receive(notice(10)); assert.equal(shown.length, 2);
});

test("alert receiver deduplicates live/reconnect traffic and never rewinds on stale responses", () => {
  const shown = [], saved = []; const r = createAlertReceiver(0, (n) => shown.push(n), (c) => saved.push(c));
  r.receive(notice(10)); r.receive(notice(10));
  r.reconcile({ enabled: true, notifications: true, cursor: 9, active: [notice(9)], recent: [] });
  assert.equal(shown.length, 1); assert.deepEqual(saved.at(-1), { cpu: 10, memory: 9 });
  r.receive(notice(11, "recovery")); assert.equal(shown.length, 2);
});
test("a new tab only surfaces active incidents, not historical resolved incidents", () => {
  const shown = []; const r = createAlertReceiver(0, (n) => shown.push(n), () => {});
  r.reconcile({ enabled: true, notifications: true, cursor: 5, active: [], recent: [notice(1), notice(2, "recovery")] });
  assert.equal(shown.length, 0); r.receive(notice(6)); assert.equal(shown.length, 1);
  assert.equal(isAlertNotice({ type: "incident", metric: "memory" }), false);
});
test("live traffic before the first reconciliation does not replay a new tab's historical recoveries", () => {
  const shown = []; const r = createAlertReceiver(null, (n) => shown.push(n), () => {});
  r.receive(notice(10));
  r.reconcile({ enabled: true, notifications: true, cursor: 10, active: [notice(10)], recent: [notice(8, "recovery", "memory"), notice(10)] });
  assert.deepEqual(shown.map((n) => n.sequence), [10]);
  r.reconcile({ enabled: true, notifications: true, cursor: 12, active: [notice(10)], recent: [notice(12, "recovery", "memory")] });
  assert.deepEqual(shown.map((n) => n.sequence), [10, 12]);
});
test("reconnect collapses missed transitions to one latest notice per metric", () => {
  const shown = []; const r = createAlertReceiver(1, (n) => shown.push(n), () => {});
  r.reconcile({ enabled: true, notifications: true, cursor: 8, active: [], recent: [notice(2), notice(3, "recovery"), notice(4, "incident", "memory"), notice(5, "recovery", "memory")] });
  assert.deepEqual(shown.map((n) => n.sequence), [3, 5]);
});
test("new SDK contract and CLI expose bounded logs without sampling full snapshots", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" }); t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const status = await harness.behavior.callRpc("monitor_status", null); assert.equal(status.enabled, false);
  assert.equal((await harness.behavior.runCli(["logs", "--json"])).stdout, "");
  assert.equal((await harness.behavior.runCli(["logs", "--limit", "501"])).exitCode, 1);
  assert.equal((await harness.behavior.runCli(["logs", "--limit", "oops"])).exitCode, 1);
  assert.equal((await harness.behavior.callRpc("metrics_snapshot", null)).history.length, 1);
  const store = createMonitorStore(bb);
  for (let i = 0; i < 500; i++) store.write([{ type: "summary", timestamp: i, padding: "x".repeat(940) }]);
  for (const args of [["logs", "--limit", "500"], ["logs", "--limit", "500", "--json"]]) {
    const result = await harness.behavior.runCli(args);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.split("\n").length, 500);
    assert.ok(Buffer.byteLength(result.stdout) < PLUGIN_CLI_OUTPUT_MAX_BYTES);
  }
});

test("test alerts are explicit, respect settings, and leave diagnostics and incident state unchanged", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" }); t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  assert.equal((await harness.behavior.runCli(["test-alert"])).exitCode, 1);
  await harness.behavior.setSettings({ backgroundMonitoring: true, pressureNotifications: true });
  const before = await harness.behavior.callRpc("monitor_status", null);
  assert.equal((await harness.behavior.runCli(["test-alert", "oops"])).exitCode, 1);
  assert.equal(harness.realtimeSignals.length, 0);
  assert.equal((await harness.behavior.runCli(["test-alert"])).exitCode, 0);
  assert.equal(harness.realtimeSignals.length, 1);
  assert.deepEqual(await harness.behavior.callRpc("monitor_status", null), before);
  assert.equal((await harness.behavior.runCli(["logs", "--json"])).stdout, "");
  await harness.behavior.setSettings({ pressureNotifications: false });
  assert.equal((await harness.behavior.runCli(["test-alert"])).exitCode, 1);
  assert.equal(harness.realtimeSignals.length, 1);
});

test("malformed persisted notices are ignored without breaking status or state reads", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" }); t.after(() => harness.lifecycle.dispose());
  const store = createMonitorStore(bb); store.write([{ ...notice(1) }], freshPressureState());
  const db = bb.storage.database();
  db.prepare("UPDATE pressure_notices SET payload = ?").run('{"metric":"unknown"}');
  db.prepare("UPDATE pressure_logs SET payload = ?").run("invalid JSON");
  db.prepare("UPDATE pressure_state SET payload = ?").run("invalid JSON");
  assert.deepEqual(store.alerts(), []); assert.deepEqual(store.currentNotices(), []);
  assert.deepEqual(store.state(), freshPressureState());
});

test("damaged diagnostic rows cannot prevent exporting the remaining logs", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "beacon" }); t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const store = createMonitorStore(bb);
  const payloads = ["invalid JSON", "null", "[]", '{"type":"summary","timestamp":1e100}', '{"type":"summary","timestamp":"yesterday"}', '{"type":"summary","timestamp":1,"nested":{}}'];
  store.write(Array.from({ length: payloads.length + 2 }, (_, timestamp) => ({ type: "summary", timestamp })));
  const update = bb.storage.database().prepare("UPDATE pressure_logs SET payload = ? WHERE sequence = ?");
  payloads.forEach((payload, index) => update.run(payload, index + 2));
  assert.deepEqual(store.read().map((entry) => entry.sequence), [1, payloads.length + 2]);
  for (const args of [["logs"], ["logs", "--json"]]) {
    const result = await harness.behavior.runCli(args);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.split("\n").length, 2);
  }
  assert.equal(store.cursor(), payloads.length + 2, "invalid rows still count toward the alert cursor");
});


test("a locked monitor database incurs one busy wait and recovers on the next sample", async (t) => {
  const s = await setupMonitor(t);
  const db = s.bb.storage.database(); db.pragma("journal_mode = WAL");
  const original = db.transaction.bind(db);
  let attempts = 0;
  t.mock.method(db, "transaction", (fn) => {
    const tx = original(fn);
    return Object.assign((...args) => tx(...args), {
      immediate: (...args) => { attempts++; return tx.immediate(...args); },
      deferred: tx.deferred, exclusive: tx.exclusive,
    });
  });
  s.monitor.configure(true, false); s.monitor.status();
  const writer = new Database(db.name);
  t.after(() => { if (writer.inTransaction) writer.exec("ROLLBACK"); writer.close(); });
  writer.exec("BEGIN IMMEDIATE");
  await flush();
  assert.equal(attempts, 1, "must not immediately retry a failed database write to log that failure");
  assert.equal(s.harness.logEntries.filter((entry) => entry.level === "warn").length, 1);
  assert.equal(s.monitor.logs(100).length, 0);
  await s.tick(); assert.equal(attempts, 2, "one attempt per interval while locked");
  writer.exec("ROLLBACK"); await s.tick();
  assert.equal(s.monitor.logs(100).filter((entry) => entry.type === "summary").length, 1);
  assert.equal(s.harness.realtimeSignals.length, 0);
});
