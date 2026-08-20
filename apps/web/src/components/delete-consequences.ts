import type { AgentRun, Feature, FeaturePullRequest } from "@bento/api-client";

const TERMINAL_RUN = new Set(["succeeded", "failed", "cancelled"]);

/**
 * What goes with the card, and what does not.
 *
 * Built from clauses so it only ever claims what is true. The one it
 * exists for is the pull request: the most predictable wrong belief
 * about a delete button on a card is that it takes the code with it,
 * and both directions of that belief lose something. Somebody who
 * thinks their branch goes loses work they still have; somebody who
 * thinks GitHub is tidied leaves a pull request open and forgotten.
 *
 * Lives outside the drawer so the copy can be tested without loading
 * the drawer's dialogs, which pull in the auth client and need a
 * browser.
 */
export function deleteConsequences(
  feature: Pick<Feature, "branchName">,
  runs: AgentRun[],
  pullRequests: Pick<FeaturePullRequest, "number">[],
): string {
  if (runs.length === 0) {
    return "Nothing has run on this card, so nothing else goes with it. It leaves the board for everyone in this organization. There is no undo.";
  }

  const finished = runs.filter((r) => TERMINAL_RUN.has(r.status));
  const measured = finished.filter((r) => r.costUsd !== null && r.costUsd !== undefined);
  const total = measured.reduce((sum, r) => sum + Number(r.costUsd), 0);

  // "Its 1 run goes with it" reads badly enough to be worth its own
  // wording.
  const going =
    runs.length === 1
      ? "Its single run goes with it, transcript and recorded spend included"
      : `Its ${runs.length} runs go with it, transcripts and recorded spend included`;

  const sentences = [
    // Most tools print no cost at all, and naming a figure that is
    // really a floor would be worse than naming none.
    measured.length > 0 ? `${going}, so this project's spend drops by $${total.toFixed(2)}.` : `${going}.`,
  ];
  if (feature.branchName) {
    sentences.push(`The branch ${feature.branchName} is left alone, and any pull request stays open.`);
  }
  if (pullRequests.length === 1) {
    sentences.push(
      `Bento stops tracking pull request #${pullRequests[0]!.number}. It stays open on GitHub, where you can merge or close it yourself.`,
    );
  } else if (pullRequests.length > 1) {
    // A card spanning two repositories has one in each, and naming
    // only the first would leave the other quietly untracked.
    sentences.push(
      `Bento stops tracking pull requests ${pullRequests.map((pr) => `#${pr.number}`).join(", ")}. They stay open on GitHub, where you can merge or close them yourself.`,
    );
  }
  sentences.push("Its sandbox is thrown away, and there is no undo.");
  return sentences.join(" ");
}
