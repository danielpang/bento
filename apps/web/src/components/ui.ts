import { useEffect, useRef, type RefObject } from "react";
import { forgetsBetweenRuns, hasNoLiveTranscript, reportsCost } from "@bento/core";

/**
 * Escape closes the drawer, matching the Modal's behavior. The drawers
 * previously offered only the Close button, which the Modal's own
 * comment wrongly claimed was already handled.
 */
export function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/**
 * A panel that closes on Escape or on a click outside it, returning the
 * ref to put on the panel element.
 *
 * Both gestures, because a drawer that can only be dismissed by finding
 * its Close button traps attention: the board is right there and
 * clicking it should mean "I am done here". Mousedown rather than
 * click, so the panel is gone before the press lands on whatever was
 * behind it and opening another card stays one gesture.
 *
 * Dialogs opened from inside a drawer are exempt, and cannot be
 * recognised by containment: they are rendered into a portal at the
 * document root, so a click inside one is not inside the drawer that
 * opened it. They mark themselves with `data-portal-layer` instead.
 *
 * This is a real bug that shipped. When the dialog rendered inline,
 * `contains` answered correctly and no marker was needed. Moving it to
 * a portal made every click inside the agent editor read as a click
 * outside the panel behind it, so touching any field closed the panel
 * and dropped you back on the board.
 *
 * The handler is read through a ref so the listeners bind once. Keyed
 * on the callback they rebind every render, which is how a focus
 * effect elsewhere in this app once stole the cursor on every
 * keystroke.
 */
/** True for anything inside a dialog or menu rendered in a portal. */
function inPortalLayer(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest("[data-portal-layer]") !== null;
}

export function useDismissable<T extends HTMLElement>(onClose: () => void): RefObject<T | null> {
  const panel = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The topmost layer answers Escape, and this asks whether one is
      // open by looking at the document. That only works from the
      // capture phase: React flushes a discrete event synchronously, so
      // a listener running after the dialog's own would find it already
      // unmounted and close the panel behind it too.
      if (document.querySelector("[data-portal-layer]")) return;
      closeRef.current();
    };
    const onDown = (e: MouseEvent) => {
      const el = panel.current;
      if (!el || el.contains(e.target as Node) || inPortalLayer(e.target)) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  return panel;
}

/** Human names for gate criterion types; raw tokens read as debug output. */
/**
 * One name per requirement, used both where they are chosen and where
 * their verdicts are read. Two vocabularies for one concept meant you
 * configured "The agent finished" and were later told "Agent run"
 * passed, with nothing saying they were the same thing.
 */
export const CRITERION_NAMES: Record<string, string> = {
  manual: "A person approves",
  run_succeeded: "The agent finished",
  agent_judge: "An agent verifies the work is complete",
  command: "A command succeeds",
  checks_pass: "GitHub checks pass",
  pr_comments_resolved: "No unresolved review comments",
};

/**
 * Names a requirement, including ones this build does not know. The
 * raw token was leaking onto the card whenever a newer server sent a
 * type this client predates.
 */
export function criterionName(type: string): string {
  return CRITERION_NAMES[type] ?? "A requirement this version does not recognize";
}

/**
 * Tools that hold a live stdin conversation, and what a mid-task
 * message means there. Mirrors the adapters' live capability: pi
 * steers the working agent; Claude Code queues behind the current
 * turn. Anything absent takes messages between runs.
 */
export const LIVE_TOOLS: Record<string, "steer" | "queue" | undefined> = {
  pi: "steer",
  "claude-code": "queue",
};

/** Tools whose upstream interface is explicitly unstable. */
export const PREVIEW_TOOLS: Record<string, true | undefined> = { dsh: true };

export function toolCapability(cli: string): string {
  const output = hasNoLiveTranscript(cli) ? "Prints nothing until the run ends." : "Streams as it works.";
  const delivery = LIVE_TOOLS[cli]
    ? LIVE_TOOLS[cli] === "steer"
      ? "Messages steer it while it works."
      : "Messages queue behind the current step, in the same conversation."
    : forgetsBetweenRuns(cli)
      ? "Messages are delivered when the run ends, as a new run."
      : "Messages are delivered when the run ends, resuming the same session.";
  return `${output} ${delivery} ${reportsCost(cli) ? "Reports what a run cost." : "Cost is not reported."}`;
}
