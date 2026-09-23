import { observeRoots } from "./observe-roots";
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { experimental_useSidebarThreads, experimental_useSidebarThreadActions, experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

let nextMountKey = 0;
type Mount = { key: number; id: string; link: HTMLElement; row: HTMLElement; meta: HTMLElement; pin: HTMLElement | null; pinClass: string; nativeMeta?: HTMLElement };
export function relativeMessageTime(at: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function PinAction({ id, pinned, className }: { id: string; pinned: boolean; className: string }) {
  const actions = experimental_useSidebarThreadActions();
  const [busy, setBusy] = useState(false);
  return <TooltipProvider><Tooltip disableHoverableContent><TooltipTrigger asChild><Button variant="ghost" size="icon" className={className} aria-label={pinned ? 'Unpin thread' : 'Pin thread'} aria-pressed={pinned} disabled={busy}
    onPointerDown={e => e.stopPropagation()} onClick={async e => {
      e.preventDefault(); e.stopPropagation(); if (busy) return;
      setBusy(true);
      try { await actions.setPinned(id, !pinned); }
      catch { toast.error('Could not update the pin. Try again.'); }
      finally { setBusy(false); }
    }}><Icon name={pinned ? 'PinOff' : 'Pin'} className="size-4" aria-hidden /></Button></TooltipTrigger><TooltipContent side="bottom">{pinned ? 'Unpin' : 'Pin'}</TooltipContent></Tooltip></TooltipProvider>;
}

export function SidebarDetails() {
  const { threads } = experimental_useSidebarThreads();
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [now, setNow] = useState(Date.now);
  useLayoutEffect(() => {
    const entries = new Map<HTMLElement, Mount>();
    const knownIds = new Set(threads.map(t => t.id));
    const dispose = (m: Mount) => { m.meta.remove(); m.pin?.remove(); m.row.removeAttribute('data-dusk-thread-row'); m.nativeMeta?.removeAttribute('data-dusk-native-meta'); };
    const sync = () => {
      let changed = false; const found = new Set<HTMLElement>();
      document.querySelectorAll<HTMLElement>('[data-sidebar="sidebar"] a[data-sidebar-thread-id]').forEach(link => {
        // BB nests the link in the row's title span; the row owns the controls.
        const row = link.closest<HTMLElement>('[data-sidebar-rename-row]'), id = link.dataset.sidebarThreadId;
        if (!row || !id || !row.querySelector('.bb-thread-title')) return;
        found.add(link);
        const controls = row.querySelector<HTMLElement>('[data-sidebar-row-controls]');
        const old = entries.get(link);
        if (old && old.id === id && old.meta.parentElement === row && (old.pin?.parentElement ?? null) === controls) return;
        if (old) dispose(old);
        const meta = document.createElement('span'); meta.className = 'dusk-thread-meta';
        row.setAttribute('data-dusk-thread-row', ''); row.append(meta);
        let pin: HTMLElement | null = null;
        const pinClass = controls?.querySelector('button')?.className || 'size-7 p-0';
        if (controls) { pin = document.createElement('span'); pin.className = 'dusk-pin-slot'; controls.prepend(pin); }
        entries.set(link, { key: ++nextMountKey, id, link, row, meta, pin, pinClass }); changed = true;
      });
      document.querySelectorAll<HTMLElement>('[data-root-compose-mobile-recents] a[href]').forEach(link => {
        const id = link.getAttribute('href')?.match(/\/threads\/(thr_[^/?#]+)/)?.[1];
        const row = link.parentElement;
        const text = link.querySelector<HTMLElement>(':scope > span.min-w-0');
        const nativeMeta = text?.querySelector<HTMLElement>(':scope > span:nth-child(2):not(.dusk-thread-meta)');
        if (!id || !row || !text || !nativeMeta || !knownIds.has(id)) return;
        found.add(link);
        const old = entries.get(link);
        if (old && old.meta.parentElement === text && old.nativeMeta === nativeMeta) return;
        if (old) dispose(old);
        const meta = document.createElement('span'); meta.className = 'dusk-thread-meta';
        nativeMeta.setAttribute('data-dusk-native-meta', ''); text.append(meta);
        entries.set(link, { key: ++nextMountKey, id, link, row, meta, nativeMeta, pin: null, pinClass: '' }); changed = true;
      });
      for (const [link, entry] of entries) if (!found.has(link)) { dispose(entry); entries.delete(link); changed = true; }
      if (changed) setMounts([...entries.values()]);
    };
    const roots = '[data-sidebar="sidebar"], [data-root-compose-mobile-recents], #root-compose-prompt';
    let stopObserving = observeRoots(roots, sync);
    const homepageReady = () => { stopObserving(); stopObserving = observeRoots(roots, sync); sync(); };
    window.addEventListener('dusk:homepage-ready', homepageReady);
    sync();
    return () => { window.removeEventListener('dusk:homepage-ready', homepageReady); stopObserving(); entries.forEach(dispose); };
  }, [threads.map(t => t.id).sort().join(',')]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, []);
  const byId = new Map(threads.map(t => [t.id, t]));
  return <>{mounts.map(m => {
    const thread = byId.get(m.id); if (!thread) return null;
    const branch = thread.environment?.branchName;
    const location = branch || thread.environment?.name || thread.host?.name;
    const at = Math.max(thread.updatedAt, thread.latestAttentionAt);
    return <span key={m.key} style={{ display: 'contents' }}>
      {createPortal(<>{location && <><span className="dusk-thread-loc-icon" aria-hidden><Icon name={branch ? 'GitBranch' : thread.environment?.name ? 'Folder' : 'Laptop'} className="size-3" /></span><span className="dusk-thread-location" title={location}>{location}</span></>}
        {location && <span className="dusk-thread-sep" aria-hidden>·</span>}
        <time dateTime={new Date(at).toISOString()} title={`Last update: ${new Date(at).toLocaleString()}`}>{relativeMessageTime(at, now)}</time>
      </>, m.meta)}
      {m.pin && createPortal(<PinAction id={m.id} pinned={thread.isPinned} className={m.pinClass} />, m.pin)}
    </span>;
  })}</>;
}
