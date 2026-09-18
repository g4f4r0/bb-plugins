import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemandSampler } from "../lib/demand-sampler.ts";
import { createSnapshotSource } from "../lib/snapshot-source.ts";
import { createVisiblePoller } from "../lib/visible-poller.ts";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function clock(t) { t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 }); }
function sampler(t, overrides = {}) {
  clock(t);
  let calls = 0, resets = 0;
  const instance = createDemandSampler({ collect: async () => ({ id: ++calls }), reset: () => { resets++; }, intervalMs: () => 5000, now: () => Date.now(), ...overrides });
  t.after(() => instance.dispose());
  return { ...instance, calls: () => calls, resets: () => resets };
}

test("sampler does no work or cache allocation before the first request", async (t) => {
  const s = sampler(t);
  t.mock.timers.tick(3_600_000); await flush();
  assert.equal(s.calls(), 0); assert.equal(s.resets(), 0);
});
test("simultaneous viewers share one in-flight collection and one cached result", async (t) => {
  const s = sampler(t);
  const requests = Array.from({ length: 100 }, () => s.sample());
  assert.ok(requests.every((p) => p === requests[0]));
  const values = await Promise.all(requests);
  assert.equal(s.calls(), 1); assert.ok(values.every((v) => v === values[0]));
  assert.equal(await s.sample(), values[0]);
  t.mock.timers.tick(5000);
  assert.equal((await s.sample()).id, 2);
});
test("a forced sample bypasses a fresh cached result", async (t) => {
  const s = sampler(t);
  assert.equal((await s.sample()).id, 1);
  assert.equal((await s.sample()).id, 1);
  assert.equal((await s.sample(true)).id, 2);
  assert.equal(s.calls(), 2);
});
test("idle expiry releases cache and baselines without collecting again", async (t) => {
  const s = sampler(t); await s.sample();
  t.mock.timers.tick(14_999); assert.equal(s.resets(), 0);
  t.mock.timers.tick(1); assert.equal(s.resets(), 1);
  t.mock.timers.tick(3_600_000); await flush(); assert.equal(s.calls(), 1);
  assert.equal((await s.sample()).id, 2);
});
test("cached readers extend one expiry, not an accumulating collection of timers", async (t) => {
  const s = sampler(t); await s.sample();
  t.mock.timers.tick(4000); await Promise.all(Array.from({ length: 100 }, () => s.sample()));
  t.mock.timers.tick(11_000); assert.equal(s.resets(), 0);
  t.mock.timers.tick(4000); assert.equal(s.resets(), 1);
});
test("long refresh intervals retain history across an active polling interval", async (t) => {
  const s = sampler(t, { intervalMs: () => 60_000 }); await s.sample();
  t.mock.timers.tick(60_000); assert.equal(s.resets(), 0);
  await s.sample(); assert.equal(s.calls(), 2);
  t.mock.timers.tick(120_000); assert.equal(s.resets(), 1);
});
test("a slow collection cannot be evicted by the old cache timer", async (t) => {
  let slow = false; const d = deferred();
  const s = sampler(t, { collect: () => slow ? d.promise : Promise.resolve(1) });
  await s.sample(); slow = true; t.mock.timers.tick(5000);
  const pending = s.sample(); await flush(); t.mock.timers.tick(30_000);
  assert.equal(s.resets(), 0); d.resolve(2); assert.equal(await pending, 2);
});
test("collection errors reset baselines and permit a later successful request", async (t) => {
  let fail = true;
  const s = sampler(t, { collect: () => { if (fail) throw new Error("read failed"); return Promise.resolve(2); } });
  await assert.rejects(s.sample(), /read failed/); assert.equal(s.resets(), 1);
  fail = false; assert.equal(await s.sample(), 2);
});
test("dispose aborts collection and prevents late results from restoring cache", async (t) => {
  const d = deferred(); let signal;
  const s = sampler(t, { collect: (next) => { signal = next; return d.promise; } });
  const pending = s.sample(); await flush(); s.dispose();
  assert.equal(signal.aborted, true); d.resolve({ large: [] });
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(s.sample(), /disposed/);
  const resets = s.resets(); t.mock.timers.tick(3_600_000); assert.equal(s.resets(), resets);
});
test("dispose before collection begins does not start I/O", async (t) => {
  const s = sampler(t); const pending = s.sample(); s.dispose();
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(s.calls(), 0);
});

function poller(t, overrides = {}) {
  clock(t);
  const received = [], errors = []; let calls = 0;
  const instance = createVisiblePoller({ load: async () => ++calls, receive: (v) => received.push(v), error: (e) => errors.push(e), intervalMs: () => 5000, ...overrides });
  t.after(() => instance.dispose());
  return { ...instance, received, errors, calls: () => calls };
}
test("hidden poller is dormant; activation loads once and schedules after completion", async (t) => {
  const p = poller(t); t.mock.timers.tick(60_000); await flush(); assert.equal(p.calls(), 0);
  p.setActive(true); p.setActive(true); await flush(); assert.equal(p.calls(), 1);
  t.mock.timers.tick(4999); await flush(); assert.equal(p.calls(), 1);
  t.mock.timers.tick(1); await flush(); assert.equal(p.calls(), 2);
});
test("hiding preserves the last received snapshot and stops requests for arbitrarily long idle periods", async (t) => {
  const p = poller(t); p.setActive(true); await flush(); p.setActive(false);
  assert.deepEqual(p.received, [1]); t.mock.timers.tick(3_600_000); await flush(); assert.equal(p.calls(), 1);
  p.setActive(true); await flush(); assert.equal(p.calls(), 2);
});
test("slow requests never overlap, even across rapid hide/show cycles", async (t) => {
  const first = deferred(); let calls = 0;
  const p = poller(t, { load: () => ++calls === 1 ? first.promise : Promise.resolve("fresh") });
  p.setActive(true); await flush(); t.mock.timers.tick(60_000); await flush(); assert.equal(calls, 1);
  for (let i = 0; i < 20; i++) { p.setActive(false); p.setActive(true); }
  assert.equal(calls, 1); first.resolve("stale"); await flush(); assert.deepEqual(p.received, []);
  t.mock.timers.tick(0); await flush(); assert.equal(calls, 2); assert.deepEqual(p.received, ["fresh"]);
});
test("a late hidden response cannot repopulate data or schedule more polling", async (t) => {
  const d = deferred(); const p = poller(t, { load: () => d.promise });
  p.setActive(true); p.setActive(false); d.resolve("stale"); await flush();
  assert.deepEqual(p.received, []); t.mock.timers.tick(60_000); await flush(); assert.deepEqual(p.received, []);
});
test("late hidden errors are ignored", async (t) => {
  const d = deferred(); const p = poller(t, { load: () => d.promise });
  p.setActive(true); p.setActive(false); d.reject(new Error("offline")); await flush(); assert.deepEqual(p.errors, []);
});
test("failures back off with a cap and recover without duplicate requests", async (t) => {
  let calls = 0, fail = true;
  const p = poller(t, { load: async () => { calls++; if (fail) throw new Error("offline"); return "ok"; } });
  p.setActive(true); await flush(); assert.equal(calls, 1);
  for (const delay of [5000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    const before = calls; t.mock.timers.tick(delay - 1); await flush(); assert.equal(calls, before);
    t.mock.timers.tick(1); await flush(); assert.equal(calls, before + 1);
  }
  fail = false; t.mock.timers.tick(60_000); await flush(); assert.deepEqual(p.received, ["ok"]);
  const before = calls; t.mock.timers.tick(5000); await flush(); assert.equal(calls, before + 1);
});
test("disposal ignores pending responses and cancels scheduled work", async (t) => {
  const d = deferred(); const p = poller(t, { load: () => d.promise });
  p.setActive(true); p.dispose(); d.resolve("late"); await flush();
  p.setActive(true); t.mock.timers.tick(60_000); await flush(); assert.deepEqual(p.received, []);
});
test("server-supplied polling intervals are bounded", async (t) => {
  const p = poller(t, { intervalMs: () => 1 }); p.setActive(true); await flush();
  t.mock.timers.tick(1999); await flush(); assert.equal(p.calls(), 1);
  t.mock.timers.tick(1); await flush(); assert.equal(p.calls(), 2);
});
test("manual refresh runs immediately only while the poller is active", async (t) => {
  const p = poller(t); p.setActive(true); await flush();
  assert.equal(p.calls(), 1); assert.equal(p.refresh(), true); await flush(); assert.equal(p.calls(), 2);
  p.setActive(false); assert.equal(p.refresh(), false); await flush(); assert.equal(p.calls(), 2);
});


test("rapid reopening preserves the sampling cadence and offline backoff", async (t) => {
  let fail = false;
  const p = poller(t, { load: async () => { if (fail) throw new Error("offline"); return "ok"; } });
  p.setActive(true); await flush();
  for (let i = 0; i < 50; i++) { p.setActive(false); p.setActive(true); await flush(); }
  assert.equal(p.received.length, 1);
  fail = true; t.mock.timers.tick(5000); await flush();
  assert.equal(p.errors.length, 1);
  for (let i = 0; i < 50; i++) { p.setActive(false); p.setActive(true); await flush(); }
  assert.equal(p.errors.length, 1);
  t.mock.timers.tick(5000); await flush(); assert.equal(p.errors.length, 2);
  p.setActive(false); p.setActive(true); t.mock.timers.tick(9999); await flush();
  assert.equal(p.errors.length, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(p.errors.length, 3);
});

test("a longer interval extends cache expiry before the next dashboard request", async (t) => {
  let interval = 2000;
  const s = sampler(t, { intervalMs: () => interval }); await s.sample();
  interval = 30_000; s.intervalChanged();
  t.mock.timers.tick(30_000); assert.equal(s.resets(), 0);
  await s.sample(); assert.equal(s.calls(), 2);
  t.mock.timers.tick(60_000); assert.equal(s.resets(), 1);
  s.dispose(); s.intervalChanged();
  const resets = s.resets(); t.mock.timers.tick(60_000); assert.equal(s.resets(), resets);
});

test("polling switches from a clamped 1s interval to 30s without overlapping", async (t) => {
  let interval = 1000;
  const p = poller(t, { intervalMs: () => interval }); p.setActive(true); await flush();
  interval = 30_000;
  t.mock.timers.tick(2000); await flush(); assert.equal(p.calls(), 2);
  t.mock.timers.tick(29_999); await flush(); assert.equal(p.calls(), 2);
  t.mock.timers.tick(1); await flush(); assert.equal(p.calls(), 3);
});


test("disclosure remounts share one request and preserve snapshot and offline backoff", async (t) => {
  clock(t);
  const source = createSnapshotSource(() => 2000);
  const first = deferred(); let calls = 0;
  const collect = () => { calls++; return first.promise; };
  const requests = Array.from({ length: 50 }, () => source.load(collect));
  await flush(); assert.equal(calls, 1);
  first.resolve("snapshot"); await Promise.all(requests);
  assert.equal(source.snapshot(), "snapshot");
  for (let i = 0; i < 50; i++) await source.load(collect);
  assert.equal(calls, 1);
  t.mock.timers.tick(2000);
  const offline = () => { calls++; throw new Error("offline"); };
  for (let i = 0; i < 50; i++) await assert.rejects(source.load(offline), /offline/);
  assert.equal(calls, 2); assert.equal(source.snapshot(), "snapshot");
  t.mock.timers.tick(5000); await assert.rejects(source.load(offline)); assert.equal(calls, 3);
  t.mock.timers.tick(9999); await assert.rejects(source.load(offline)); assert.equal(calls, 3);
  t.mock.timers.tick(600_000); await flush(); assert.equal(calls, 3);
  assert.equal(await source.load(async () => "recovered"), "recovered");
});
test("a forced snapshot load bypasses the frontend cadence", async (t) => {
  clock(t);
  const source = createSnapshotSource(() => 60_000); let calls = 0;
  const collect = async () => ++calls;
  assert.equal(await source.load(collect), 1);
  assert.equal(await source.load(collect), 1);
  assert.equal(await source.load(collect, true), 2);
});
