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
  // No scroller of our own: the board stays put. A dialog portaled out
  // of the sheet passes its own scroller and is handled below.
  if (!input.scroller) {
    if (input.inside) return input.deltaY !== 0;
    return input.lockOutside && input.deltaY !== 0;
  }
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

function hasRoom(el: HTMLElement, deltaY: number): boolean {
  if (deltaY === 0) return false;
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  if (deltaY > 0 && atTop) return false;
  if (deltaY < 0 && atBottom) return false;
  return true;
}

/**
 * The scroller a drag should move, or null when the finger started
 * outside `boundary`.
 *
 * The nearest overflowing box wins while it still has room. Once it is
 * at that edge, the search continues outward, stopping at `boundary`,
 * so a diff inside a form does not trap the rest of the sheet and a
 * drag on the board cannot borrow a scroller behind the sheet. The
 * last overflowing box is returned when every one of them is at its
 * edge, which is what tells the guard to cancel the drag.
 */
export function nearestVerticalScroller<T>(input: {
  start: T | null;
  boundary: T;
  deltaY: number;
  parent: (node: T) => T | null;
  canScroll: (node: T) => boolean;
  hasRoom: (node: T, deltaY: number) => boolean;
}): T | null {
  const { start, boundary, deltaY, parent, canScroll, hasRoom: room } = input;
  if (!start || !insideBoundary(boundary, start, parent)) return null;
  let el: T | null = start;
  let edge: T | null = null;
  while (el) {
    if (canScroll(el)) {
      edge = el;
      if (room(el, deltaY)) return el;
    }
    if (el === boundary) break;
    el = parent(el);
  }
  return edge;
}

function insideBoundary<T>(boundary: T, node: T, parent: (node: T) => T | null): boolean {
  let el: T | null = node;
  while (el) {
    if (el === boundary) return true;
    el = parent(el);
  }
  return false;
}

function findVerticalScroller(target: Node, boundary: HTMLElement, deltaY: number): HTMLElement | null {
  const start = target instanceof HTMLElement ? target : target.parentElement;
  return nearestVerticalScroller({
    start,
    boundary,
    deltaY,
    parent: (node) => node.parentElement,
    canScroll: isVerticalScroller,
    hasRoom,
  });
}

/** A dialog or menu rendered outside the sheet, or the sheet itself. */
function gestureBoundary(target: EventTarget | null, sheet: HTMLElement): HTMLElement {
  if (target instanceof Element) {
    const portal = target.closest("[data-portal-layer]");
    if (portal instanceof HTMLElement) return portal;
  }
  return sheet;
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

/**
 * A dialog is centered on the layout viewport, which the keyboard does
 * not shrink, so the bottom of a tall form sits under the keys. Pin
 * the backdrop to the visible region. The stylesheet then caps the
 * dialog at that height and the form scrolls inside it.
 */
function fitBackdrops(lift: SheetLift | null, offsetTop: number): void {
  const root = document.documentElement;
  const nodes = document.querySelectorAll<HTMLElement>(".modal-backdrop");
  if (!lift) {
    root.removeAttribute("data-keyboard");
    for (const node of nodes) {
      node.style.removeProperty("top");
      node.style.removeProperty("height");
      node.style.removeProperty("bottom");
    }
    return;
  }
  root.setAttribute("data-keyboard", "");
  const top = Math.max(0, Math.round(offsetTop));
  for (const node of nodes) {
    node.style.top = `${top}px`;
    node.style.bottom = "auto";
    node.style.height = `${lift.height}px`;
  }
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
      const offsetTop = viewport?.offsetTop ?? 0;
      const lift = viewport
        ? sheetLift({
            innerHeight: window.innerHeight,
            offsetTop,
            height: viewport.height,
          })
        : null;
      // A side panel on a wide screen has no keyboard to clear.
      applyLift(el, fixed ? lift : null);
      fitBackdrops(media.matches ? lift : null, offsetTop);
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
      boundary: HTMLElement;
      target: Node;
    } | null = null;

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const el = panel.current;
      if (!touch || !el || !(event.target instanceof Node)) {
        gesture = null;
        return;
      }
      const boundary = gestureBoundary(event.target, el);
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        inside: boundary === el && el.contains(event.target),
        editable: isEditableTarget(event.target),
        boundary,
        target: event.target,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || !gesture) return;
      const deltaY = touch.clientY - gesture.startY;
      const scroller = findVerticalScroller(gesture.target, gesture.boundary, deltaY);
      const block = shouldBlockSheetScroll({
        inside: gesture.inside,
        editable: gesture.editable,
        lockOutside: media.matches,
        deltaX: touch.clientX - gesture.startX,
        deltaY,
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
    document.addEventListener("focusin", schedule);
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
      fitBackdrops(null, 0);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
      document.removeEventListener("focusin", schedule);
      media.removeEventListener("change", syncLock);
      media.removeEventListener("change", schedule);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [panel]);
}
