import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { BentoClient, Feature } from "@bento/api-client";
import type { AgentEvent } from "@bento/core";
import { Reader } from "./Navigator.js";
import { terminalText } from "../terminal.js";

export function eventLines(event: AgentEvent): string[] {
  switch (event.type) {
    case "message":
      return [`${event.role}> ${event.text}`, ""];
    case "tool":
      return [
        `${event.phase === "start" ? "→" : "✓"} ${event.name}`,
        ...(event.detail ? [JSON.stringify(event.detail, null, 2)] : []),
      ];
    case "result":
      return [event.ok ? "Run succeeded" : `Run failed: ${event.error ?? "No details"}`, ""];
    default:
      return [];
  }
}

/** Completed turns, live output, and pending messages in a single scrollable view. */
export function Conversation({
  client,
  feature,
  onClose,
  onMessage,
}: {
  client: BentoClient;
  feature: Feature;
  onClose: () => void;
  onMessage: () => void;
}) {
  const [history, setHistory] = useState<string[]>([]);
  const [live, setLive] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [run, setRun] = useState<{ id: string; cursor: number } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string[]>([]);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false;
    let serial = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const request = ++serial;
      try {
        const [conversation, detail] = await Promise.all([
          client.getConversation(feature.id),
          client.getFeature(feature.id),
        ]);
        const active = detail.runs.find((r) => ["queued", "starting", "running"].includes(r.status));
        const transcript = active ? await client.getTranscript(active.id) : null;
        if (stopped || request !== serial) return;
        setHistory([
          feature.description,
          "",
          ...conversation.blocks.flatMap((block) => [
            `${block.agentName} · ${block.status} · ${new Date(block.queuedAt).toLocaleString()}`,
            "",
            ...block.events.flatMap(eventLines),
          ]),
          ...(detail.runs.length > 30 ? ["Earlier runs are available in Run history."] : []),
        ]);
        setPending(conversation.pending.map((message) => `${message.status}> ${message.text}`));
        setLive(transcript?.lines ?? []);
        setRun(active && transcript ? { id: active.id, cursor: transcript.cursor } : null);
        setDraft("");
        setError("");
      } catch (error) {
        if (!stopped) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    const schedule = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 150);
    };
    reload.current = schedule;
    const stop = client.streamBoard(feature.projectId, schedule, schedule);
    void refresh();
    const poll = setInterval(schedule, 15000);
    return () => {
      stopped = true;
      serial++;
      stop();
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, [client, feature.id]);
  useEffect(() => {
    if (!run) return;
    let stopped = false;
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = client.streamRun(
      run.id,
      {
        onEvent: (event) => {
          if (stopped) return;
          setLive((previous) => [...previous, ...eventLines(event)]);
          if (event.type === "result" || (event.type === "message" && event.role === "assistant")) {
            text = "";
            clearTimeout(timer);
            timer = undefined;
            setDraft("");
          }
        },
        onDelta: (delta) => {
          if (stopped || delta.channel !== "text") return;
          if (delta.offset === 0) text = delta.text;
          else if (delta.offset === text.length) text += delta.text;
          else return;
          timer ??= setTimeout(() => {
            timer = undefined;
            if (!stopped) setDraft(text);
          }, 100);
        },
        onDone: () => {
          if (!stopped) reload.current();
        },
        onError: (error) => {
          if (!stopped) {
            text = "";
            clearTimeout(timer);
            timer = undefined;
            setDraft("");
            setError(error.message);
          }
        },
      },
      run.cursor,
    );
    return () => {
      stopped = true;
      stop();
      clearTimeout(timer);
    };
  }, [client, run]);
  return (
    <Box flexDirection="column">
      <Reader
        title={`${feature.title} · ${loading ? "Loading" : run ? "Live conversation" : "Conversation"}`}
        lines={[...history, ...live, ...(draft ? [`agent> ${draft}`] : []), ...pending]}
        onClose={onClose}
        follow
        onMessage={onMessage}
      />
      {error && <Text color="yellow">{terminalText(error)}. Retrying…</Text>}
    </Box>
  );
}
