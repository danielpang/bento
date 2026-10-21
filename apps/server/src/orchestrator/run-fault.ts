import { SandboxProvisionError } from "./sandbox-provision.js";

/**
 * Whose failure ended a run, when it was not the work's.
 *
 * "bento" is this server: it restarted under the run, it could not
 * record what the agent said, it could not pick a driver. "sandbox" is
 * the machine the agent runs in: the provider could not make it, it
 * refused or lost the agent's command, it stopped under the agent, it
 * lost the CLI it was given. Neither is the person's to pay for, so a
 * run that ends with either is not billed.
 *
 * Everything else that fails a run is the work's and is billed: the
 * agent and its harness, the model provider, GitHub, a repository or
 * credential the project got wrong, the run limit. A failure carries no
 * fault unless the code that caught it knows it was one of the two
 * above, so a failure nobody classified is billed rather than waived.
 *
 * Decided where the failure is caught, from what threw, and handed to
 * finishRun with the outcome. Never read back out of the run record's
 * sentence: that text is for the person, and its tail is often the
 * agent's own output.
 */
export type RunFault = "bento" | "sandbox";

/** Whether a run that ended this way counts toward agent hours. */
export function isBillable(outcome: { ok: boolean; fault?: RunFault | undefined }): boolean {
  return outcome.ok || outcome.fault === undefined;
}

/**
 * Whose fault a provision that made no machine was.
 *
 * The provider loop has already decided this: a failure every driver
 * blamed on the provider is the sandbox's, and one a driver blamed on
 * the project (git refused the checkout) is the project's, which another
 * provider would refuse the same way. A refusal before any provider was
 * asked (a clone URL that does not answer, two repositories on one
 * checkout, GitHub refusing the seed bundle) is the project's or
 * GitHub's, so it is billed like one.
 */
export function provisionFault(err: unknown): RunFault | undefined {
  if (err instanceof SandboxProvisionError) return err.blame === "project" ? undefined : "sandbox";
  return undefined;
}
