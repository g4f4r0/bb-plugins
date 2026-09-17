import assert from "node:assert/strict";
import test from "node:test";
import { createCachedLoader } from "../lib/usage-cache.ts";

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("fresh hits skip a second load and share one inflight", async () => {
  let loads = 0;
  let now = 1_000;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cache = createCachedLoader({
    async load() {
      loads += 1;
      if (loads === 1) await gate;
      return { n: loads, ttl: 1_000 };
    },
    ttlMs: (value) => value.ttl,
    now: () => now,
  });

  const first = cache.get();
  const second = cache.get();
  release();
  assert.equal((await first).n, 1);
  assert.equal((await second).n, 1);
  assert.equal(loads, 1);
  now = 1_500;
  assert.equal((await cache.get()).n, 1);
  now = 3_100;
  assert.equal((await cache.get()).n, 1);
  assert.equal(loads, 2);
  await wait(0);
  assert.equal((await cache.get()).n, 2);
  cache.invalidate();
  assert.equal((await cache.get(true)).n, 3);
  assert.equal(loads, 3);
});

test("hydrate serves immediately and refreshes in the background", async () => {
  let loads = 0;
  let now = 5_000;
  const cache = createCachedLoader({
    async load() {
      loads += 1;
      return { n: loads, ttl: 1_000 };
    },
    ttlMs: (value) => value.ttl,
    now: () => now,
  });

  cache.hydrate({ n: 0, ttl: 1_000 }, 0);
  assert.equal((await cache.get()).n, 0);
  assert.equal(loads, 1);
  await wait(0);
  assert.equal((await cache.get()).n, 1);
  cache.hydrate({ n: 99, ttl: 1_000 }, 0);
  assert.equal((await cache.get()).n, 1);
});

test('failure storms back off, including stale background rejection and forced clients', async () => {
  let now = 10_000, loads = 0;
  const cache = createCachedLoader<{n:number}>({load:async()=>{loads++;throw new Error('offline');}, ttlMs:()=>1000, now:()=>now});
  cache.hydrate({n:0},0);
  await cache.get(); await wait(0);
  for(let i=0;i<1000;i++) await cache.get(true);
  assert.equal(loads,1);
  now+=5000;await assert.rejects(cache.get(true),/offline/);assert.equal(loads,2);
  now+=9999;await cache.get(true);assert.equal(loads,2);
  now+=1;await assert.rejects(cache.get(true),/offline/);assert.equal(loads,3);
  cache.dispose();await assert.rejects(cache.get(),/disposed/);
});

test('disposal cannot repopulate or hydrate the cache after a slow load', async () => {
  let resolve!: (value:{n:number})=>void;
  const cache=createCachedLoader({load:()=>new Promise<{n:number}>(r=>{resolve=r;}),ttlMs:()=>10000});
  const request=cache.get();await Promise.resolve();cache.dispose();resolve({n:1});await request;
  cache.hydrate({n:2},Date.now());await assert.rejects(cache.get(),/disposed/);
});

test('invalidation rejects an old in-flight generation instead of presenting it as fresh',async()=>{
  let resolve!: (value:{n:number})=>void;
  const cache=createCachedLoader({load:()=>new Promise<{n:number}>(r=>{resolve=r;}),ttlMs:()=>10000});
  const old=cache.get();const rejected=assert.rejects(old,/changed/);await Promise.resolve();cache.invalidate();resolve({n:1});await rejected;
  const next=cache.get();await Promise.resolve();resolve({n:2});assert.equal((await next).n,2);cache.dispose();
});
