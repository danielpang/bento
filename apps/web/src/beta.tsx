import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { BentoClient } from "@bento/api-client";

/**
 * Whether the signed-in user turned beta features on (Settings, Account).
 *
 * New product that is not ready for every signed-in user renders
 * through `BetaOnly` (or `useBetaTesters` for a lighter check). This
 * module only consumes `/api/flags`. Hidden until that answer arrives,
 * so unfinished UI cannot flash.
 */
type SwarmAccessState = "open" | "waitlist";

const BetaTestersContext = createContext<{
  ready: boolean;
  enabled: boolean;
  swarms: SwarmAccessState;
  swarmWaitlistJoined: boolean;
  set: (enabled: boolean) => void;
}>({
  ready: false,
  enabled: false,
  swarms: "open",
  swarmWaitlistJoined: false,
  set: () => {},
});

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
  const [swarms, setSwarms] = useState<SwarmAccessState>("open");
  const [swarmWaitlistJoined, setSwarmWaitlistJoined] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void client
      .flags()
      .then((snapshot) => {
        if (cancelled) return;
        setEnabled(snapshot.betaTesters);
        setSwarms(snapshot.swarms ?? "open");
        setSwarmWaitlistJoined(snapshot.swarmWaitlistJoined === true);
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

  return (
    <BetaTestersContext.Provider value={{ ready, enabled, swarms, swarmWaitlistJoined, set: setEnabled }}>{children}</BetaTestersContext.Provider>
  );
}

/**
 * Replaces the answer after the person changed their own switch, with
 * what the server said it now is, so the console follows without a reload.
 */
export function useSetBetaTesters(): (enabled: boolean) => void {
  return useContext(BetaTestersContext).set;
}

/**
 * True only after the flag has resolved and this user is on it.
 * False while loading, so a new control does not appear and then vanish.
 */
export function useBetaTesters(): boolean {
  const { ready, enabled } = useContext(BetaTestersContext);
  return ready && enabled;
}

/**
 * Whether the Swarms tab opens the board or the waitlist, or null while
 * the flags are in flight. Hosted Bento waitlists people PostHog has
 * not let in; local Bento is always open.
 */
export function useSwarmAccessState(): SwarmAccessState | null {
  const { ready, swarms } = useContext(BetaTestersContext);
  return ready ? swarms : null;
}

/** Whether this person already asked to join the hosted Swarms waitlist. */
export function useSwarmWaitlistJoined(): boolean {
  return useContext(BetaTestersContext).swarmWaitlistJoined;
}

/** Renders children only for users with beta features on. */
export function BetaOnly({ children }: { children: ReactNode }) {
  if (!useBetaTesters()) return null;
  return children;
}

/**
 * Supplies a resolved flag value without talking to the server.
 * Tests, and a parent that already knows.
 */
export function BetaTestersScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return (
    <BetaTestersContext.Provider value={{ ready: true, enabled, swarms: "open", swarmWaitlistJoined: false, set: () => {} }}>{children}</BetaTestersContext.Provider>
  );
}
