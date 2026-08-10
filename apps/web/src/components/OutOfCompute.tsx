import { useState } from "react";
import { Modal } from "./Modal.js";
import { money, outOfCompute, resetsOn, useBillingPlan } from "./billing-plan.js";

/**
 * What a team sees when its plan has no compute left.
 *
 * Driven by the plan rather than by a failed click, because that is
 * how a team actually meets this limit. Cards advance on their own:
 * the run that would have started at the next stage simply does not,
 * and nobody clicked anything to be told about. A banner reads the
 * same state the server refused on, so the answer is there whether the
 * card stopped by itself or somebody just tried to push it.
 *
 * Renders nothing when there is no wall to hit: a team paying for its
 * overage has an allowance and a rate rather than a ceiling, and an
 * install without billing has neither.
 */
export function OutOfCompute({ onOpenBilling }: { onOpenBilling: () => void }) {
  const { plan } = useBillingPlan();
  /**
   * The modal shows once and the banner stays. Somebody who has
   * already read it and gone back to work should not have to dismiss
   * it again on every reload, and the banner is enough of a reminder.
   */
  const [explained, setExplained] = useState(() => sessionStorage.getItem(SEEN) === "1");

  if (!plan || !outOfCompute(plan)) return null;

  const { used, cap } = plan.agentHours;
  // Only an owner or admin can change any of this, so only they are
  // offered the way out. Handing a member a button that refuses them
  // is worse than telling them plainly who to ask.
  const canUpgrade = plan.canManageBilling;
  /**
   * Two different situations wearing the same face. A free team
   * cannot pay for more hours; a paid team has asked us not to let
   * them. The remedy is different, so the sentence has to be.
   */
  const byChoice = plan.overage.changeable;
  const rate = plan.overage.usdPerAgentHour;
  const spent = `This team has used its ${cap} agent hours for the period (${used} so far).`;
  const remedy = byChoice
    ? `Billing is set to stop rather than pay for more. Allowing overage${rate === null ? "" : ` at ${money(rate)} an agent hour`} starts the agents again.`
    : `Agents start again on ${resetsOn(plan)}, or on a paid plan today.`;
  const nextStep = canUpgrade
    ? remedy
    : `${remedy.replace(/^Billing is set/, "This team's billing is set")} An owner or admin can change it.`;

  function dismiss() {
    sessionStorage.setItem(SEEN, "1");
    setExplained(true);
  }

  return (
    <>
      <div className="setup-prompt" role="alert">
        <span>
          {spent}{" "}
          {canUpgrade
            ? byChoice
              ? "Allow overage or upgrade to keep going."
              : "Upgrade to keep going."
            : `Ask an owner or admin to ${byChoice ? "allow overage or upgrade" : "upgrade"}.`}
        </span>
        {canUpgrade && (
          <button className="btn btn-primary" onClick={onOpenBilling}>
            {byChoice ? "Billing settings" : "See plans"}
          </button>
        )}
      </div>

      {!explained && (
        <Modal
          title="Out of agent hours"
          description={`${spent} ${nextStep}`}
          onClose={dismiss}
          actions={
            <>
              <button className="btn btn-ghost" onClick={dismiss}>
                {canUpgrade ? "Not now" : "Got it"}
              </button>
              {canUpgrade && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    dismiss();
                    onOpenBilling();
                  }}
                >
                  {byChoice ? "Billing settings" : "See plans"}
                </button>
              )}
            </>
          }
        >
          <p className="muted">
            Cards stay exactly where they are. Nothing already running was stopped, and no work was
            lost: the next agent simply does not start until there are hours for it.
          </p>
          {!canUpgrade && (
            <p className="muted">
              Changing this is an owner or admin job, so it is not yours to fix. Whoever set this
              team up can do it under Settings, Billing.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

/** Per tab, so a new session explains itself again. */
const SEEN = "bento:out-of-compute-explained";
