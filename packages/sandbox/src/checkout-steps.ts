import { ProvisionFailure, checkoutScriptBlame, type ProvisionBlame, type SandboxHandle } from "./driver.js";
import { shellQuote, shellQuotePart } from "./shell.js";
import { fetchStartBundleCommand } from "./start-bundle.js";

/**
 * One shell script of a repository checkout, run on its own so a failure
 * is judged by the step that failed and nothing a step before it said.
 *
 * As one script, the branch fallback (`git checkout B || git checkout -b
 * B`) left git's "error: pathspec 'B' did not match" in stderr on every
 * new branch, and a later failure of the machine read as git refusing
 * the project.
 */
export interface CheckoutStep {
  script: string;
  /**
   * "remote" reads the project's remote, so git refusing it (a repository
   * that is not there, a credential it would not take) is the project's.
   * "branch" cuts the run's branch from the checkout, so a start point
   * git cannot find is the project's. "local" works only on what Bento
   * put in the machine (a bundle it wrote, the checkout it made), so its
   * failure is the machine's or Bento's, never the project's.
   */
  source: "remote" | "branch" | "local";
}

export interface CheckoutInput {
  /** Where the checkout lives in the machine. */
  dir: string;
  cloneUrl?: string | undefined;
  branch: string;
  baseBranch: string;
  /**
   * A seed bundle the driver already wrote into the machine, and the
   * swarm's starting branch beside it. Present, the checkout is made
   * from these files and never reads the remote.
   */
  seed?: { bundlePath: string; start?: { bundlePath: string; branch: string } | undefined } | undefined;
}

/**
 * The steps that make or refresh one repository's checkout, the same for
 * every driver that clones inside its machine. Each is safe to run twice,
 * because a driver retries a step whose connection dropped.
 */
export function checkoutSteps(input: CheckoutInput): CheckoutStep[] {
  const dir = shellQuote(input.dir);
  const branch = shellQuote(input.branch);
  /*
   * Only where there is a remote to compare against. A seeded checkout
   * has no origin, and comparing that against an empty string matches
   * nothing, so the check would delete the workspace on every
   * re-provision of the same machine.
   */
  const verifyIdentity = input.cloneUrl
    ? [
        `if [ -d ${dir}/.git ]; then`,
        `  current_origin=$(git -C ${dir} remote get-url origin 2>/dev/null || true)`,
        `  if [ "$current_origin" != ${shellQuote(input.cloneUrl)} ]; then rm -rf ${dir}; fi`,
        "fi",
      ]
    : [];
  // The first checkout fails on every new branch, and says so; that line
  // is not a reason, so it is not kept.
  const switchBranch = (startRef?: string) =>
    `cd ${dir} && (git checkout ${branch} 2>/dev/null || git checkout -b ${branch}${startRef ? ` ${shellQuote(startRef)}` : ""})`;

  if (input.seed) {
    const bundle = shellQuote(input.seed.bundlePath);
    const base = shellQuotePart(input.baseBranch);
    const start = input.seed.start;
    return [
      {
        source: "local",
        script: [
          "set -eu",
          ...verifyIdentity,
          `if [ -d ${dir}/.git ]; then`,
          `  cd ${dir} && git fetch ${bundle} refs/heads/${base}:refs/remotes/origin/${base}`,
          "else",
          `  git clone ${bundle} ${dir}`,
          ...(input.cloneUrl ? [`  cd ${dir} && git remote set-url origin ${shellQuote(input.cloneUrl)}`] : []),
          "fi",
        ].join("\n"),
      },
      /*
       * A swarm worker's start point is the swarm's branch, which has
       * never been pushed. It arrives as a second bundle, is fetched
       * after the seed (its prerequisite is on the base branch), and the
       * run's branch is cut from it.
       */
      ...(start
        ? [{ source: "local" as const, script: ["set -eu", fetchStartBundleCommand(input.dir, start.bundlePath, start.branch)].join("\n") }]
        : []),
      // Cut from refs the bundles above brought in, which are Bento's.
      { source: "local", script: ["set -eu", switchBranch(start ? start.branch : `origin/${input.baseBranch}`)].join("\n") },
    ];
  }

  if (!input.cloneUrl) return [];
  return [
    {
      source: "remote",
      script: [
        "set -eu",
        ...verifyIdentity,
        `if [ -d ${dir}/.git ]; then`,
        `  cd ${dir} && git fetch --all --prune`,
        "else",
        `  git clone ${shellQuote(input.cloneUrl)} ${dir}`,
        "fi",
      ].join("\n"),
    },
    { source: "branch", script: ["set -eu", switchBranch()].join("\n") },
  ];
}

/**
 * A checkout step that did not finish, tagged with whose fault it was.
 * `err` carries the script's `exitCode` and `stderr` when the script
 * exited; an error without them (a dropped connection, a provider API
 * call) is the machine's.
 */
export function checkoutStepFailure(provider: SandboxHandle["provider"], step: CheckoutStep, err: unknown): ProvisionFailure {
  if (err instanceof ProvisionFailure) return err;
  return new ProvisionFailure(provider, "checkout", checkoutStepBlame(step, err), err);
}

function checkoutStepBlame(step: CheckoutStep, err: unknown): ProvisionBlame {
  if (step.source === "local") return "provider";
  const { exitCode, stderr } = (typeof err === "object" && err !== null ? err : {}) as { exitCode?: unknown; stderr?: unknown };
  return checkoutScriptBlame(typeof exitCode === "number" ? exitCode : undefined, typeof stderr === "string" ? stderr : "");
}
