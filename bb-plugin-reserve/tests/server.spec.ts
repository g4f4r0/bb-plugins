// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
const cli = vi.hoisted(()=>({read:vi.fn(),consume:vi.fn()}));
vi.mock('../lib/codex-reset-credits.ts',()=>({EMPTY_CODEX_CLI:{accountEmail:null,availableCount:null,coreWindows:[],extraWindows:[]},readCodexCliEnrichment:cli.read,consumeCodexRateLimitResetCredit:cli.consume}));
import plugin from '../server';
const live: Array<ReturnType<typeof createFakePluginHost>>=[];
afterEach(async()=>{for(const host of live.splice(0))await host.harness.lifecycle.dispose();vi.resetAllMocks();});
function host(settings:Record<string,string|number|boolean>={}) {
  cli.read.mockResolvedValue({accountEmail:null,availableCount:null,coreWindows:[],extraWindows:[]});
  const fixture=createFakePluginHost({pluginId:'reserve',settings,sdk:{hosts:{list:async()=>[]},system:{usageLimits:async()=>({})}}});
  live.push(fixture);plugin(fixture.bb);return fixture;
}
it('does no background usage or CLI work at registration, and reload removes registrations',async()=>{
  const {harness}=host();await new Promise(r=>setImmediate(r));expect(cli.read).not.toHaveBeenCalled();
  expect(harness.inspection.sdk.callsTo('hosts.list')).toHaveLength(0);
  const result=await harness.behavior.callRpc('getUsage',{});
  expect(result).toMatchObject({hosts:expect.any(Array),totals:[],unavailableHosts:0});
  expect(cli.read).toHaveBeenCalledTimes(1);
  await harness.lifecycle.reload(plugin);await new Promise(r=>setImmediate(r));expect(cli.read).toHaveBeenCalledTimes(1);
});
it('all disabled providers skip host and CLI reads',async()=>{
  const {harness}=host({enableCodex:false,enableClaudeCode:false,enableCursor:false,enableGrok:false,enableOpenCode:false});
  expect(await harness.behavior.callRpc('getUsage',{})).toMatchObject({totals:[],hosts:[]});
  expect(cli.read).not.toHaveBeenCalled();expect(harness.inspection.sdk.callsTo('hosts.list')).toHaveLength(0);
});
it('reload cancels a hung RPC without stale writes or retries',async()=>{
  const {harness}=host({enableCodex:false});
  let signal:AbortSignal|undefined;
  harness.sdk.stub('system.usageLimits',async(args: {signal?:AbortSignal})=>{signal=args?.signal;return new Promise(()=>{});});
  const pending=harness.behavior.callRpc('getUsage',{});
  const rejected=expect(pending).rejects.toThrow();
  await new Promise(r=>setImmediate(r));await harness.lifecycle.reload(plugin);await rejected;
  expect(signal?.aborted).toBe(true);
});
it('serializes fleet once and safely skips oversized KV persistence',async()=>{
  const {harness}=host({enableCodex:false});
  harness.sdk.stub('hosts.list',async()=>Array.from({length:1000},(_,i)=>({id:String(i),name:`Machine ${i}`,status:'connected',type:'persistent'})));
  harness.sdk.stub('system.usageLimits',async(args: {hostId?:string})=>({'claude-code':{status:'ok',accountEmail:`${args?.hostId}@example.test`,windows:[{label:'Weekly',usedPercent:10,resetsAt:null}]}}));
  const result=await harness.behavior.callRpc('getUsage',{}) as {totals:Array<{hosts?:unknown}>;hosts:unknown[]};
  expect(result.hosts).toHaveLength(1000);expect(result.totals).toHaveLength(1000);expect(result.totals.every(login=>login.hosts===undefined)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(500000);
});
it('offline fleet members do not mask failure of every connected host',async()=>{
  const {harness}=host({enableCodex:false});
  harness.sdk.stub('hosts.list',async()=>[{id:'online',name:'online',status:'connected',type:'persistent'},{id:'offline',name:'offline',status:'disconnected',type:'persistent'}]);
  harness.sdk.stub('system.usageLimits',async()=>{throw new Error('network down');});
  await expect(harness.behavior.callRpc('getUsage',{})).rejects.toThrow('Usage is unavailable on connected machines');
});
