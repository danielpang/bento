import { Box, Text } from "ink";
import type { AgentProfile, Feature, Stage } from "@bento/api-client";

export function statusColor(status: string): string {
  switch (status) {
    case "running":
    case "starting":
    case "queued":
      return "blue";
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    case "gated":
      return "yellow";
    default:
      return "gray";
  }
}

/**
 * Vertical lanes read better than columns in a terminal: stage name,
 * then its cards indented beneath it.
 */
export function Board({
  stages,
  features,
  profiles,
  selectedIndex,
  runStatus,
  gateWait,
}: {
  stages: Stage[];
  features: Feature[];
  profiles: AgentProfile[];
  selectedIndex: number;
  /** Newest run status per card, for the whole board rather than the selection. */
  runStatus: Record<string, string | undefined>;
  /** Why a gated card is held, in words, per card. */
  gateWait: Record<string, string | undefined>;
}) {
  const ordered = orderFeatures(stages, features);

  return (
    <Box flexDirection="column">
      {[{ id: null, name: "Backlog" }, ...stages].map((stage) => {
        const inStage = features.filter((f) => (f.currentStageId ?? null) === (stage.id ?? null));
        const agent = "id" in stage && stage.id ? profiles.find((p) => p.id === findStage(stages, stage.id)?.defaultAgentProfileId) : undefined;
        return (
          <Box key={stage.id ?? "backlog"} flexDirection="column" marginBottom={1}>
            <Box>
              <Text bold color="white">
                {stage.name}
              </Text>
              <Text color="gray"> ({inStage.length})</Text>
              {agent && <Text color="magenta"> [{agent.cli}]</Text>}
            </Box>
            {inStage.length === 0 && <Text color="gray"> empty</Text>}
            {inStage.map((feature) => {
              const index = ordered.findIndex((f) => f.id === feature.id);
              const selected = index === selectedIndex;
              const state = cardState(feature, runStatus[feature.id]);
              const waiting = feature.status === "gated" ? gateWait[feature.id] : undefined;
              const detail = waiting ?? "";
              return (
                <Box key={feature.id} flexDirection="column">
                  <Box>
                    <Text color={selected ? "cyan" : "gray"}>{selected ? " > " : "   "}</Text>
                    <Text color={statusColor(state)}>●</Text>
                    <Text color={selected ? "cyan" : "white"}> {feature.title}</Text>
                    <Text color="gray"> {state}</Text>
                  </Box>
                  {detail && <Text color="gray">{"     "}{detail}</Text>}
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * What a card is doing, in one word: where the card stands first, then
 * its newest run. The run status has to be known for every card and not
 * just the selected one, or a board of working agents reads as four
 * idle cards and one that is doing something.
 */
export function cardState(feature: Feature, runStatus: string | undefined): string {
  if (feature.status === "gated") return "gated";
  if (feature.status === "done") return "done";
  if (runStatus === "queued" || runStatus === "starting" || runStatus === "running") return runStatus;
  if (!feature.currentStageId) return "backlog";
  return runStatus ?? "idle";
}

/** Flattened order used for keyboard selection: backlog first, then stages. */
export function orderFeatures(stages: Stage[], features: Feature[]): Feature[] {
  const backlog = features.filter((f) => !f.currentStageId);
  const staged = stages.flatMap((stage) => features.filter((f) => f.currentStageId === stage.id));
  return [...backlog, ...staged];
}

function findStage(stages: Stage[], id: string | null): Stage | undefined {
  return stages.find((s) => s.id === id);
}
