import { useEffect } from "react";

/**
 * The first thing a brand new account sees: the board's empty state on
 * black, fading in and back out before the walkthrough opens.
 *
 * Decoration, not content. It is hidden from assistive tech, any click
 * or key skips it, and with reduced motion it does not play at all.
 * The board's own empty state is underneath, so nothing is lost by
 * skipping it.
 */
export function OnboardingIntro({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDone();
      return;
    }
    const skip = () => onDone();
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [onDone]);

  return (
    <div
      className="onboarding-intro"
      aria-hidden="true"
      onClick={onDone}
      onAnimationEnd={(event) => {
        // The backdrop's own fade is the last thing to finish; the hero's
        // animation bubbles up here too and must not end it early.
        if (event.target === event.currentTarget) onDone();
      }}
    >
      <div className="onboarding-intro-hero">
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
