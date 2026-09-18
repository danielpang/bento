import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Move one conversation between the drawer and the center pane.
 * Keeping the portal container stable preserves the draft, transcript,
 * and stream when the viewport or board filter changes. */
export function ConversationPlacement({ target, children }: { target?: HTMLElement | null; children: ReactNode }) {
  const inline = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    if (typeof document === "undefined") return null;
    const node = document.createElement("div");
    node.className = "feature-conversation";
    return node;
  });

  useLayoutEffect(() => {
    if (!host) return;
    const destination = target ?? inline.current;
    destination?.appendChild(host);
    return () => host.remove();
  }, [host, target]);

  return <div className="conversation-placement" ref={inline}>
    {host ? createPortal(children, host) : children}
  </div>;
}
