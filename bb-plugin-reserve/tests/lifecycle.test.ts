import assert from 'node:assert/strict';
import test from 'node:test';
import { withDeadline } from '../lib/async-limits.ts';
import { loadFleetReadings } from '../lib/load-fleet.ts';
import { createResetActionGate } from '../lib/reset-action-gate.ts';
import { formatter } from '../lib/formatters.ts';

test('1000 hosts have at most eight outstanding reads and preserve order',async()=>{
  let active=0,peak=0,calls=0;
  const hosts=Array.from({length:1000},(_,i)=>({id:String(i),name:String(i),type:'persistent' as const,status:'connected' as const}));
  const result=await loadFleetReadings({hosts:{async list(){return hosts;}},system:{async usageLimits(){active++;calls++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;return {};}}});
  assert.equal(peak,8);assert.equal(calls,1000);assert.deepEqual(result.map(r=>r.host.id),hosts.map(h=>h.id));
});
test('deadline bounds even an RPC that ignores cancellation',async()=>{
  const start=Date.now();await assert.rejects(withDeadline(()=>new Promise(()=>{}),20),/timed out/);assert.ok(Date.now()-start<500);
});
test('dispose stops queued host reads and fallback retries',async()=>{
  const controller=new AbortController();let calls=0;
  const hosts=Array.from({length:1000},(_,i)=>({id:String(i),name:String(i),type:'persistent' as const,status:'connected' as const}));
  const pending=loadFleetReadings({hosts:{async list(){return hosts;}},system:{async usageLimits(){calls++;return new Promise(()=>{});}}},new Date(),10000,controller.signal);
  await new Promise(r=>setImmediate(r));controller.abort();await pending;assert.equal(calls,8);
});
test('reset confirmations cap at 128, expire, and are invalid after reload disposal',async()=>{
  let now=0;const gate=createResetActionGate(async()=> 'reset',()=>now);gate.setAvailableCount(2);
  for(let i=0;i<128;i++)assert.equal(gate.prepare().outcome,'ready');assert.equal(gate.prepare().outcome,'unavailable');
  now=120001;const ready=gate.prepare();assert.equal(ready.outcome,'ready');gate.dispose();gate.setAvailableCount(2);
  assert.equal(gate.prepare().outcome,'unavailable');if(ready.outcome==='ready')assert.equal(await gate.consume(ready.confirmationToken),'confirmation-invalid');
});
test('formatter LRU keeps hot entries and evicts past sixteen',()=>{
  let made=0;const create=()=>{made++;return new Intl.NumberFormat('en-US');};
  const hot=formatter('hot',undefined,create);for(let i=0;i<15;i++)formatter(String(i),undefined,create);
  assert.equal(formatter('hot',undefined,create),hot);formatter('overflow',undefined,create);
  assert.equal(formatter('hot',undefined,create),hot);formatter('0',undefined,create);assert.equal(made,18);
});

test('deadline preserves successful hosts while marking hung and queued hosts unavailable',async()=>{
  const controller=new AbortController();
  const result=loadFleetReadings({hosts:{async list(){return [{id:'ok',name:'ok',status:'connected',type:'persistent'},{id:'slow',name:'slow',status:'connected',type:'persistent'}];}},system:{async usageLimits(args){return args?.hostId==='ok' ? {} : new Promise(()=>{});}}},new Date(),10000,controller.signal);
  await new Promise(r=>setImmediate(r));controller.abort();const readings=await result;
  assert.notEqual(readings[0]?.snapshot,null);assert.equal(readings[1]?.snapshot,null);assert.notEqual(readings[1]?.error,null);
});

test('1000 abandoned views leave no waiters on a never-settling shared RPC',async()=>{
  const {createSharedRequest}=await import('../lib/shared-request.ts');const request=createSharedRequest<number>();let calls=0;
  for(let i=0;i<1000;i++){
    const controller=new AbortController();const result=request.read(async()=>{calls++;return new Promise(()=>{});},controller.signal);
    const rejected=assert.rejects(result);controller.abort();await rejected;assert.equal(request.waiterCount,0);
  }
  assert.equal(calls,1);
});
