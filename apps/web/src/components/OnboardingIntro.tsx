import { useState } from "react";
import type { BentoClient } from "@bento/api-client";
import { ONBOARDING_REENABLE_NOTE } from "../onboarding.js";
import { useToast } from "./Toasts.js";

/**
 * The first thing a brand new account sees: the board's empty state,
 * fading in from black, and a choice. Skipping turns the walkthrough off
 * and leaves the defaults to arrive with the first project, exactly as
 * Skip inside the walkthrough does. Starting opens the walkthrough on
 * top of this screen, which stays behind it as its backdrop until the
 * walkthrough is put away or one of its steps opens a panel.
 *
 * With reduced motion it arrives without the fade.
 */
export function OnboardingIntro({
  client,
  started,
  onStart,
  onSkipped,
}: {
  client: BentoClient;
  /** The walkthrough is open on top, so the choice is already made. */
  started: boolean;
  onStart: () => void;
  onSkipped: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function skip() {
    setBusy(true);
    try {
      await client.setOnboarding(false);
      toast.note(ONBOARDING_REENABLE_NOTE);
      onSkipped();
    } catch (err) {
      toast.fail(err);
      setBusy(false);
    }
  }

  return (
    <section className="onboarding-intro" aria-labelledby="onboarding-intro-title" aria-hidden={started || undefined}>
      <div className="onboarding-intro-hero">
        <div className="empty-pipeline" aria-hidden="true">
          <span>Brief</span><span>Build</span><span>Review</span><span>Ship</span>
        </div>
        <h1 id="onboarding-intro-title">Your next feature starts here.</h1>
        <p>
          Connect a repository, describe the work, and let your agents take it through the pipeline.
          You decide when it moves forward.
        </p>
        <div className="onboarding-intro-actions">
          <button type="button" className="btn btn-primary" disabled={busy || started} onClick={onStart} autoFocus>
            Start onboarding
          </button>
          <button type="button" className="btn onboarding-intro-skip" disabled={busy || started} onClick={() => void skip()}>
            {busy ? "Saving..." : "Skip setup, use defaults"}
          </button>
        </div>
      </div>
    </section>
  );
}
