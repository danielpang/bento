import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type BentoClient } from "@bento/api-client";
import { githubIssueUrl, ISSUES_URL } from "../github-issue.js";
import { Modal } from "./Modal.js";

/**
 * The contact form: an issue report or a feature request, mailed to
 * the operator through the server.
 *
 * A server with no contact address (the desktop app, most self-hosted
 * installs) has nowhere to mail it, so there the form opens a GitHub
 * issue with the message filled in. Nothing is sent from the machine;
 * the person reviews it on GitHub and submits it themselves.
 *
 * When reporting an issue, a GitHub link sits under the kind picker
 * rather than after the form, because the useful moment to check for
 * an existing issue is before writing the report, not after sending it.
 */
export function ContactDialog({
  client,
  onClose,
  initialKind = "issue",
  featurePlaceholder,
}: {
  client: BentoClient;
  onClose: () => void;
  /**
   * Preselect issue or feature. The Agents "request a new coding
   * agent or model" control opens this as a feature request so the
   * user does not have to flip the radio first.
   */
  initialKind?: "issue" | "feature";
  /** Overrides the feature-request textarea hint when set. */
  featurePlaceholder?: string;
}) {
  const [kind, setKind] = useState<"issue" | "feature">(initialKind);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [issueUrl, setIssueUrl] = useState("");
  // Unknown until health answers, and treated as mailable meanwhile: a
  // server older than the field cannot say, and the refusal below
  // still lands on GitHub.
  const [mailable, setMailable] = useState(true);
  const ready = message.trim().length > 0;

  useEffect(() => {
    let live = true;
    void client
      .health()
      .then((health) => {
        if (live && health.contact === false) setMailable(false);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client]);

  function openIssue() {
    const url = githubIssueUrl(kind, message);
    window.open(url, "_blank", "noopener,noreferrer");
    setIssueUrl(url);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    if (!mailable) {
      openIssue();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await client.sendContact({ kind, message: message.trim() });
      // Kept open so the confirmation is seen: a dialog that vanishes
      // on submit leaves someone wondering whether anything was sent.
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        // No contact address after all. The message is kept, so the
        // next press takes it to GitHub instead of losing it.
        setMailable(false);
        setError("This server cannot send mail. Open it on GitHub instead, and your message will be filled in.");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (issueUrl) {
    return (
      <Modal
        title="Contact"
        description="Your message is filled in on a new GitHub issue. Review it there and submit it to send it to us."
        onClose={onClose}
        actions={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        }
      >
        <p className="muted">
          Nothing opened?{" "}
          <a href={issueUrl} target="_blank" rel="noreferrer">
            Open the issue on GitHub
          </a>
        </p>
      </Modal>
    );
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
      description={
        mailable
          ? "Report an issue or request a feature, and it lands in our inbox."
          : "Report an issue or request a feature. It opens as a GitHub issue with your message filled in, for you to submit."
      }
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="contact-form" className="btn btn-primary" disabled={busy || !ready}>
            {mailable ? "Send" : "Open on GitHub"}
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
          {kind === "issue" && (
            <span className="muted">
              <a href={ISSUES_URL} target="_blank" rel="noreferrer">
                Check existing issues on GitHub
              </a>
            </span>
          )}
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
                : (featurePlaceholder ?? "What should Bento do, and what would it help you get done?")
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
