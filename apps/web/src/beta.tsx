import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { BentoClient } from "@bento/api-client";

/**
 * Whether the signed-in user is on the permanent beta-testers flag.
 *
 * New product that is not ready for every signed-in user renders
 * through `BetaOnly` (or `useBetaTesters` for a lighter check). The
 * server evaluates PostHog; this module only consumes `/api/flags`.
 * Hidden until that answer arrives, so unfinished UI cannot flash.
 *
 * Add people in PostHog by putting their email on the `beta-testers`
 * flag's release conditions. Local mode is always on.
 */
const BetaTestersContext = createContext({ ready: false, enabled: false });

export function BetaTestersProvider({
  client,
  userId,
  children,
}: {
  client: BentoClient;
  /** Refetch when the signed-in user changes. Local mode has none. */
  userId?: string | null;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void client
      .flags()
      .then((snapshot) => {
        if (cancelled) return;
        setEnabled(snapshot.betaTesters);
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setEnabled(false);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, userId]);

  return <BetaTestersContext.Provider value={{ ready, enabled }}>{children}</BetaTestersContext.Provider>;
}

/**
 * True only after the flag has resolved and this user is on it.
 * False while loading, so a new control does not appear and then vanish.
 */
export function useBetaTesters(): boolean {
  const { ready, enabled } = useContext(BetaTestersContext);
  return ready && enabled;
}

/** Renders children only for users on the beta-testers flag. */
export function BetaOnly({ children }: { children: ReactNode }) {
  if (!useBetaTesters()) return null;
  return children;
}

/**
 * Supplies a resolved flag value without talking to the server.
 * Tests, and a parent that already knows.
 */
export function BetaTestersScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <BetaTestersContext.Provider value={{ ready: true, enabled }}>{children}</BetaTestersContext.Provider>;
}
