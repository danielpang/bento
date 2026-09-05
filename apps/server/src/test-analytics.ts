import type { Analytics, ServerEvent } from "./analytics.js";

/** An Analytics that records instead of sending, for tests. */
export function recordingAnalytics() {
  const events: ServerEvent[] = [];
  const exceptions: { error: Error; userId?: string | null | undefined; properties?: Record<string, unknown> | undefined }[] = [];
  const analytics: Analytics = {
    capture: (event) => {
      events.push(event);
    },
    captureException: (error, userId, _organizationId, properties) => {
      exceptions.push({ error: error as Error, userId, properties });
    },
    shutdown: async () => {},
  };
  return { analytics, events, exceptions };
}
