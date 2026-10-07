import { useEffect } from "react";

/**
 * The first thing a brand new account sees: the board's empty state,
 * fading in from black. Once it is in, the walkthrough opens on top of
 * it, and it stays behind the walkthrough as its backdrop until the
 * walkthrough is put away or one of its steps opens a panel.
 *
 * Decoration, not content: hidden from assistive tech, a click skips
 * the fade, and with reduced motion it arrives already faded in.
 */
export function OnboardingIntro({ onShown }: { onShown: () => void }) {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onShown();
  }, [onShown]);

  return (
    <div className="onboarding-intro" aria-hidden="true" onClick={onShown}>
      <div className="onboarding-intro-hero" onAnimationEnd={onShown}>
        <div className="empty-pipeline">
          <span>Brief</span><span>Build</span><span>Review</span><span>Ship</span>
        </div>
        <h1>Your next feature starts here.</h1>
        <p>
          Connect a repository, describe the work, and let your agents take it through the pipeline.
          You decide when it moves forward.
        </p>
      </div>
    </div>
  );
}
