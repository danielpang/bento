import { useMemo, useState } from "react";
import { Modal } from "./Modal.js";
import { cappedUsd, formatUsd, spendParts } from "../swarm/money.js";
import type { Swarm, SwarmLanding, SwarmPullRequest } from "../swarm/types.js";

/**
 * Taking a finished swarm up again.
 *
 * Three things a person has to be able to see before they press it,
 * and the dialog is those three things in order.
 *
 * **What it already cost.** A reopen carries the ledger forward: the
 * money is spent and a follow up spends more on top of it. So the
 * spend is printed the way the header prints it, three figures apart,
 * next to the budget the follow up will run under. A swarm whose whole
 * budget is gone cannot start anything at all, and rather than letting
 * the server say so after the fact the dialog says it here and points
 * at the field that fixes it.
 *
 * **What the follow up will actually do.** Not a second swarm and not
 * a retry: one plan node at the top of the tree, the planner told what
 * was asked for, and the same branch and the same pull requests. That
 * last part is the whole reason a person would choose this over
 * starting a new swarm, so it is said in words rather than implied by
 * the absence of a branch field.
 *
 * **What is already open.** The pull request numbers, when the swarm
 * published any, because "the ones that are already open" means
 * nothing until it names them.
 *
 * The instruction is the only required field. Raising a ceiling is
 * optional, except where leaving it alone would start nothing, and the
 * dialog keeps that rule in one place: `ceilingRefusal`.
 */
export function ReopenDialog({
  swarm,
  pullRequests,
  landings,
  busy,
  onClose,
  onReopen,
}: {
  swarm: Swarm;
  pullRequests: SwarmPullRequest[];
  landings: SwarmLanding[];
  busy?: boolean;
  onClose: () => void;
  onReopen: (input: { instruction: string; budgetUsd?: number | null; timeLimitMin?: number | null }) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [budget, setBudget] = useState(swarm.budgetUsd === null ? "" : String(swarm.budgetUsd));
  const [timeLimit, setTimeLimit] = useState(swarm.timeLimitMin === null ? "" : String(swarm.timeLimitMin));

  const spent = cappedUsd(swarm.spend);
  const budgetUsd = budget.trim() === "" ? null : Number(budget);
  const timeLimitMin = timeLimit.trim() === "" ? null : Number(timeLimit);
  const budgetChanged = budgetUsd !== swarm.budgetUsd;
  const timeLimitChanged = timeLimitMin !== swarm.timeLimitMin;

  const refusal = useMemo(
    () => ceilingRefusal(swarm, spent, budgetUsd, timeLimitMin),
    [swarm, spent, budgetUsd, timeLimitMin],
  );

  const landed = landings.filter((landing) => landing.status === "landed").length;
  const ready = instruction.trim() !== "" && refusal === null;

  function submit() {
    if (!ready) return;
    onReopen({
      instruction: instruction.trim(),
      // Only what the person actually moved. An unchanged field sent
      // anyway would be the console rewriting a ceiling nobody touched.
      ...(budgetChanged ? { budgetUsd } : {}),
      ...(timeLimitChanged ? { timeLimitMin } : {}),
    });
  }

  return (
    <Modal
      title="Reopen this swarm"
      description="The same swarm, the same branch, and the pull requests it already opened."
      large
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={submit}>
            Reopen
          </button>
        </>
      }
    >
      <div className="swarm-reopen">
        <label className="field">
          <span className="label">What the follow up should do</span>
          <textarea
            className="input"
            rows={4}
            autoFocus
            value={instruction}
            placeholder="Address the review comments on the totals module."
            onChange={(e) => setInstruction(e.target.value)}
          />
          <span className="muted">
            The planner reads this and decides what it involves. It goes under a new plan node at the top of the
            tree, and everything the first pass finished is left as it is.
          </span>
        </label>

        <section className="swarm-reopen-ledger">
          <span className="label">What it has cost so far</span>
          <ul className="swarm-tiers swarm-tiers-inline">
            {spendParts(swarm.spend).map((part) => (
              <li key={part.tier} title={part.note}>
                <span className="swarm-tier-value spend-figure">{formatUsd(part.usd)}</span>
                <span className="swarm-tier-label">{part.label}</span>
              </li>
            ))}
          </ul>
          <p className="muted">
            {swarm.budgetUsd === null
              ? `${formatUsd(spent)} spent, against no budget. A follow up spends on top of that.`
              : `${formatUsd(spent)} of ${formatUsd(swarm.budgetUsd)} spent. A follow up spends on top of that, so it needs room under the budget below.`}
          </p>
        </section>

        <div className="swarm-reopen-ceilings">
          <label className="field">
            <span className="label">Budget</span>
            <input
              className="input"
              inputMode="decimal"
              value={budget}
              placeholder="No budget"
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="label">Time limit, in minutes</span>
            <input
              className="input"
              inputMode="numeric"
              value={timeLimit}
              placeholder="No limit"
              onChange={(e) => setTimeLimit(e.target.value)}
            />
          </label>
        </div>

        {refusal && (
          <p className="swarm-reopen-refusal" role="status">
            {refusal}
          </p>
        )}

        <section className="swarm-reopen-effect">
          <span className="label">What reopening does</span>
          <ul className="swarm-reopen-list">
            {reopenEffectLines(swarm, pullRequests, landed).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>
    </Modal>
  );
}

/**
 * What reopening actually does, in three sentences.
 *
 * Its own function rather than markup inside the dialog, because it is
 * the part of this screen that is worth holding to: a person choosing
 * between a reopen and a new swarm is choosing on exactly these three
 * facts, and the dialog lives behind a portal that a rendering test
 * cannot see into. The dialog draws what this returns.
 */
export function reopenEffectLines(
  swarm: Pick<Swarm, "branchName">,
  pullRequests: SwarmPullRequest[],
  landed: number,
): string[] {
  return [
    swarm.branchName
      ? `The work carries on ${swarm.branchName}, so nothing here starts a second branch.`
      : "The work carries on the swarm's own branch, so nothing here starts a second branch.",
    pullRequests.length === 0
      ? "This swarm has opened no pull request yet. The one it opens when the follow up finishes is its first."
      : pullRequests.length === 1
        ? `Pull request ${pullRequestLabel(pullRequests[0]!)} is updated when the follow up finishes, rather than a second one being opened.`
        : `The ${pullRequests.length} pull requests it already opened (${pullRequests.map(pullRequestLabel).join(", ")}) are updated when the follow up finishes, rather than a second set being opened.`,
    landed === 0
      ? "Nothing has landed through the merge queue yet, so the follow up starts from whatever is on the branch."
      : `The ${landed} ${landed === 1 ? "task" : "tasks"} that landed stay landed. A follow up adds work, it does not take any back.`,
  ];
}

/**
 * Why this reopen would start nothing, or null.
 *
 * The same two questions the server asks before it writes anything,
 * asked here so a person is told while they can still do something
 * about it. The wording differs from the server's on purpose: this one
 * is about a field on the screen, and the server's is about a request
 * that has already been sent.
 */
export function ceilingRefusal(
  swarm: Pick<Swarm, "status" | "budgetUsd" | "timeLimitMin">,
  spentUsd: number,
  budgetUsd: number | null,
  timeLimitMin: number | null,
): string | null {
  if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
    return "The budget has to be a number of dollars, or empty for no budget.";
  }
  if (timeLimitMin !== null && (!Number.isInteger(timeLimitMin) || timeLimitMin < 1)) {
    return "The time limit has to be a whole number of minutes, or empty for no limit.";
  }
  if (budgetUsd !== null && spentUsd >= budgetUsd) {
    return `This swarm has already spent ${formatUsd(spentUsd)}, so a follow up under a ${formatUsd(budgetUsd)} budget would start nothing. Raise the budget.`;
  }
  /*
   * The clock counts every minute since the swarm's first agent,
   * paused ones included, so a swarm that timed out is past its limit
   * for good. Reopening it on the same limit hands it straight back to
   * the watchdog.
   */
  if (swarm.status === "timed_out" && swarm.timeLimitMin !== null) {
    if (timeLimitMin !== null && timeLimitMin <= swarm.timeLimitMin) {
      return `This swarm ran past its ${swarm.timeLimitMin} minute limit, and the limit counts every minute since its first agent. Raise it, or clear it.`;
    }
  }
  return null;
}

/** A pull request, as one line of a sentence about several. */
function pullRequestLabel(pr: SwarmPullRequest): string {
  return `${pr.repoUrl.split("/").slice(-2).join("/")} #${pr.number}`;
}
