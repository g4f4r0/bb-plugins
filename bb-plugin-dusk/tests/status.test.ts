import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFamilies, wakeLabel, snoozePresets, canSnooze } from '../lib/status.ts';

const idle = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 };
let n = 0;
const t = (over: Record<string, unknown> = {}) => ({ id: `thr_${++n}`, parentThreadId: null, isPinned: false, isUnread: false, hasPendingInteraction: false, indicator: 'none', activity: idle, updatedAt: 100, latestAttentionAt: 100, createdAt: 1, ...over }) as any;
const ids = (families: any[]) => families.map((f) => f.root.id);

test('sorts threads into status sections', () => {
  const pinned = t({ isPinned: true, indicator: 'runtime' });
  const asks = t({ hasPendingInteraction: true });
  const failed = t({ indicator: 'unread-error' });
  const running = t({ indicator: 'runtime' });
  const ready = t({ indicator: 'unread-success', isUnread: true });
  const unread = t({ isUnread: true });
  const done = t();
  const s = buildFamilies([pinned, asks, failed, running, ready, unread, done], new Map(), new Map(), 1000);
  assert.deepEqual(ids(s.get('pinned')!), [pinned.id]);
  assert.deepEqual(new Set(ids(s.get('waiting')!)), new Set([asks.id, failed.id]));
  assert.deepEqual(new Set(ids(s.get('ready')!)), new Set([ready.id, unread.id]));
  assert.deepEqual(ids(s.get('working')!), [running.id]);
  assert.deepEqual(ids(s.get('done')!), [done.id]);
});

test('a failed queued message waits on you; a scheduled one does not', () => {
  const failed = t({ indicator: 'queued-failed' });
  const scheduled = t({ indicator: 'queued-waiting' });
  const s = buildFamilies([failed, scheduled], new Map(), new Map(), 1000);
  assert.deepEqual(ids(s.get('waiting')!), [failed.id]);
  assert.deepEqual(ids(s.get('done')!), [scheduled.id]);
});

test('a child that asks moves its whole family to Waiting', () => {
  const parent = t({ indicator: 'runtime' });
  const child = t({ parentThreadId: parent.id, hasPendingInteraction: true, createdAt: 5 });
  const s = buildFamilies([parent, child], new Map(), new Map(), 1000);
  assert.deepEqual(ids(s.get('waiting')!), [parent.id]);
  assert.deepEqual(s.get('waiting')![0].children.map((c: any) => c.id), [child.id]);
});

test('snooze hides quiet threads until the timer or new activity', () => {
  const quiet = t();
  const snoozes = new Map([[quiet.id, { threadId: quiet.id, until: 5000, at: 200 }]]);
  assert.deepEqual(ids(buildFamilies([quiet], snoozes, new Map(), 1000).get('snoozed')!), [quiet.id]);
  assert.deepEqual(ids(buildFamilies([quiet], snoozes, new Map(), 5000).get('done')!), [quiet.id]);
  const woke = { ...quiet, latestAttentionAt: 300 };
  assert.deepEqual(ids(buildFamilies([woke], snoozes, new Map(), 1000).get('done')!), [quiet.id]);
  const working = { ...quiet, indicator: 'runtime' };
  assert.deepEqual(ids(buildFamilies([working], snoozes, new Map(), 1000).get('working')!), [quiet.id]);
  assert.equal(canSnooze([working]), false);
});

test('a working child keeps an unread parent in Working', () => {
  const parent = t({ indicator: 'unread-success', isUnread: true });
  const child = t({ parentThreadId: parent.id, indicator: 'runtime', createdAt: 5 });
  assert.deepEqual(ids(buildFamilies([parent, child], new Map(), new Map(), 1000).get('working')!), [parent.id]);
});

test('pinned follows BB pin order, other sections newest first', () => {
  const a = t({ isPinned: true }), b = t({ isPinned: true }), c = t({ updatedAt: 50, latestAttentionAt: 50 }), d = t({ updatedAt: 90, latestAttentionAt: 90 });
  const s = buildFamilies([a, b, c, d], new Map(), new Map([[a.id, 'b'], [b.id, 'a']]), 1000);
  assert.deepEqual(ids(s.get('pinned')!), [b.id, a.id]);
  assert.deepEqual(ids(s.get('done')!), [d.id, c.id]);
});

test('labels and presets', () => {
  assert.equal(wakeLabel(1000 + 30_000, 1000), '1m');
  assert.equal(wakeLabel(1000 + 2 * 3600_000, 1000), '2h');
  assert.equal(wakeLabel(1000 + 3600_000 - 5000, 1000), '1h');
  assert.equal(wakeLabel(1000 + 86_400_000 - 5000, 1000), '1d');
  const presets = snoozePresets(new Date(2026, 8, 16, 17, 0)); // Wednesday
  assert.equal(new Date(presets[2].until).getDate(), 17);
  assert.equal(new Date(presets[3].until).getDay(), 1);
  assert.equal(new Date(presets[3].until).getDate(), 21);
});
