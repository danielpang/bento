import { useEffect, type RefObject } from "react";

/**
 * A phone keyboard is tall enough that anything shorter is the browser
 * chrome moving, not the keys. Lifting the sheet for the chrome would
 * jump a resting card to the top of the screen.
 */
export const KEYBOARD_INSET_MIN = 140;

const SHEET_MEDIA = "(max-width: 720px)";

export interface ViewportBox {
  innerHeight: number;
  offsetTop: number;
  height: number;
}

export interface SheetLift {
  bottom: number;
  height: number;
}

/**
 * Where a fixed sheet has to sit so its bottom edge is the top of the
 * keyboard. Null leaves the stylesheet's resting size alone.
 *
 * `bottom` is the distance from the layout viewport's bottom to the
 * visual viewport's bottom. `height` is the visual viewport, so the
 * sheet fills exactly the region above the keys.
 */
export function sheetLift(box: ViewportBox): SheetLift | null {
  if (box.height < 120) return null;
  const bottom = box.innerHeight - box.height - box.offsetTop;
  if (bottom < KEYBOARD_INSET_MIN) return null;
  return { bottom: Math.round(bottom), height: Math.round(box.height) };
}

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Whether a touch drag should be cancelled so it cannot scroll the page
 * behind a sheet.
 *
 * A drag that starts on a field is left alone: cancelling it blocks
 * caret placement and selection. A mostly horizontal drag is left alone
 * so a diff can still pan sideways. Everything else is cancelled unless
 * it is moving a scroller that still has room in that direction.
 */
export function shouldBlockSheetScroll(input: {
  inside: boolean;
  editable: boolean;
  lockOutside: boolean;
  deltaX: number;
  deltaY: number;
  scroller: ScrollMetrics | null;
}): boolean {
  if (input.editable) return false;
  if (Math.abs(input.deltaX) > Math.abs(input.deltaY)) return false;
  if (!input.inside) return input.lockOutside && input.deltaY !== 0;
  if (!input.scroller) return input.deltaY !== 0;
  const { scrollTop, clientHeight, scrollHeight } = input.scroller;
  const atTop = scrollTop <= 0;
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
  // Finger moving down scrolls toward the top.
  if (input.deltaY > 0 && atTop) return true;
  if (input.deltaY < 0 && atBottom) return true;
  return false;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

function isVerticalScroller(el: HTMLElement): boolean {
  const overflowY = getComputedStyle(el).overflowY;
  if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") return false;
  return el.scrollHeight > el.clientHeight + 1;
}

/** The nearest ancestor of `target`, up to `boundary`, that can scroll vertically. */
function findVerticalScroller(target: Node, boundary: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement;
  while (el) {
    if (isVerticalScroller(el)) return el;
    if (el === boundary) return null;
    el = el.parentElement;
  }
  return null;
}

function applyLift(el: HTMLElement, lift: SheetLift | null): void {
  if (!lift) {
    el.classList.remove("sheet-lifted");
    el.style.removeProperty("top");
    el.style.removeProperty("bottom");
    el.style.removeProperty("height");
    el.style.removeProperty("max-height");
    return;
  }
  el.classList.add("sheet-lifted");
  el.style.top = "auto";
  el.style.bottom = `${lift.bottom}px`;
  el.style.height = `${lift.height}px`;
  el.style.maxHeight = `${lift.height}px`;
}

/** Brings the composer into the sheet without scrolling the page behind it. */
function revealComposer(el: HTMLElement): void {
  const dock = el.querySelector(".composer-dock");
  if (!(dock instanceof HTMLElement)) return;
  const extra = dock.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
  if (extra > 1) el.scrollTop += extra + 8;
}

/**
 * Keeps a fixed drawer inside the visible region while it is open.
 *
 * Two phone bugs share this hook. A drag on the sheet was scrolling the
 * board behind it, because the sheet's own scroller had nothing to
 * consume once it hit an edge (or had no overflow at all). And focusing
 * the composer opened the keyboard over the field: the sheet is fixed
 * to the layout viewport, which does not shrink for the keys, so the
 * browser panned the page underneath instead of the sheet.
 */
export function useSheetLayer(panel: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia(SHEET_MEDIA);
    let frame = 0;

    const place = () => {
      const el = panel.current;
      if (!el) return;
      const fixed = getComputedStyle(el).position === "fixed";
      const viewport = window.visualViewport;
      const lift =
        fixed && viewport
          ? sheetLift({
              innerHeight: window.innerHeight,
              offsetTop: viewport.offsetTop,
              height: viewport.height,
            })
          : null;
      applyLift(el, lift);
      // Only while a field in the sheet is focused. A viewport change
      // is the keyboard moving; scrolling the transcript must not be
      // pulled back down afterwards.
      const focused = document.activeElement;
      if (lift && focused instanceof HTMLElement && el.contains(focused) && isEditableTarget(focused)) {
        revealComposer(el);
      }
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };

    const syncLock = () => {
      if (media.matches) root.setAttribute("data-sheet-open", "");
      else root.removeAttribute("data-sheet-open");
    };

    syncLock();
    schedule();

    let gesture: {
      startX: number;
      startY: number;
      inside: boolean;
      editable: boolean;
      scroller: HTMLElement | null;
    } | null = null;

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const el = panel.current;
      if (!touch || !el) {
        gesture = null;
        return;
      }
      const target = event.target;
      const inside = target instanceof Node && el.contains(target);
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        inside,
        editable: isEditableTarget(target),
        scroller: inside && target instanceof Node ? findVerticalScroller(target, el) : null,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || !gesture) return;
      const scroller = gesture.scroller;
      const block = shouldBlockSheetScroll({
        inside: gesture.inside,
        editable: gesture.editable,
        lockOutside: media.matches,
        deltaX: touch.clientX - gesture.startX,
        deltaY: touch.clientY - gesture.startY,
        scroller: scroller
          ? {
              scrollTop: scroller.scrollTop,
              clientHeight: scroller.clientHeight,
              scrollHeight: scroller.scrollHeight,
            }
          : null,
      });
      if (block) event.preventDefault();
    };

    const onTouchEnd = () => {
      gesture = null;
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
    document.addEventListener("touchcancel", onTouchEnd);
    media.addEventListener("change", syncLock);
    media.addEventListener("change", schedule);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);

    return () => {
      cancelAnimationFrame(frame);
      root.removeAttribute("data-sheet-open");
      const el = panel.current;
      if (el) applyLift(el, null);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
      media.removeEventListener("change", syncLock);
      media.removeEventListener("change", schedule);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [panel]);
}
