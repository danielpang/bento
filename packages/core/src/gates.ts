import { z } from "zod";

/**
 * A stage's exit criteria, used by AUTOMATIC stages only.
 *
 * A stage has a mode. Manual waits for a person to approve or reject
 * and consults nothing here: the two modes are genuinely different
 * questions, not one being the other plus a step. Automatic advances
 * when every criterion below passes.
 *
 * The "manual" criterion predates the mode and now says the same thing
 * as it, so a stage carrying one is read as manual whatever its mode
 * field says. That keeps every pipeline built before this behaving
 * exactly as it did.
 */
export const gateCriterion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  /**
   * The stage's own agent finished successfully. This is what an
   * automatic stage means when nothing else is asked of it: run the
   * agent, then move on. An automatic stage with an empty list is read
   * as carrying this one.
   */
  z.object({ type: z.literal("run_succeeded") }),
  /**
   * A second agent inspects the work and rules on it. The judge runs
   * once the stage's work is done, told to end its reply with
   * "VERDICT: COMPLETE" or "VERDICT: INCOMPLETE", and the criterion
   * reads that verdict. Judged again whenever newer work lands. Works
   * best as a different agent from the one doing the work, with a
   * skill saying what complete means for this stage.
   */
  z.object({ type: z.literal("agent_judge"), agentProfileId: z.string().uuid() }),
  z.object({ type: z.literal("pr_comments_resolved") }),
  z.object({ type: z.literal("checks_pass") }),
  z.object({
    type: z.literal("command"),
    cmd: z.string().min(1),
    timeoutSec: z.number().int().positive().max(3600).default(600),
  }),
]);
export type GateCriterion = z.infer<typeof gateCriterion>;

export const gateCriteria = z.array(gateCriterion);
export type GateCriteria = z.infer<typeof gateCriteria>;
