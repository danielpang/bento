import { AgentSession } from "@bento/web";
import { client, profiles, runs } from "./_fixtures.js";

/**
 * The conversation with the card's agent: the transcript of what it did,
 * and the box that reaches it while it works.
 */
export function AfterARun() {
  return (
    <div style={{ height: 520, overflow: "hidden" }}>
      <AgentSession
        client={client}
        featureId="f1"
        runs={runs}
        profiles={profiles}
        finished={false}
        onChanged={() => {}}
      />
    </div>
  );
}

/** A finished card takes no more messages, and says so instead of offering a box. */
export function Finished() {
  return (
    <div style={{ height: 520, overflow: "hidden" }}>
      <AgentSession
        client={client}
        featureId="f1"
        runs={runs}
        profiles={profiles}
        finished
        onChanged={() => {}}
      />
    </div>
  );
}
