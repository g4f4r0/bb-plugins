import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
const state = vi.hoisted(() => ({ call: vi.fn(), rpc: null as unknown, providers: {providers: []} }));
vi.mock('@get-bb/plugin-sdk/app', () => ({
  useRpc: () => state.rpc,
  experimental_useProviders: () => state.providers,
  experimental_ProviderIcon: () => null,
  experimental_Icon: () => null,
  definePluginApp: (setup: unknown) => setup,
}));
import { useFleetSnapshot } from '../hooks/use-fleet-snapshot';
import { ReservePopover } from '../app';
import type { UsageSnapshot } from '../server';
let visibility: DocumentVisibilityState = 'hidden';
let online = true;
let observers: IO[] = [];
class IO {
  constructor(private callback: IntersectionObserverCallback) { observers.push(this); }
  observe = vi.fn();
  disconnect = vi.fn();
  visible(visible: boolean) { this.callback([{isIntersecting:visible,intersectionRect:{width:visible?100:0,height:visible?100:0}} as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}
const snapshot = (count = 0): UsageSnapshot => ({fetchedAt:new Date().toISOString(),refreshIntervalMs:60000,hosts:[],unavailableHosts:0,totals:Array.from({length:count},(_,i)=>({key:`codex|${i}`,providerId:'codex',providerName:'Codex',accountEmail:`${i}@example.test`,planLabel:'Plus',windows:[{label:'Weekly',usedPercent:10,barPercent:10,resetsAt:null,cost:null}],remainingPercent:90,resetCredits:null}))});
function Harness() { const view=useFleetSnapshot();return <div ref={view.container}><button onClick={view.reload}>Reload</button><span data-testid="busy">{String(view.reloading)}</span><span data-testid="error">{view.error}</span></div>; }
async function flush() { await act(async()=>{await Promise.resolve();await Promise.resolve();}); }
beforeEach(()=>{
  vi.useFakeTimers();state.call.mockReset();state.rpc={call:state.call};observers=[];visibility='hidden';online=true;
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
  Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>online});
  vi.stubGlobal('IntersectionObserver',IO);
  vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} });
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:320,height:440,top:0,left:0,bottom:440,right:320,x:0,y:0,toJSON(){return {};}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
describe('visibility and transport lifecycle',()=>{
  it('does no RPC on hidden mount, intersection, or offline; disposes observer/listeners',async()=>{
    state.call.mockResolvedValue(snapshot());
    const view=render(<Harness/>);
    await act(async()=>{observers[0]!.visible(true);await vi.advanceTimersByTimeAsync(60000);});
    expect(state.call).not.toHaveBeenCalled();
    online=false;visibility='visible';act(()=>document.dispatchEvent(new Event('visibilitychange')));
    expect(state.call).not.toHaveBeenCalled();
    online=true;act(()=>window.dispatchEvent(new Event('online')));await flush();
    expect(state.call).toHaveBeenCalledTimes(1);
    view.unmount();expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
    await act(async()=>{window.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(300000);});
    expect(state.call).toHaveBeenCalledTimes(1);
  });
  it('shares a slow transport across rapid remounts and clears reload state',async()=>{
    let resolve!: (value:UsageSnapshot)=>void;
    state.call.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    visibility='visible';
    let view=render(<Harness/>);act(()=>observers.at(-1)!.visible(true));
    fireEvent.click(screen.getByText('Reload'));await flush();await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
    for(let i=0;i<20;i++){view.unmount();view=render(<Harness/>);act(()=>observers.at(-1)!.visible(true));fireEvent.click(screen.getByText('Reload'));}
    await flush();expect(state.call).toHaveBeenCalledTimes(1);
    resolve(snapshot());await flush();await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
    expect(state.call.mock.calls.length).toBeLessThanOrEqual(2);
    // Resolve a possible explicitly queued refresh, too.
    resolve(snapshot());await flush();expect(screen.getByTestId('busy').textContent).toBe('false');
    view.unmount();expect(vi.getTimerCount()).toBe(0);
  });
});
describe('render bounds and reset safety',()=>{
  it('handles zero logins',()=>{render(<ReservePopover snapshot={snapshot()} onReload={()=>{}} reloading={false}/>);expect(screen.getByText('No leftover windows to show.')).toBeTruthy();});
  it('virtualizes 1000 logins and one login with 1000 windows',()=>{
    const view=render(<ReservePopover snapshot={snapshot(1000)} onReload={()=>{}} reloading={false}/>);
    expect(view.container.querySelector('[data-reserve-virtual]')).toBeTruthy();
    expect(view.container.querySelectorAll('[data-reserve-row]').length).toBeLessThan(50);
    const huge=snapshot(1);huge.totals[0]!.windows=Array.from({length:1000},(_,i)=>({...huge.totals[0]!.windows[0]!,label:`Window ${i}`}));
    view.rerender(<ReservePopover snapshot={huge} onReload={()=>{}} reloading={false}/>);
    expect(view.container.querySelectorAll('[role="meter"]').length).toBeLessThan(50);
    view.unmount();expect(vi.getTimerCount()).toBe(0);
  });
  it('does not consume a reset when navigation happens during prepare',async()=>{
    let resolve!: (value:unknown)=>void;
    state.call.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    const data=snapshot(1);data.totals[0]!.resetCredits={availableCount:1};
    const view=render(<ReservePopover snapshot={data} onReload={()=>{}} reloading={false}/>);
    fireEvent.click(screen.getByText('Use reset'));fireEvent.click(screen.getByText('Confirm'));
    expect(state.call).toHaveBeenCalledTimes(1);view.unmount();
    resolve({outcome:'ready',confirmationToken:'test',availableCount:1,expiresAtMs:Date.now()+10000});await flush();
    expect(state.call).toHaveBeenCalledTimes(1);
  });
});
