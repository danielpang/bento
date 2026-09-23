import type { Analytics } from "./analytics.js";

/** Maps cloud waitlist PostHog events onto the host analytics client. */
export function bindWaitlistCapture(
  analytics: Analytics | null,
): ((event: { event: string; properties?: Record<string, unknown> }) => void) | undefined {
  if (!analytics) return undefined;
  return (event) => {
    analytics.capture({
      event: event.event,
      ...(event.properties ? { properties: event.properties } : {}),
    });
  };
}
