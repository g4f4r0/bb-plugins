import { Fragment, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface DisplayRow { key: string; content: ReactNode }

/** Variable height rows: measurement follows wrapping, theme/font and width changes. */
function VirtualRows({ rows, active }: { rows: readonly DisplayRow[]; active: boolean }) {
  const parent = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    getItemKey,
    estimateSize: () => 80,
    overscan: 3,
    enabled: active,
    // Use scrollend where supported; the fallback timer is disposed by the library.
    useScrollendEvent: true,
  });
  useEffect(() => {
    const keys = new Set(rows.map((row) => row.key));
    if ([...virtualizer.itemSizeCache.keys()].some((key) => !keys.has(String(key)))) virtualizer.measure();
  }, [rows, virtualizer]);
  const measure = useCallback((node: HTMLDivElement | null) => {
    virtualizer.measureElement(node);
    const key = node ? rows[Number(node.dataset.index)]?.key : undefined;
    const cache = virtualizer.itemSizeCache;
    if (key !== undefined && cache.has(key)) {
      const size = cache.get(key)!;
      cache.delete(key);
      cache.set(key, size);
    }
    // Keep recently visited measurements. Positional bookkeeping is O(rows),
    // but never retain unbounded historical row identities across refreshes.
    while (cache.size > 256) cache.delete(cache.keys().next().value!);
  }, [rows, virtualizer]);
  return (
    <div ref={parent} data-reserve-virtual tabIndex={0} role="region" aria-label="Usage details" style={{ height: 'min(40dvh, 240px)', overflowY: 'auto', overflowX: 'hidden', overflowAnchor: 'none' }}>
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div key={item.key} ref={measure} data-index={item.index} data-reserve-row style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>
            {rows[item.index]!.content}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DisplayRows({ rows, active = true }: { rows: readonly DisplayRow[]; active?: boolean }) {
  return rows.length > 50
    ? <VirtualRows rows={rows} active={active} />
    : <>{rows.map((row) => <Fragment key={row.key}>{row.content}</Fragment>)}</>;
}
