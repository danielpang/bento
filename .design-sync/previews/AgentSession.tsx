import { AgentSession } from "@bento/web";
import { client, profiles, runs, workingRuns } from "./_fixtures.js";

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

/**
 * A run still going: the transcript above stays put and Stop sits
 * beside the composer, icon-only, while the working row names what
 * the agent is doing.
 */
export function Working() {
  return (
    <div style={{ height: 520, overflow: "hidden" }}>
      <AgentSession
        client={client}
        featureId="f1"
        runs={workingRuns}
        profiles={profiles}
        finished={false}
        onChanged={() => {}}
      />
    </div>
  );
}

/**
 * Show detail expands the collapsed tool card into its individual
 * calls: a name, a short reading of its input, and the phase, still
 * inside the same subdued card.
 */
export function ToolDetail() {
  return (
    <div style={{ height: 520, overflow: "hidden" }}>
      <AgentSession
        client={client}
        featureId="f1"
        runs={runs}
        profiles={profiles}
        finished={false}
        onChanged={() => {}}
        defaultShowDetail
      />
    </div>
  );
}
