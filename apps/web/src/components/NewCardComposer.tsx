import * as Dialog from "@radix-ui/react-dialog";
import type { BentoClient } from "@bento/api-client";
import { SessionComposer, type RecentAgent } from "./SessionComposer.js";

/**
 * The board's new card, as the agent composer over the darkened board:
 * a message, an optional title, and the choice of adding the card to the
 * backlog or starting an agent on it now.
 */
export function NewCardComposer({
  client,
  projectId,
  recentProfile,
  onClose,
  onCreated,
  onStarted,
}: {
  client: BentoClient;
  projectId: string;
  recentProfile?: RecentAgent;
  onClose: () => void;
  onCreated: (featureId: string) => void;
  onStarted: (featureId: string) => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop new-card-backdrop" data-portal-layer="">
          <Dialog.Content
            className="new-card-composer"
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              document.getElementById("session-composer-message")?.focus();
            }}
          >
            <Dialog.Title className="visually-hidden">New card</Dialog.Title>
            <SessionComposer
              client={client}
              projectId={projectId}
              {...(recentProfile ? { recentProfile } : {})}
              onCancel={onClose}
              onStarted={onStarted}
              card={{ onCreated }}
            />
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
