import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PromiseCache } from '../lib/promise-cache.ts';
test('bounds successful and pending hover requests, reuses recent results', async () => {
 const cache=new PromiseCache<number>(128);
 for(let i=0;i<1000;i++)await cache.get(String(i),async()=>i);
 assert.equal(cache.size,128);
 assert.equal(await cache.get('999',async()=>-1),999);
 for(let i=0;i<1000;i++)void cache.get(`pending${i}`,()=>new Promise(()=>{}));
 assert.equal(cache.size,128);
});
test('an expired rejection cannot evict its replacement', async () => {
 const cache=new PromiseCache<number>(2,10);let reject!:(reason:Error)=>void;
 const old=cache.get('a',()=>new Promise((_,r)=>reject=r),0);await Promise.resolve();
 const next=cache.get('a',async()=>2,11);reject(new Error('offline'));
 await assert.rejects(old);assert.equal(await next,2);
 assert.equal(await cache.get('a',async()=>3,12),2);
});
test('failures can retry and least recently used entries are evicted', async () => {
 const cache=new PromiseCache<number>(2);
 await assert.rejects(cache.get('a',async()=>{throw Error('offline')}));
 assert.equal(await cache.get('a',async()=>1),1);
 await cache.get('b',async()=>2);await cache.get('a',async()=>3);await cache.get('c',async()=>4);
 assert.equal(await cache.get('b',async()=>5),5);
});
test('resolved values are immediately readable and remain visible while revalidating', async () => {
 const cache=new PromiseCache<number>(2,10);
 assert.equal(cache.peek('a'),undefined);
 await cache.get('a',async()=>1,0);
 assert.equal(cache.peek('a'),1);
 let resolve!:(value:number)=>void;
 const pending=cache.get('a',()=>new Promise(r=>resolve=r),11);
 assert.equal(cache.peek('a'),1);
 await Promise.resolve();resolve(2);await pending;
 assert.equal(cache.peek('a'),2);
 await cache.get('b',async()=>3,12);await cache.get('c',async()=>4,13);
 assert.equal(cache.peek('a'),undefined, 'resolved values share the same bounded lifetime');
});
