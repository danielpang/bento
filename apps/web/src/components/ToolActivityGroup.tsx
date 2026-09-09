import { useEffect, useState } from "react";
import { toolDetail, type ToolActivity } from "../tool-activity.js";

/** Native disclosure controls work with a mouse, keyboard, and screen readers. */
export function ToolActivityGroup({ calls, showDetail }: { calls: ToolActivity[]; showDetail: boolean }) {
  const [open, setOpen] = useState(showDetail);
  useEffect(() => setOpen(showDetail), [showDetail]);
  const active = calls.some((call) => call.phase === "start" && !call.stopped);
  const failed = calls.filter((call) => call.failed).length;
  return (
    <div className="chat-row chat-row-tools">
      <details
        className="chat-tools chat-tool-group"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="chat-tool-group-summary">
          <span>{active ? "Tool calling…" : "Tool calls"}</span>
          <span className="chat-tool-count">
            {calls.length} {calls.length === 1 ? "call" : "calls"}
          </span>
          {failed > 0 && <span className="chat-tool-failed">{failed} failed</span>}
        </summary>
        {open && (
          <div className="chat-tool-list">
            {calls.map((call, index) => (
              <ToolCallDetail key={call.key ?? index} call={call} />
            ))}
          </div>
        )}
      </details>
    </div>
  );
}

function ToolCallDetail({ call }: { call: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const state = call.failed
    ? "Failed"
    : call.phase === "end"
      ? "Completed"
      : call.stopped
        ? "Result not recorded"
        : "Running…";
  async function copy() {
    try {
      await navigator.clipboard.writeText(toolDetail(call));
      setFeedback("Copied.");
    } catch {
      setFeedback("Could not copy. Select the text to copy it manually.");
    }
  }
  return (
    <details className="chat-tool-call" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="chat-tool-call-summary">
        <span className="chat-tool-action">{call.summary}</span>
        <span className={call.failed ? "chat-tool-failed" : "chat-tool-state"}>{state}</span>
      </summary>
      {open && (
        <div className="chat-tool-output">
          {call.input && (
            <section aria-label="Tool input">
              <h4>Input</h4>
              <pre>{call.input}</pre>
            </section>
          )}
          {call.output && (
            <section aria-label="Tool output">
              <h4>Output</h4>
              <pre>{call.output}</pre>
            </section>
          )}
          {!call.input && !call.output && <p>This agent did not record inputs or output for this call.</p>}
          <div className="chat-tool-copy">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                void copy();
              }}
              aria-label={`Copy ${call.summary}`}
            >
              Copy
            </button>
            <span role="status">{feedback}</span>
          </div>
        </div>
      )}
    </details>
  );
}
