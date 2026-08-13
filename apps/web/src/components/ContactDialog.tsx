import { useState, type FormEvent } from "react";
import type { BentoClient } from "@bento/api-client";
import { Modal } from "./Modal.js";

const ISSUES_URL = "https://github.com/danielpang/bento/issues";

/**
 * The contact form: an issue report or a feature request, mailed to
 * the operator through the server.
 *
 * The GitHub issues link sits above the form rather than after it,
 * because the useful moment to check for an existing issue is before
 * writing the report, not after sending it.
 */
export function ContactDialog({
  client,
  onClose,
}: {
  client: BentoClient;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"issue" | "feature">("issue");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const ready = message.trim().length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      await client.sendContact({ kind, message: message.trim() });
      // Kept open so the confirmation is seen: a dialog that vanishes
      // on submit leaves someone wondering whether anything was sent.
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Modal
        title="Contact"
        description="Sent. Thanks for the report, we read every one."
        onClose={onClose}
        actions={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        }
      />
    );
  }

  return (
    <Modal
      title="Contact"
      description="Report an issue or request a feature, and it lands in our inbox."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="contact-form" className="btn btn-primary" disabled={busy || !ready}>
            Send
          </button>
        </>
      }
    >
      <form id="contact-form" onSubmit={submit}>
        <div className="field">
          <span className="label">What is this about?</span>
          <label className="gate-check">
            <input
              type="radio"
              name="contact-kind"
              checked={kind === "issue"}
              onChange={() => setKind("issue")}
            />
            <span className="gate-check-text">An issue to report</span>
          </label>
          <label className="gate-check">
            <input
              type="radio"
              name="contact-kind"
              checked={kind === "feature"}
              onChange={() => setKind("feature")}
            />
            <span className="gate-check-text">A feature request</span>
          </label>
          <span className="muted">
            Reporting an issue? Check the{" "}
            <a href={ISSUES_URL} target="_blank" rel="noreferrer">
              existing issues on GitHub
            </a>{" "}
            first, someone may have hit it already.
          </span>
        </div>
        <label className="field">
          <span className="label">Message</span>
          <textarea
            className="input"
            rows={5}
            value={message}
            placeholder={
              kind === "issue"
                ? "What happened, and what did you expect instead?"
                : "What should Bento do, and what would it help you get done?"
            }
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // Enter stays a newline; submit is the chord the rest of
              // the console uses.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
            }}
          />
        </label>
        {error && <p className="error">{error}</p>}
      </form>
    </Modal>
  );
}
