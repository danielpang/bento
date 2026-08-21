import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, type ReactNode } from "react";

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
            {children}
            <div className="modal-actions">{actions}</div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
