import { StageConfig } from "@bento/web";
import { Frame, client, features, profiles, stages } from "./_fixtures.js";

/**
 * The pipeline: one card per stage, in order, each carrying the agent
 * that runs it and how a card leaves it. Drag a card by its grip to
 * reorder.
 */
export function Pipeline() {
  return (
    <Frame height={640}>
      <StageConfig
        client={client}
        projectId="prj1"
        pipelineId="pl1"
        stages={stages}
        features={features}
        profiles={profiles}
        onClose={() => {}}
        onChanged={() => {}}
      />
    </Frame>
  );
}
