import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * A labelled region around a wide table. It is a tab stop only while its content overflows,
 * so a keyboard user can scroll it, and a table that fits adds no empty stop.
 */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScrollable(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <section ref={ref} className="table-scroll" aria-label={label} tabIndex={scrollable ? 0 : undefined}>
      {children}
    </section>
  );
}
