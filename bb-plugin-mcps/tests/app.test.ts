// @vitest-environment jsdom
import { createElement } from 'react';
import { act, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';

const app = await loadPluginApp(() => import('../app'));
const panel = app.navPanels[0]!;
const rows = ['alpha', 'beta'].map(id => ({ id, handle: id, name: id, type: 'stdio', enabled: true, approved: true, status: 'ready', authStatus: 'not-applicable', configJson: '{}', sourceKind: 'manual' }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const catalog = (name: string, count = 1) => ({ tools: Array.from({length: count}, (_, i) => ({ opaqueId: `${name}-${i}`, name: `${name}-${i}`, risk: 'read', description: '' })), error: null });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(subPath: string, handlers: Record<string, (input: any) => any>) {
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const method = String(url).split('/').pop()!;
    return { ok: true, json: async () => ({ ok: true, result: await handlers[method]!(JSON.parse(init.body)) }) };
  }));
  return renderSlot(panel, { subPath }, { rpc: handlers });
}
it('does not replace beta tools with a late alpha inspection', async () => {
  const slow = deferred<ReturnType<typeof catalog>>();
  const slot = mount('installed/alpha', { snapshot: () => ({servers: rows}), inspectServer: ({id}) => id === 'alpha' ? slow.promise : catalog('beta') });
  await slot.findByText('alpha');
  slot.lifecycle.rerender(createElement(panel.component, {subPath: 'installed/beta'}));
  await slot.findByText('beta-0');
  await act(async () => { slow.resolve(catalog('alpha')); });
  expect(slot.queryByText('alpha-0')).toBeNull();
  expect(slot.queryByText('beta-0')).not.toBeNull();
});
it('bounds the rendered rows of a 500-tool catalog and exposes later pages', async () => {
  const slot = mount('installed/alpha', { snapshot: () => ({servers: rows}), inspectServer: () => catalog('tool', 500) });
  await slot.findByText('tool-0');
  expect(slot.container.querySelectorAll('li').length).toBeLessThanOrEqual(50);
  fireEvent.click(slot.getByRole('button', {name: 'Next tools'}));
  expect(slot.queryByText('tool-50')).not.toBeNull();
});

it('keeps the newest snapshot after out-of-order realtime refreshes and aborts old reads', async () => {
  const old = deferred<{servers: typeof rows}>(); let calls = 0;
  const slot = mount('', { snapshot: () => ++calls === 1 ? old.promise : {servers: [rows[1]]} });
  await slot.behavior.emitRealtime('mcps-changed', {});
  await slot.findByText('beta');
  const firstSignal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
  expect(firstSignal.aborted).toBe(true);
  await act(async () => old.resolve({servers: [rows[0]!]}));
  expect(slot.queryByText('alpha')).toBeNull();
});
it('discards a slow registry result when typing a newer query, then clearing', async () => {
  const old = deferred<{servers: unknown[]}>();
  const hit = (name: string) => ({name, description: '', remote: true, installable: true, requiredHeaders: []});
  const slot = mount('browse', {snapshot: () => ({servers: []}), registrySearch: ({query}) => query === 'old' ? old.promise : {servers: [hit('new-result')], nextCursor: null}});
  const input = slot.getByRole('textbox', {name: 'Search the MCP Registry'});
  fireEvent.change(input, {target: {value: 'old'}});
  await act(async () => { await new Promise(r => setTimeout(r, 300)); });
  fireEvent.change(input, {target: {value: 'new'}});
  await slot.findByText('new-result');
  await act(async () => old.resolve({servers: [hit('old-result')]}));
  expect(slot.queryByText('old-result')).toBeNull();
  fireEvent.change(input, {target: {value: ''}});
  expect(slot.queryByText('new-result')).toBeNull();
});
it('paginates 60 installed servers without hiding matches on later pages', async () => {
  const servers = Array.from({length: 60}, (_, i) => ({...rows[0], id: `server-${i}`, name: `server-${i}`}));
  const slot = mount('', {snapshot: () => ({servers})});
  await slot.findByText('server-0');
  expect(slot.queryByText('server-59')).toBeNull();
  fireEvent.click(slot.getByRole('button', {name: 'Next servers'}));
  expect(slot.queryByText('server-59')).not.toBeNull();
  fireEvent.change(slot.getByRole('textbox', {name: 'Search MCPs'}), {target: {value: 'server-59'}});
  expect(slot.queryByText('server-59')).not.toBeNull();
});

it('opens existing handle links after stable IDs are introduced', async () => {
  const server = {...rows[0], id: 'mcp_1234567890', handle: 'alpha'};
  const slot = mount('installed/alpha', {snapshot: () => ({servers: [server]}), inspectServer: () => catalog('echo')});
  await slot.findByText('echo-0');
  expect(slot.getByText('@alpha').getAttribute('title')).toBe('mcp_1234567890');
  slot.lifecycle.rerender(createElement(panel.component, {subPath: 'installed/mcp_1234567890'}));
  await slot.findByText('echo-0');
  expect(slot.queryByText('That MCP is gone.')).toBeNull();
});
