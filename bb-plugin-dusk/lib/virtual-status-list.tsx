import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';

export interface StatusItem { key: string; height: number; threadId?: string; render(): ReactNode }

/** Keep shortcut targets, focused controls and the active thread mounted offscreen. */
export function VirtualStatusList({ items, activeThreadId }: { items: StatusItem[]; activeThreadId: string | null }) {
  const root = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [retained, setRetained] = useState<string | null>(null);
  useLayoutEffect(() => {
    let parent = root.current?.parentElement ?? null;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
    setScrollElement(parent);
  }, []);
  const keep = new Set<number>();
  let shortcuts = 0;
  items.forEach((item, index) => {
    if (item.threadId && shortcuts++ < 9 || item.threadId === activeThreadId || item.key === retained) keep.add(index);
  });
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    getItemKey: index => items[index].key,
    estimateSize: index => items[index].height,
    overscan: 6,
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...keep])].sort((a, b) => a - b),
  });
  const focusRow = useCallback((index: number) => {
    const item = items[index];
    if (!item) return;
    setRetained(item.key);
    virtual.scrollToIndex(index, { align: 'auto' });
  }, [items, virtual]);
  const pendingFocus = useRef(false);
  useLayoutEffect(() => {
    if (!pendingFocus.current || !retained) return;
    root.current?.querySelector<HTMLElement>(`[data-virtual-key="${CSS.escape(retained)}"] :is(a,button)`)?.focus({ preventScroll: true });
    pendingFocus.current = false;
  });
  // A collapsed section can remove the old scroll destination. Browser scroll
  // clamping plus the virtualizer's resize observer reconciles the new range.
  return <div ref={root} className="dusk-virtual-list" style={{ height: virtual.getTotalSize() }}
    onFocusCapture={event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-virtual-key]');
      if (row) setRetained(row.dataset.virtualKey!);
    }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setRetained(null); }}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!(event.target instanceof HTMLElement) || !event.target.matches('.dusk-status-link, .dusk-status-heading')) return;
      const key = event.target.closest<HTMLElement>('[data-virtual-key]')?.dataset.virtualKey;
      const index = items.findIndex(item => item.key === key);
      const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1)
        : event.key === 'ArrowUp' ? Math.max(0, index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); pendingFocus.current = true; focusRow(next);
    }}>
    {virtual.getVirtualItems().map(row => <div key={row.key} data-virtual-key={items[row.index].key}
      className="dusk-virtual-item" style={{ height: row.size, transform: `translateY(${row.start}px)` }}>
      {items[row.index].render()}
    </div>)}
  </div>;
}
