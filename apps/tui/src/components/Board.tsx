import { Box, Text } from "ink";
import { useRef } from "react";
import type { MouseBindings } from "../mouse.js";
import { terminalText } from "../terminal.js";
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
  maxRows,
  mouse,
}: {
  stages: Stage[];
  features: Feature[];
  profiles: AgentProfile[];
  selectedIndex: number;
  /** Newest run status per card, for the whole board rather than the selection. */
  runStatus: Record<string, string | undefined>;
  /** Why a gated card is held, in words, per card. */
  gateWait: Record<string, string | undefined>;
  maxRows?: number;
  mouse?: MouseBindings;
}) {
  const windowStart = useRef(0);
  const ordered = orderFeatures(stages, features);
  const finished = features.filter(isFinished);

  if (maxRows !== undefined) {
    let start = windowStart.current;
    if (selectedIndex < start) start = selectedIndex;
    if (selectedIndex >= start + maxRows) start = selectedIndex - maxRows + 1;
    start = Math.max(0, Math.min(start, ordered.length - maxRows));
    windowStart.current = start;
    return (
      <Box ref={mouse?.target("list", {})} flexDirection="column" marginBottom={1}>
        <Text dimColor>
          BOARD · {ordered.length} cards ·{" "}
          {ordered.filter((f) => ["running", "starting", "queued"].includes(runStatus[f.id] ?? "")).length}{" "}
          agents active
        </Text>
        {ordered.length === 0 && <Text dimColor>No cards yet. Press n to describe your first task.</Text>}
        {ordered.slice(start, start + maxRows).map((feature, i) => {
          const lane = isFinished(feature)
            ? "Done"
            : (stages.find((s) => s.id === feature.currentStageId)?.name ?? "Backlog");
          const selected = start + i === selectedIndex;
          return (
            <Box
              key={feature.id}
              ref={mouse?.target(`card:${feature.id}`, { cardId: feature.id })}
              height={1}
            >
              <Text wrap="truncate-end" {...(selected ? { color: "cyan" } : {})}>
                {selected ? "› " : "  "}
                <Text color={statusColor(cardState(feature, runStatus[feature.id]))}>● </Text>
                {terminalText(feature.title)}{" "}
                <Text dimColor>
                  {" "}
                  · {terminalText(lane)} · {cardState(feature, runStatus[feature.id])}
                </Text>
              </Text>
            </Box>
          );
        })}
        {ordered.length > maxRows && (
          <Text dimColor wrap="truncate-end">
            {start + 1} to {Math.min(start + maxRows, ordered.length)} of {ordered.length} · ↑/↓ to scroll
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {[{ id: null, name: "Backlog" }, ...stages].map((stage) => {
        const inStage = features.filter((f) => (stage.id ? inLane(f, stage.id) : inBacklog(f)));
        const agent =
          "id" in stage && stage.id
            ? profiles.find((p) => p.id === findStage(stages, stage.id)?.defaultAgentProfileId)
            : undefined;
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
            {inStage.map((feature) => (
              <CardRow
                key={feature.id}
                feature={feature}
                ordered={ordered}
                selectedIndex={selectedIndex}
                runStatus={runStatus[feature.id]}
                waiting={feature.status === "gated" ? gateWait[feature.id] : undefined}
              />
            ))}
          </Box>
        );
      })}
      {/*
        Finished work leaves its stage, the way the web console's
        Completed lane does. A shipped card sitting in Review next to
        work still being reviewed made the count lie about the queue.
      */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text bold color="white">
            Completed
          </Text>
          <Text color="gray"> ({finished.length})</Text>
          <Text color="gray"> finished work</Text>
        </Box>
        {finished.length === 0 && <Text color="gray"> empty</Text>}
        {finished.map((feature) => (
          <CardRow
            key={feature.id}
            feature={feature}
            ordered={ordered}
            selectedIndex={selectedIndex}
            runStatus={runStatus[feature.id]}
          />
        ))}
      </Box>
    </Box>
  );
}

function CardRow({
  feature,
  ordered,
  selectedIndex,
  runStatus,
  waiting,
}: {
  feature: Feature;
  ordered: Feature[];
  selectedIndex: number;
  runStatus: string | undefined;
  waiting?: string | undefined;
}) {
  const index = ordered.findIndex((f) => f.id === feature.id);
  const selected = index === selectedIndex;
  const state = cardState(feature, runStatus);
  const detail = waiting ?? "";
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? "cyan" : "gray"}>{selected ? " > " : "   "}</Text>
        <Text color={statusColor(state)}>●</Text>
        <Text {...(selected ? { color: "cyan" } : {})}> {terminalText(feature.title)}</Text>
        <Text color="gray"> {state}</Text>
      </Box>
      {detail && (
        <Text color="gray">
          {"     "}
          {terminalText(detail)}
        </Text>
      )}
    </Box>
  );
}

/**
 * What a card is doing, in one word: a working agent first, then where
 * the card stands, then its newest run. The run status has to be known
 * for every card and not just the selected one, or a board of working
 * agents reads as four idle cards and one that is doing something.
 *
 * A working agent outranks the gate for the same reason: a card stays
 * gated while an agent judges it or re-runs its stage, and reporting
 * only the gate hid every one of those agents. The wait line underneath
 * still says what the gate is holding out for.
 */
export function cardState(feature: Feature, runStatus: string | undefined): string {
  if (feature.status === "done") return "completed";
  if (feature.status === "cancelled") return "cancelled";
  if (runStatus === "queued" || runStatus === "starting" || runStatus === "running") return runStatus;
  if (feature.status === "gated") return "gated";
  if (!feature.currentStageId) return "backlog";
  return runStatus ?? "idle";
}

/** A card whose work is over: finished or abandoned, either way not moving. */
export function isFinished(feature: Pick<Feature, "status">): boolean {
  return feature.status === "done" || feature.status === "cancelled";
}

const inBacklog = (feature: Feature) => !feature.currentStageId && !isFinished(feature);
const inLane = (feature: Feature, stageId: string) =>
  feature.currentStageId === stageId && !isFinished(feature);

/**
 * Flattened order used for keyboard selection: backlog, then stages,
 * then completed. Finished cards keep the stage they ended in, so
 * leaving them in that lane would put the highlight on a shipped card
 * while j/k walked what looked like the review queue.
 */
export function orderFeatures(stages: Stage[], features: Feature[]): Feature[] {
  const backlog = features.filter(inBacklog);
  const staged = stages.flatMap((stage) => features.filter((f) => inLane(f, stage.id)));
  const finished = features.filter(isFinished);
  return [...backlog, ...staged, ...finished];
}

function findStage(stages: Stage[], id: string | null): Stage | undefined {
  return stages.find((s) => s.id === id);
}
