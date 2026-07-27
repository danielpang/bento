import { FeatureDrawer } from "@bento/web";
import { Frame, client, feature, profiles, stages } from "./_fixtures.js";

/**
 * A card, opened: where it is, what it costs, the pull requests it has
 * open, and every action that applies to the stage it is sitting in.
 */
export function AtAGate() {
  return (
    <Frame height={660}>
      <FeatureDrawer
        client={client}
        feature={feature}
        stages={stages}
        profiles={profiles}
        runsVersion={0}
        onClose={() => {}}
        onChanged={() => {}}
        onEvent={() => {}}
      />
    </Frame>
  );
}

/** A card still in the backlog: nothing to approve, one thing to do. */
export function InTheBacklog() {
  return (
    <Frame height={660}>
      <FeatureDrawer
        client={client}
        feature={{ ...feature, status: "backlog", currentStageId: null, branchName: null, prNumber: null }}
        stages={stages}
        profiles={profiles}
        runsVersion={0}
        onClose={() => {}}
        onChanged={() => {}}
        onEvent={() => {}}
      />
    </Frame>
  );
}
