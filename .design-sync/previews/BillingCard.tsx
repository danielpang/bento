import { BillingCard } from "@bento/web";
import { Surface } from "./_fixtures.js";

/**
 * The plan card, as it behaves without a billing backend.
 *
 * BillingCard asks `/api/billing/plan` directly, and a 404 means the
 * deployment has no billing at all — the open source case — so it
 * removes itself rather than showing an empty shell. Rendering it alone
 * therefore produces a blank card, which tells a reader nothing, so the
 * card says what it is looking at.
 *
 * Stubbing the response was tried and rejected: patching `fetch` from
 * the preview broke the module's own evaluation, costing the card
 * entirely rather than filling it in. The populated state is only
 * reachable on a hosted deployment.
 */
export function WithoutBilling() {
  return (
    <Surface>
      <div style={{ maxWidth: 640 }}>
        <p className="label">Plan</p>
        <p className="muted">
          Nothing below this line: on a deployment with no billing service, BillingCard removes
          itself rather than rendering an empty shell. Its populated state — plan, seats, live cards,
          and the upgrade action — appears only where <code>/api/billing/plan</code> answers.
        </p>
        <BillingCard />
      </div>
    </Surface>
  );
}
