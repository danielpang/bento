import { useEffect, useState } from "react";
import { spendCoverageNote } from "@bento/core";
import { Modal } from "./Modal.js";
import { useToast } from "./Toasts.js";

/**
 * The team's plan, on hosted deployments.
 *
 * Everything here talks to /api/billing, which only exists when the
 * deployment loads the cloud module; on an open source install the
 * first fetch 404s and the card renders nothing. That absence is the
 * boundary: the console carries the surface, the closed module carries
 * every decision about money.
 */
interface PlanState {
  plan: string;
  planName: string;
  status: string | null;
  limits: { members: number | null; liveFeatures: number | null };
  usage: { members: number; liveFeatures: number; monthlySpendUsd: number };
  activity?: {
    activity: string;
    fromPlan: string | null;
    toPlan: string | null;
    amountTotal: number | null;
    currency: string | null;
    occurredAt: string;
  }[];
  canManageBilling: boolean;
  upgradable: boolean;
  manageable: boolean;
  salesConfigured: boolean;
}

export function BillingCard() {
  const toast = useToast();
  const [state, setState] = useState<PlanState | null>(null);
  const [absent, setAbsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [salesOpen, setSalesOpen] = useState(false);

  useEffect(() => {
    void fetch("/api/billing/plan", { credentials: "include" })
      .then(async (res) => {
        // 404 means this deployment has no billing at all, which is the
        // open source case and the only reason to render nothing. Any
        // other failure is transient, and latching on it hid the whole
        // card until a full page reload.
        if (res.status === 404) return setAbsent(true);
        if (!res.ok) return;
        setAbsent(false);
        setState((await res.json()) as PlanState);
      })
      .catch(() => {
        // A dropped request says nothing about whether billing exists.
      });
  }, [busy]);

  if (absent || !state) return null;

  async function post(path: string, body?: unknown): Promise<{ url?: string; error?: string }> {
    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok) throw new Error(parsed.error ?? `request failed with status ${res.status}`);
    return parsed;
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  const meter = (used: number, limit: number | null, word: string) =>
    limit === null ? `${used} ${word} (no limit)` : `${used} of ${limit} ${word}`;

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Plan</h3>
      <p className="muted">
        This team is on the <strong>{state.planName}</strong> plan:{" "}
        {meter(state.usage.members, state.limits.members, "members")},{" "}
        {meter(state.usage.liveFeatures, state.limits.liveFeatures, "live features")}. A feature is
        live while its card is on the board being worked; finishing or cancelling it frees the slot.
      </p>
      {/* Reported, never enforced. Only some tools print a figure, so a
          ceiling built on this would bite the teams whose tools are
          honest about cost and miss everyone else entirely. */}
      <p className="muted" title={spendCoverageNote()}>
        ${state.usage.monthlySpendUsd.toFixed(2)} of measured agent spend this month.{" "}
        {spendCoverageNote()}
      </p>
      {notice && <p className="muted">{notice}</p>}
      {!state.canManageBilling && (
        <p className="muted">Only an owner or admin can change the plan for this team.</p>
      )}
      <div className="actions">
        {state.canManageBilling && state.upgradable && state.plan !== "business" && state.plan !== "enterprise" && (
          <>
            {state.plan !== "pro" && (
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const { url } = await post("/api/billing/checkout", { plan: "pro" });
                    if (url) window.location.assign(url);
                  })
                }
              >
                Upgrade to Pro (50 live features)
              </button>
            )}
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const { url } = await post("/api/billing/checkout", { plan: "business" });
                  if (url) window.location.assign(url);
                })
              }
            >
              Upgrade to Business (500 live features)
            </button>
          </>
        )}
        {state.canManageBilling && state.manageable && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const { url } = await post("/api/billing/portal");
                if (url) window.location.assign(url);
              })
            }
          >
            Manage billing
          </button>
        )}
        {state.salesConfigured && (
          <button className="btn" disabled={busy} onClick={() => setSalesOpen(true)}>
            Enterprise: contact sales
          </button>
        )}
      </div>

      {/* Every upgrade, downgrade, cancellation and payment, so "did
          this go through" and "when did we change plan" have an answer
          in the product rather than only in the Stripe dashboard. */}
      {state.activity && state.activity.length > 0 && (
        <div className="field">
          <span className="label">Subscription activity</span>
          {state.activity.map((entry, i) => (
            <div key={i} className="history-row">
              <span className="history-when">{new Date(entry.occurredAt).toLocaleDateString()}</span>
              <span className="history-what">
                {describeActivity(entry.activity, entry.fromPlan, entry.toPlan)}
                {entry.amountTotal !== null && (
                  <span className="muted"> {formatMoney(entry.amountTotal, entry.currency)}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {salesOpen && (
        <ContactSales
          onClose={() => setSalesOpen(false)}
          onSent={() => {
            setSalesOpen(false);
            setNotice("Sent. We reply to the address you gave, usually within a business day.");
          }}
        />
      )}
    </section>
  );
}

const PLAN_WORDS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
};

/**
 * The activity in words. Mirrors the cloud module's own wording; the
 * console cannot import from it, since that package is not part of the
 * open source build.
 */
function describeActivity(activity: string, fromPlan: string | null, toPlan: string | null): string {
  const from = fromPlan ? (PLAN_WORDS[fromPlan] ?? fromPlan) : null;
  const to = toPlan ? (PLAN_WORDS[toPlan] ?? toPlan) : null;
  switch (activity) {
    case "started":
      return `Started the ${to} plan`;
    case "upgraded":
      return `Upgraded from ${from} to ${to}`;
    case "downgraded":
      return `Downgraded from ${from} to ${to}`;
    case "cancelled":
      return from ? `Cancelled the ${from} plan` : "Cancelled the subscription";
    case "renewed":
      return "Renewal paid";
    case "payment":
      return "Payment received";
    case "payment_failed":
      return "Payment failed";
    default:
      return activity;
  }
}

/** Stripe reports minor units, so cents become the currency's own shape. */
function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "Payment";
  const code = (currency ?? "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(amount / 100);
  } catch {
    // An unknown currency code must not blank the whole row.
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
}

function ContactSales({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!message.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/billing/contact-sales", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(company.trim() ? { company: company.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "the message could not be sent");
      }
      onSent();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Talk to us about Enterprise"
      description="Unlimited live features, and whatever else the contract needs. Tell us about your team and we reply by email."
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !message.trim()} onClick={() => void submit()}>
            {busy ? "Sending..." : "Send"}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="label">Your email</span>
        <input
          className="input"
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="label">Company (optional)</span>
        <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">What do you need?</span>
        <textarea
          className="input skill-input"
          rows={5}
          placeholder="Team size, how many concurrent features you expect, anything the standard plans do not cover."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
    </Modal>
  );
}
