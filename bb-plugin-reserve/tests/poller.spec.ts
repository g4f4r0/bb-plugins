// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createVisiblePoller } from '../lib/visible-poller';
afterEach(()=>vi.useRealTimers());
it('backs off 5/10/20/40/60 seconds and clears all scheduled work on disposal',async()=>{
  vi.useFakeTimers();const load=vi.fn(async()=>{throw new Error('offline');});
  const poller=createVisiblePoller({load,receive(){},error(){},clear(){},intervalMs:()=>60000});
  poller.setActive(true);await vi.advanceTimersByTimeAsync(0);expect(load).toHaveBeenCalledTimes(1);
  let n=1;for(const delay of [5000,10000,20000,40000,60000]){await vi.advanceTimersByTimeAsync(delay-1);expect(load).toHaveBeenCalledTimes(n);await vi.advanceTimersByTimeAsync(1);expect(load).toHaveBeenCalledTimes(++n);}
  poller.dispose();expect(vi.getTimerCount()).toBe(0);
});
it('times out slow RPC feedback, and hiding cancels the wait without stale delivery',async()=>{
  vi.useFakeTimers();const error=vi.fn(),receive=vi.fn();let resolve!:(n:number)=>void;
  const poller=createVisiblePoller({load:()=>new Promise<number>(r=>{resolve=r;}),receive,error,clear(){},intervalMs:()=>60000});
  poller.setActive(true);await vi.advanceTimersByTimeAsync(20000);expect(error).toHaveBeenCalledTimes(1);
  resolve(1);await vi.advanceTimersByTimeAsync(0);expect(receive).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000);poller.setActive(false);await vi.advanceTimersByTimeAsync(0);expect(vi.getTimerCount()).toBe(0);
  resolve(2);await vi.advanceTimersByTimeAsync(60000);expect(receive).not.toHaveBeenCalled();expect(error).toHaveBeenCalledTimes(1);poller.dispose();
});
