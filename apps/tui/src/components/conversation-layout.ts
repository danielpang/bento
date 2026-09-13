import type { AgentEvent } from "@bento/core";
import type { RunArtifact, Stage } from "@bento/api-client";
import { terminalText } from "../terminal.js";
import stringWidth from "string-width";
import { toolActivity, toolDetail, type ToolActivity } from "./tool-activity.js";

/** Prefer word boundaries while keeping every character and whole grapheme clusters. */
export function wrapConversationText(lines: string[], width: number): string[] {
  const limit = Math.max(4, width);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return lines.flatMap((text) =>
    terminalText(text)
      .replace(/\t/g, "    ")
      .split("\n")
      .flatMap((line) => {
        const chars = [...segmenter.segment(line)].map(({ segment }) => segment);
        if (!chars.length) return [""];
        const result: string[] = [];
        for (let start = 0; start < chars.length; ) {
          let end = start,
            cells = 0,
            boundary = start;
          while (end < chars.length && cells + stringWidth(chars[end]!) <= limit) {
            cells += stringWidth(chars[end]!);
            if (/\s/.test(chars[end]!) && chars.slice(start, end).some((char) => /\S/.test(char)))
              boundary = end + 1;
            end++;
          }
          if (end < chars.length && boundary > start) end = boundary;
          end = Math.max(start + 1, end);
          result.push(chars.slice(start, end).join(""));
          start = end;
        }
        return result;
      }),
  );
}

export interface ConversationEntry {
  kind: "user" | "assistant" | "system" | "tool" | "run";
  label: string;
  text: string;
  detail?: string;
  failed?: boolean;
  id?: string;
  running?: boolean;
  tool?: ToolActivity;
}
export interface ConversationLine {
  text: string;
  color: "cyan" | "magenta" | "gray" | "white" | "red" | "green";
  bold?: boolean;
  toolGroup?: string;
  spinning?: boolean;
  tool?: ToolActivity;
}

export function conversationEvent(event: AgentEvent, agent: string): ConversationEntry[] {
  switch (event.type) {
    case "message":
      return [
        {
          kind: event.role,
          label: event.role === "user" ? "You" : event.role === "assistant" ? agent : "System",
          text: event.text,
        },
      ];
    case "tool":
      const tool = toolActivity(event);
      return [
        {
          kind: "tool",
          label: tool.summary,
          text: "",
          detail: toolDetail(tool),
          tool,
        },
      ];
    case "result":
      return [
        {
          kind: "system",
          label: event.ok ? "✓ Run succeeded" : "! Run failed",
          text: event.ok ? "" : (event.error ?? "No details"),
          failed: !event.ok,
        },
      ];
    default:
      return [];
  }
}

/** Match results to their calls without moving the surrounding assistant messages. */
export function mergeConversationTools(entries: ConversationEntry[]): ConversationEntry[] {
  const output: ConversationEntry[] = [];
  const calls = new Map<string, ConversationEntry>();
  let scope = "conversation",
    running = true,
    ordinal = 0;
  for (const entry of entries) {
    if (entry.kind === "run") {
      scope = entry.id ?? entry.label;
      running = entry.running ?? false;
      ordinal = 0;
      calls.clear();
    }
    if (!entry.tool) {
      output.push(entry);
      continue;
    }
    const tool = { ...entry.tool, stopped: !running && entry.tool.phase === "start" };
    const previous = tool.id ? calls.get(tool.id) : undefined;
    if (previous?.tool) {
      const old = previous.tool;
      previous.tool = {
        ...old,
        ...tool,
        key: old.key!,
        name: tool.hasInput ? tool.name : old.name,
        summary: tool.hasInput ? tool.summary : old.summary,
        input: tool.input || old.input,
        output: tool.output || old.output,
      };
      previous.label = previous.tool.summary;
      previous.detail = toolDetail(previous.tool);
    } else {
      tool.key = `${scope}/${tool.id ? `id:${tool.id}` : `seq:${ordinal++}`}`;
      const next = { ...entry, tool, label: tool.summary, detail: toolDetail(tool) };
      output.push(next);
      if (tool.id) calls.set(tool.id, next);
    }
  }
  return output;
}

/** Render before paging so message boundaries and wrapped content share one scroll position. */
export function conversationLines(
  entries: ConversationEntry[],
  width: number,
  showTools: boolean,
  expanded: Readonly<Record<string, boolean>> = {},
): ConversationLine[] {
  const lines: ConversationLine[] = [];
  const add = (text: string, color: ConversationLine["color"], bold = false) =>
    lines.push({ text, color, bold });
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.kind === "tool") {
      const group: ConversationEntry[] = [entry];
      while (entries[index + 1]?.kind === "tool") group.push(entries[++index]!);
      const key = entry.tool?.key ?? `tools:${index - group.length + 1}`;
      const open = expanded[key] ?? showTools;
      const active = group.some((item) => item.tool?.phase === "start" && !item.tool.stopped);
      const failed = group.filter((item) => item.tool?.failed).length;
      lines.push({
        text: `${open ? "▾" : "▸"} ${active ? "Tool calling…" : "Tool calls"} · ${group.length} call${group.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""} · ${open ? "collapse" : "expand"}`,
        color: failed ? "red" : "cyan",
        toolGroup: key,
        spinning: active && !open,
      });
      if (open) add("  Click a call for inputs and results", "gray");
      if (open)
        for (const item of group) {
          const tool = item.tool;
          const mark = tool?.failed ? "!" : tool?.phase === "end" ? "✓" : tool?.stopped ? "·" : "→";
          for (const text of wrapConversationText([`${mark} ${item.label}`], width - 2))
            lines.push({
              text: `  ${text}`,
              color: tool?.failed ? "red" : "white",
              ...(tool ? { tool } : {}),
            });
        }
      continue;
    }
    const color = entry.failed
      ? "red"
      : entry.kind === "user"
        ? "cyan"
        : entry.kind === "assistant"
          ? "magenta"
          : entry.kind === "run"
            ? "cyan"
            : "gray";
    if (entry.kind === "run") {
      add("", "gray");
      for (const line of wrapConversationText([`◆ ${entry.label}`], width)) add(line, color, true);
      for (const line of wrapConversationText([entry.text], width)) if (line) add(line, "gray");
      add("─".repeat(Math.max(1, width)), "gray");
    } else if (entry.kind === "system") {
      for (const line of wrapConversationText(
        [entry.label, entry.text, ...(showTools && entry.detail ? [entry.detail] : [])].filter(Boolean),
        width - 2,
      ))
        add(`  ${line}`, color);
    } else {
      add("", "gray");
      for (const line of wrapConversationText([entry.label], width - 2)) add(`╭ ${line}`, color, true);
      let code = false;
      for (const line of wrapConversationText([entry.text], width - 2)) {
        if (line.startsWith("```")) code = !code;
        const heading = /^#{1,6} /.test(line);
        add(
          `│ ${heading ? line.replace(/^#{1,6} /, "") : line}`,
          code || line.startsWith("```") ? "green" : "white",
          heading,
        );
      }
      add("╰", color);
    }
  }
  return lines.map((line) => ({ ...line, text: terminalText(line.text) }));
}

export function artifactStages(artifacts: RunArtifact[], stages: Stage[]) {
  const groups = new Map(
    stages.map((stage) => [
      stage.slug,
      { slug: stage.slug, name: stage.name, artifacts: [] as RunArtifact[] },
    ]),
  );
  for (const artifact of artifacts) {
    const group = groups.get(artifact.stageSlug) ?? {
      slug: artifact.stageSlug,
      name: artifact.stageName,
      artifacts: [],
    };
    group.artifacts.push(artifact);
    groups.set(group.slug, group);
  }
  return [...groups.values()];
}
