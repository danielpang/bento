import { useEffect } from "react";
import { ToastHost, useToast } from "@bento/web";

/**
 * ToastHost renders nothing until something inside it reports. These
 * previews raise a message on mount so the card shows the thing the
 * component exists for.
 */
function Raise({ kind, text }: { kind: "fail" | "note"; text: string }) {
  const toast = useToast();
  useEffect(() => {
    toast[kind](text);
  }, [kind, text, toast]);
  return <p className="muted">The page underneath carries on; the message sits in the corner.</p>;
}

/** What a refused action looks like: the server's own sentence, in the corner. */
export function Failure() {
  return (
    <div style={{ position: "relative", height: 200, background: "var(--bg)" }}>
      <ToastHost>
        <Raise
          kind="fail"
          text="this agent has recorded runs, which keep their history; rename it instead of deleting it"
        />
      </ToastHost>
    </div>
  );
}

/** The quieter tone, for something that worked and is worth confirming. */
export function Confirmation() {
  return (
    <div style={{ position: "relative", height: 200, background: "var(--bg)" }}>
      <ToastHost>
        <Raise kind="note" text="Pipeline imported: 6 stages and 6 agents." />
      </ToastHost>
    </div>
  );
}
