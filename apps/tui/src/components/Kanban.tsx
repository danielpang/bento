import { Box, Text } from "ink";
import { useRef } from "react";
import type { MouseBindings } from "../mouse.js";
import type { Feature, Stage } from "@bento/api-client";
import { cardState, isFinished, statusColor } from "./Board.js";
import { terminalText, wrapLines } from "../terminal.js";

export type BoardLane = { id: string; name: string; cards: Feature[] };

function titleLines(title: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of title.split(/\s+/)) {
    for (const part of wrapLines([word], width)) {
      const next = line ? `${line} ${part}` : part;
      if (line && wrapLines([next], width).length > 1) {
        lines.push(line);
        line = part;
      } else line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function boardLanes(stages: Stage[], features: Feature[]): BoardLane[] {
  return [
    { id: "backlog", name: "Backlog", cards: features.filter((f) => !f.currentStageId && !isFinished(f)) },
    ...stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      cards: features.filter((f) => f.currentStageId === stage.id && !isFinished(f)),
    })),
    { id: "completed", name: "Completed", cards: features.filter(isFinished) },
  ];
}

/** A selected card follows stage changes. An empty column can hold focus without targeting another card. */
export function kanbanSelection(lanes: BoardLane[], cardId: string | null, laneId: string | null) {
  const selectedLane = lanes.findIndex((lane) => lane.cards.some((card) => card.id === cardId));
  const rememberedLane = lanes.findIndex((lane) => lane.id === laneId);
  const laneIndex = Math.max(0, selectedLane >= 0 ? selectedLane : rememberedLane >= 0 ? rememberedLane : 0);
  const lane = lanes[laneIndex]!;
  const cardIndex = Math.max(
    0,
    lane.cards.findIndex((card) => card.id === cardId),
  );
  return { laneIndex, cardIndex, lane, feature: lane.cards[cardIndex] };
}

export function moveKanban(
  lanes: BoardLane[],
  cardId: string | null,
  laneId: string | null,
  direction: "left" | "right" | "up" | "down" | "first" | "last",
) {
  const selected = kanbanSelection(lanes, cardId, laneId);
  const laneIndex = Math.max(
    0,
    Math.min(
      lanes.length - 1,
      selected.laneIndex + (direction === "left" ? -1 : direction === "right" ? 1 : 0),
    ),
  );
  const lane = lanes[laneIndex]!;
  const index =
    direction === "first"
      ? 0
      : direction === "last"
        ? lane.cards.length - 1
        : selected.cardIndex + (direction === "up" ? -1 : direction === "down" ? 1 : 0);
  return {
    laneId: lane.id,
    cardId: lane.cards[Math.max(0, Math.min(index, lane.cards.length - 1))]?.id ?? null,
  };
}

export function kanbanViewport(
  width: number,
  height: number,
  laneCount: number,
  focused: number,
  previousStart?: number,
) {
  const visible = Math.max(1, Math.min(laneCount, Math.floor((width + 1) / 23)));
  const preferred =
    previousStart === undefined
      ? focused - Math.floor(visible / 2)
      : focused < previousStart
        ? focused
        : focused >= previousStart + visible
          ? focused - visible + 1
          : previousStart;
  const start = Math.max(0, Math.min(preferred, laneCount - visible));
  const columnWidth = Math.max(1, Math.floor((width - visible + 1) / visible));
  const compact = height < 12;
  const capacity = Math.max(1, compact ? height - 3 : Math.floor((height - 7) / 4));
  return { visible, start, columnWidth, compact, capacity };
}

/** Columns and their card windows track focus, so horizontal and vertical overflow stay navigable. */
export function Kanban({
  lanes,
  cardId,
  laneId,
  runStatus,
  width,
  height,
  mouse,
}: {
  lanes: BoardLane[];
  cardId: string | null;
  laneId: string | null;
  runStatus: Record<string, string | undefined>;
  width: number;
  height: number;
  mouse?: MouseBindings;
}) {
  const windowStart = useRef(0);
  const offsets = useRef(new Map<string, number>());
  const selected = kanbanSelection(lanes, cardId, laneId);
  const { visible, start, columnWidth, compact, capacity } = kanbanViewport(
    width,
    height,
    lanes.length,
    selected.laneIndex,
    windowStart.current,
  );
  windowStart.current = start;
  const total = lanes.reduce((sum, lane) => sum + lane.cards.length, 0);
  return (
    <Box flexDirection="column" height={height}>
      <Text bold wrap="truncate-end">
        KANBAN · {total} cards · {lanes.length} stages
      </Text>
      <Box gap={1} height={height - 2}>
        {lanes.slice(start, start + visible).map((lane, i) => {
          const focused = start + i === selected.laneIndex;
          let offset = offsets.current.get(lane.id) ?? 0;
          if (focused && selected.cardIndex < offset) offset = selected.cardIndex;
          if (focused && selected.cardIndex >= offset + capacity) offset = selected.cardIndex - capacity + 1;
          offset = Math.max(0, Math.min(offset, lane.cards.length - capacity));
          offsets.current.set(lane.id, offset);
          return (
            <Box
              key={lane.id}
              ref={mouse?.target(`lane:${lane.id}`, { laneId: lane.id })}
              width={columnWidth}
              height={height - 2}
              flexDirection="column"
              {...(!compact
                ? { borderStyle: "round" as const, borderColor: focused ? "cyan" : "gray", paddingX: 1 }
                : {})}
            >
              <Text bold color={focused ? "cyan" : "white"} wrap="truncate-end">
                {compact ? `${lane.cards.length} · ` : ""}
                {terminalText(lane.name)}
              </Text>
              {!compact && (
                <Text dimColor>
                  {lane.cards.length} {lane.cards.length === 1 ? "card" : "cards"}
                </Text>
              )}
              {lane.cards.length === 0 && <Text dimColor>No cards</Text>}
              {lane.cards.slice(offset, offset + capacity).map((card) => {
                const active = focused && card.id === selected.feature?.id;
                const state = cardState(card, runStatus[card.id]);
                const title = terminalText(card.title).replace(/\s+/g, " ");
                const lines = titleLines(title, Math.max(8, columnWidth - 7));
                return compact ? (
                  <Box
                    key={card.id}
                    ref={mouse?.target(`card:${card.id}`, { cardId: card.id, laneId: lane.id })}
                    height={1}
                  >
                    <Text color={active ? "cyan" : "white"} wrap="truncate-end">
                      {active ? "› " : "  "}
                      <Text color={statusColor(state)}>● </Text>
                      {title}
                    </Text>
                  </Box>
                ) : (
                  <Box
                    key={card.id}
                    ref={mouse?.target(`card:${card.id}`, { cardId: card.id, laneId: lane.id })}
                    flexDirection="column"
                    height={4}
                  >
                    <Text bold={active} color={active ? "cyan" : "white"} wrap="truncate-end">
                      {active ? "› " : "  "}
                      {lines[0]}
                    </Text>
                    <Text color={active ? "cyan" : "white"} wrap="truncate-end">
                      {" "}
                      {lines[1] ?? ""}
                      {lines.length > 2 ? "…" : ""}
                    </Text>
                    <Text color={statusColor(state)} wrap="truncate-end">
                      {" "}
                      ● {state}
                    </Text>
                  </Box>
                );
              })}
              {!compact && lane.cards.length > capacity && (
                <Text dimColor wrap="truncate-end">
                  {offset + 1} to {Math.min(offset + capacity, lane.cards.length)} of {lane.cards.length} ·
                  ↑/↓
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Text dimColor wrap="truncate-end">
        Stages {start + 1} to {start + visible} of {lanes.length} · ←/→{total === 0 ? " · n new card" : ""}
      </Text>
    </Box>
  );
}
