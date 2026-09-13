import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * How many dialogs are currently pinning the overlay to the visible
 * viewport. Nested confirms (remove, while an editor is open) must not
 * clear the variables the parent still needs.
 */
let visualViewportLocks = 0;
let stopVisualViewport: (() => void) | null = null;

/**
 * Size and place the overlay in the pixels the user can actually see.
 *
 * On a phone the layout viewport stays tall when the keyboard opens;
 * only visualViewport shrinks. A panel sized to 100dvh then keeps Save
 * behind the keyboard, and scrolling the fields cannot reveal a footer
 * that is pinned to that taller box. These variables are what the
 * backdrop and the max-height read.
 */
function lockVisualViewport(): () => void {
  if (visualViewportLocks === 0) {
    const root = document.documentElement.style;
    const apply = () => {
      const vv = window.visualViewport;
      // The smallest reported height is the one the user can see.
      // After the keyboard drops, visualViewport can stay on the large
      // viewport while the URL bar is back, and a panel sized to that
      // keeps Save under the chrome.
      const heights = [vv?.height, window.innerHeight, document.documentElement.clientHeight].filter(
        (n): n is number => typeof n === "number" && n > 0,
      );
      root.setProperty("--visual-viewport-height", `${Math.min(...heights)}px`);
      root.setProperty("--visual-viewport-offset-top", `${vv?.offsetTop ?? 0}px`);
    };
    apply();
    window.visualViewport?.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    stopVisualViewport = () => {
      window.visualViewport?.removeEventListener("resize", apply);
      window.visualViewport?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      root.removeProperty("--visual-viewport-height");
      root.removeProperty("--visual-viewport-offset-top");
    };
  }
  visualViewportLocks += 1;
  return () => {
    visualViewportLocks -= 1;
    if (visualViewportLocks === 0) {
      stopVisualViewport?.();
      stopVisualViewport = null;
    }
  };
}

/**
 * A dialog in Bento's own chrome, replacing the browser's prompt,
 * confirm, and alert.
 *
 * Those cannot be styled, appear detached from the app, and block the
 * whole tab while they are open, so a board that streams its own
 * updates stops updating mid decision. They also cannot hold two
 * fields, which is why creating a project used to take two prompts in
 * a row with no way back from the second.
 *
 * Behaviour comes from Radix rather than from this file. The hand
 * rolled version got Escape, the backdrop, and focus-on-open right,
 * but never trapped focus: Tab past the last button walked into the
 * board behind and then the browser's own toolbar, with the dialog
 * still open. It also left the page readable to a screen reader and
 * scrollable underneath. Those are the parts that are tedious to write
 * and easy to get subtly wrong, so they are no longer written here.
 *
 * Every dialog in the console composes this one (PromptDialog.tsx), so
 * this is the only place that had to change.
 *
 * Content sits inside Overlay rather than beside it, which Radix
 * supports and `.modal-backdrop` depends on: the backdrop is the
 * flex container that centres the panel, so as siblings the panel
 * would land in the top left corner.
 *
 * Opening focuses the panel, not the first field. Radix would focus
 * the first focusable control, and on iPadOS a focused <select> opens
 * its picker: editing an agent opened the Tool wheel over the form
 * before anyone had asked for it. A dialog that wants a field focused
 * asks for it with `autoFocus`, which React applies before Radix looks,
 * so Radix leaves that choice alone.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  actions,
  wide,
  large,
  expanded,
  headerActions,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  actions: ReactNode;
  /** For content, not forms: the artifact viewer's page-shaped panel. */
  wide?: boolean;
  /**
   * For long forms: the agent and stage editors, which stack more
   * fields than a confirm dialog and need the room on a desktop.
   */
  large?: boolean;
  /** Fill the viewport. The artifact viewer uses this as "larger view". */
  expanded?: boolean;
  /** Icon controls on the title row, top right. */
  headerActions?: ReactNode;
}) {
  /**
   * Put the cursor back where it came from.
   *
   * Radix returns focus to its own Dialog.Trigger, and there is no
   * trigger here: every caller renders this conditionally, so closing
   * unmounts the whole dialog in one update rather than letting Radix
   * close it. Measured without this, focus landed on <body> after both
   * Escape and Cancel, which loses a keyboard user's place on the page.
   *
   * The frame delay lets Radix's own focus handling finish first,
   * otherwise it runs after this and lands back on nothing.
   */
  const returnFocus = useRef<Element | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement;
    return () => {
      const target = returnFocus.current as HTMLElement | null;
      if (target?.isConnected) requestAnimationFrame(() => target.focus());
    };
  }, []);
  useEffect(() => lockVisualViewport(), []);

  /**
   * A growing textarea swallows the swipe. Overflow hidden (while it
   * is still growing) does not pass the gesture to the dialog, and
   * Radix's scroll lock will not scroll the page behind it. The
   * dialog itself has to take the leftover movement, or Save stays
   * below the fold after the keyboard is put away.
   */
  useEffect(() => {
    const root = panel.current;
    if (!root) return;

    const fieldFrom = (target: EventTarget | null): HTMLTextAreaElement | null =>
      target instanceof Element ? target.closest("textarea") : null;

    const handOff = (field: HTMLTextAreaElement, deltaY: number): boolean => {
      const can = field.scrollHeight > field.clientHeight + 1;
      const atTop = field.scrollTop <= 0;
      const atBottom = field.scrollTop + field.clientHeight >= field.scrollHeight - 1;
      if (can && ((deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom))) return false;
      root.scrollTop += deltaY;
      return true;
    };

    const onWheel = (event: WheelEvent) => {
      const field = fieldFrom(event.target);
      if (!field) return;
      if (handOff(field, event.deltaY)) event.preventDefault();
    };

    let lastY = 0;
    const onTouchStart = (event: TouchEvent) => {
      lastY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const field = fieldFrom(event.target);
      if (!field) return;
      const y = event.touches[0]?.clientY ?? lastY;
      const deltaY = lastY - y;
      lastY = y;
      if (deltaY !== 0 && handOff(field, deltaY)) event.preventDefault();
    };

    const revealActions = () => {
      const actions = root.querySelector(".modal-actions");
      if (!(actions instanceof HTMLElement)) return;
      const box = actions.getBoundingClientRect();
      const top = window.visualViewport?.offsetTop ?? 0;
      const bottom = top + (window.visualViewport?.height ?? window.innerHeight);
      if (box.bottom > bottom - 4 || box.top < top + 4) {
        actions.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    window.visualViewport?.addEventListener("resize", revealActions);
    window.addEventListener("resize", revealActions);
    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      window.visualViewport?.removeEventListener("resize", revealActions);
      window.removeEventListener("resize", revealActions);
    };
  }, []);

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        {/* The marker goes on the backdrop, not the panel: Content is
            nested inside Overlay here, so this covers both, and a press
            on the dialog's own backdrop then dismisses the dialog
            without also dismissing the drawer that opened it. */}
        <Dialog.Overlay className="modal-backdrop" data-portal-layer="">
          <Dialog.Content
            className={["modal", wide && "modal-wide", large && "modal-large", expanded && "modal-expanded"].filter(Boolean).join(" ")}
            ref={panel}
            // The panel itself, so the focus trap still has focus
            // inside it: preventing this without moving focus leaves it
            // on whatever opened the dialog, out in the page behind.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              panel.current?.focus({ preventScroll: true });
            }}
            // Radix warns when a dialog carries no description. Most of
            // these genuinely have nothing to add beyond the title, and
            // this is how Radix documents saying so. Inventing a hidden
            // paragraph to silence the warning would put the title
            // through a screen reader twice.
            {...(description ? {} : { "aria-describedby": undefined })}
          >
            {headerActions ? (
              <div className="modal-head">
                <div className="modal-head-copy">
                  <Dialog.Title className="modal-title" title={title}>
                    {title}
                  </Dialog.Title>
                  {description && <Dialog.Description className="muted">{description}</Dialog.Description>}
                </div>
                <div className="modal-head-actions">{headerActions}</div>
              </div>
            ) : (
              <>
                <Dialog.Title className="modal-title">{title}</Dialog.Title>
                {description && <Dialog.Description className="muted">{description}</Dialog.Description>}
              </>
            )}
            {/*
              The panel itself is the scroller. A nested body left Save
              pinned to a box taller than the visible phone screen, and
              swiping the skill could not move that footer. Actions sit
              in the same flow so a swipe down reaches them.
            */}
            {children ? <div className="modal-body">{children}</div> : null}
            <div className="modal-actions">{actions}</div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
