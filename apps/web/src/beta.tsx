import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { BentoClient } from "@bento/api-client";
import type { SwarmAccessState } from "@bento/core";

/**
 * Whether the signed-in user turned beta features on (Settings, Account).
 *
 * New product that is not ready for every signed-in user renders
 * through `BetaOnly` (or `useBetaTesters` for a lighter check). This
 * module only consumes `/api/flags`. Hidden until that answer arrives,
 * so unfinished UI cannot flash.
 */
const BetaTestersContext = createContext<{ ready: boolean; enabled: boolean; set: (enabled: boolean) => void }>({
  ready: false,
  enabled: false,
  set: () => {},
});

/**
 * Whether swarms open here, from the same `/api/flags` answer. Not
 * beta: the Swarms tab is shown to everyone. Null while in flight, and
 * "unavailable" when the answer never came, which is never read as
 * allowed.
 */
export type SwarmFlag = SwarmAccessState | "unavailable";

interface SwarmFlagValue {
  state: SwarmFlag | null;
  /** Whether this person already asked to join the hosted waitlist. */
  joined: boolean;
  retry: () => void;
}

const SwarmFlagContext = createContext<SwarmFlagValue>({ state: null, joined: false, retry: () => {} });

export function FlagsProvider({
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
  const [swarm, setSwarm] = useState<{ state: SwarmFlag | null; joined: boolean }>({ state: null, joined: false });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setSwarm((current) => ({ ...current, state: null }));
    void client
      .flags()
      .then((snapshot) => {
        if (cancelled) return;
        setEnabled(snapshot.betaTesters);
        setSwarm({ state: snapshot.swarms ?? "unavailable", joined: snapshot.swarmWaitlistJoined === true });
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setEnabled(false);
        setSwarm({ state: "unavailable", joined: false });
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, userId, attempt]);

  return (
    <BetaTestersContext.Provider value={{ ready, enabled, set: setEnabled }}>
      <SwarmFlagContext.Provider value={{ ...swarm, retry }}>{children}</SwarmFlagContext.Provider>
    </BetaTestersContext.Provider>
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

/** Whether swarms open, wait on the waitlist, or could not be checked. */
export function useSwarmFlag(): SwarmFlagValue {
  return useContext(SwarmFlagContext);
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
  return <BetaTestersContext.Provider value={{ ready: true, enabled, set: () => {} }}>{children}</BetaTestersContext.Provider>;
}
