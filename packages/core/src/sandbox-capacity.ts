/** Shared wording for the persisted run error and all console surfaces. */
export const SANDBOX_CAPACITY_TITLE = "We're at capacity right now";
export const SANDBOX_CAPACITY_MESSAGE =
  "We're at capacity right now. We're a small team, and we're working to add more capacity so everyone has room to build. Please try again in a few minutes.";

/** Only Bento's opening sentence qualifies, never text in an agent's output. */
export function isSandboxCapacityError(error: string | null | undefined): boolean {
  return error?.split("\n", 1)[0] === `sandbox provisioning failed: ${SANDBOX_CAPACITY_MESSAGE}`;
}
