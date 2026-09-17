// @vitest-environment node
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const processMock=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:processMock.spawn}));
import { readCodexCliEnrichment } from '../lib/codex-reset-credits';
class Child extends EventEmitter {
  stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();exitCode:number|null=null;signalCode:string|null=null;
  kill=vi.fn((signal:string)=>{this.signalCode=signal;this.emit('close',null,signal);return true;});
}
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks();});
it('abort disposes probe deadline, line reader, stdout listener and process handlers',async()=>{
  vi.useFakeTimers();const child=new Child();processMock.spawn.mockReturnValue(child);const controller=new AbortController();
  const request=readCodexCliEnrichment(controller.signal);const rejected=expect(request).rejects.toThrow(/cancelled/);
  controller.abort();await rejected;
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');expect(child.stdout.listenerCount('data')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);expect(child.stdin.listenerCount('error')).toBe(0);
  await vi.advanceTimersByTimeAsync(250);expect(child.kill).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});
it('bounds a noisy process with no newline to two MiB',async()=>{
  const child=new Child();processMock.spawn.mockReturnValue(child);const pending=readCodexCliEnrichment();const rejected=expect(pending).rejects.toThrow(/2 MiB/);
  child.stdout.write(Buffer.alloc(2*1024*1024+1,120));await rejected;expect(child.kill).toHaveBeenCalledTimes(1);
});
it('does not spawn for an already aborted generation',async()=>{
  const controller=new AbortController();controller.abort();await expect(readCodexCliEnrichment(controller.signal)).rejects.toThrow(/cancelled/);expect(processMock.spawn).not.toHaveBeenCalled();
});
it('escalates unresponsive processes and clears the force-kill timer on close',async()=>{
  vi.useFakeTimers();const child=new Child();child.kill.mockImplementation(()=>true);processMock.spawn.mockReturnValue(child);
  const request=readCodexCliEnrichment();const rejected=expect(request).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(3000);await rejected;expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(250);expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  child.emit('close',null,'SIGKILL');expect(vi.getTimerCount()).toBe(0);
});
