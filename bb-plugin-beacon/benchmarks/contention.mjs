// Force a writer lock in an isolated real SQLite database, never the live database.
import { mock } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPressureMonitor } from "../lib/pressure-monitor.ts";

const { bb, harness } = createFakePluginHost({ pluginId: "beacon" });
const db = bb.storage.database();
db.pragma("journal_mode = WAL");
const original = db.transaction.bind(db);
let attempts = 0;
db.transaction = (fn) => {
  const tx = original(fn);
  return Object.assign((...args) => tx(...args), {
    immediate: (...args) => { attempts++; return tx.immediate(...args); },
    deferred: tx.deferred, exclusive: tx.exclusive,
  });
};
const sample = { cpu: 10, memory: 40, load1: 0.2, rssBytes: 1000, heapUsedBytes: 500, availableBytes: 6000, totalBytes: 10000 };
const monitor = createPressureMonitor(bb, async () => sample, () => {});
monitor.configure(true, false);
monitor.status();
const writer = new Database(db.name);
writer.exec("BEGIN IMMEDIATE");
mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
const controller = new AbortController();
const started = process.hrtime.bigint();
const running = monitor.start(controller.signal);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
try {
  await flush();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const lockedAttempts = attempts;
  assert.equal(harness.logEntries.filter((e) => e.level === "warn").length, 1);
  assert.equal(monitor.logs(100).length, 0);
  writer.exec("ROLLBACK");
  mock.timers.tick(30000); await flush();
  assert.equal(monitor.logs(100).filter((entry) => entry.type === "summary").length, 1);
  console.log(JSON.stringify({ lockedAttempts, elapsedMs, recoveredOnNextInterval: true }, null, 2));
} finally {
  if (writer.inTransaction) writer.exec("ROLLBACK");
  writer.close(); controller.abort(); monitor.dispose(); await running;
  await harness.lifecycle.dispose(); mock.timers.reset();
}
