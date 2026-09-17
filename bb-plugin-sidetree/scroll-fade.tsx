import { useLayoutEffect, useState, type RefObject } from "react";

export function overflowEdges(
  el: HTMLElement,
  previous = { above: false, below: false },
): { above: boolean; below: boolean } {
  return {
    above: el.scrollTop > (previous.above ? 0.5 : 2),
    below:
      el.scrollHeight - el.scrollTop - el.clientHeight >
      (previous.below ? 0.5 : 2),
  };
}

export function watchOverflowEdges(
  scroller: HTMLElement,
  onChange: (next: { above: boolean; below: boolean }) => void,
  extras: readonly Element[] = [],
): { disconnect: () => void; schedule: () => void } {
  let frame = 0;
  let prev = { above: false, below: false };
  const measure = () => {
    frame = 0;
    const next = overflowEdges(scroller, prev);
    if (prev.above === next.above && prev.below === next.below) return;
    prev = next;
    onChange(next);
  };
  const schedule = () => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(measure);
  };
  measure();
  scroller.addEventListener("scroll", schedule, { passive: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(scroller);
  for (const extra of extras) resize.observe(extra);
  return {
    schedule,
    disconnect() {
      if (frame !== 0) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      resize.disconnect();
    },
  };
}

export function useOverflowEdges(
  scroller: RefObject<HTMLElement | null>,
  content?: RefObject<HTMLElement | null>,
): { above: boolean; below: boolean } {
  const [edges, setEdges] = useState({ above: false, below: false });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const extra = content?.current;
    const watch = watchOverflowEdges(
      el,
      setEdges,
      extra == null ? [] : [extra],
    );
    return watch.disconnect;
  }, [content, scroller]);
  return edges;
}

export function ScrollEdgeFades({
  above,
  below,
  color,
}: {
  above: boolean;
  below: boolean;
  color: string;
}) {
  return (
    <>
      {
        <div
          aria-hidden
          data-detail-scroll-fade="above"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6"
          style={{
            opacity: above ? 1 : 0,
            backgroundImage: `linear-gradient(to bottom, ${color}, transparent)`,
          }}
        />
      }
      {
        <div
          aria-hidden
          data-detail-scroll-fade="below"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6"
          style={{
            opacity: below ? 1 : 0,
            backgroundImage: `linear-gradient(to top, ${color}, transparent)`,
          }}
        />
      }
    </>
  );
}
