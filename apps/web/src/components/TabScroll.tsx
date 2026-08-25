import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * Which edges of a tab strip have more labels past them.
 *
 * The row scrolls instead of wrapping, so a clipped name is easy to
 * read as a truncated label. These edges drive a fade and a chevron so
 * the strip reads as a scroller rather than as a cut-off.
 */
function useScrollEdges(wrap: RefObject<HTMLDivElement | null>) {
  const [edges, setEdges] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const row = wrap.current?.querySelector<HTMLElement>(".tab-row");
    if (!row) return;

    const update = () => {
      const max = row.scrollWidth - row.clientWidth;
      setEdges({
        start: row.scrollLeft > 1,
        end: max - row.scrollLeft > 1,
      });
    };

    update();
    row.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(row);
    for (const child of row.children) resize.observe(child);
    // Tabs appear after mount (Billing, once the plan endpoint answers),
    // which changes scrollWidth without resizing the row itself.
    const mutate = new MutationObserver(() => {
      update();
      for (const child of row.children) resize.observe(child);
    });
    mutate.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      row.removeEventListener("scroll", update);
      resize.disconnect();
      mutate.disconnect();
    };
  }, [wrap]);

  return edges;
}

function scrollRow(row: HTMLElement, direction: 1 | -1) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  row.scrollBy({
    left: direction * Math.max(120, row.clientWidth * 0.7),
    behavior: reduce ? "auto" : "smooth",
  });
}

function revealTab(row: HTMLElement, active?: string) {
  const selected =
    (active
      ? row.querySelector<HTMLElement>(`[data-tab="${CSS.escape(active)}"]`)
      : null) ??
    row.querySelector<HTMLElement>('[data-state="active"]') ??
    row.querySelector<HTMLElement>(".tab-on");
  if (!selected) return;
  // Center the live tab in the strip so a phone opening Billing sees
  // the underlined label, not a sliver under the fade or nothing.
  const rowRect = row.getBoundingClientRect();
  const selRect = selected.getBoundingClientRect();
  const left = selRect.left - rowRect.left + row.scrollLeft;
  const target = left - (row.clientWidth - selRect.width) / 2;
  row.scrollTo({ left: Math.max(0, target), behavior: "auto" });
}

/**
 * Fade and chevron on a `.tab-row` that overflows, so a phone-sized
 * strip reads as a scroller rather than as the whole set.
 *
 * The live tab is scrolled into the row when it would otherwise sit
 * past the fold (a deep link to Account, a newly selected label under
 * the fade). The chevrons themselves advance the row, because a cue
 * that looks tappable and then ignores the tap reads as broken.
 */
export function TabScroll({
  children,
  active,
}: {
  children: ReactNode;
  /** The live tab's id; bringing it on-screen is the point. */
  active?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const { start, end } = useScrollEdges(wrap);

  useLayoutEffect(() => {
    const row = wrap.current?.querySelector<HTMLElement>(".tab-row");
    if (!row || active === undefined) return;
    const run = () => revealTab(row, active);
    run();
    // Billing (and Account) can join the strip after mount, once the
    // plan endpoint answers. Reveal again when that happens, not only
    // when the active id changes.
    const id = requestAnimationFrame(run);
    const mutate = new MutationObserver(run);
    mutate.observe(row, { childList: true });
    return () => {
      cancelAnimationFrame(id);
      mutate.disconnect();
    };
  }, [active]);

  function nudge(direction: 1 | -1) {
    const row = wrap.current?.querySelector<HTMLElement>(".tab-row");
    if (row) scrollRow(row, direction);
  }

  return (
    <div
      ref={wrap}
      className="tab-scroll"
      data-fade-start={start || undefined}
      data-fade-end={end || undefined}
    >
      {children}
      <button
        type="button"
        className="tab-scroll-cue tab-scroll-cue-start"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => nudge(-1)}
      />
      <button
        type="button"
        className="tab-scroll-cue tab-scroll-cue-end"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => nudge(1)}
      />
    </div>
  );
}
