import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useIsScreenReaderEnabled, useStdin, useStdout, useWindowSize } from "ink";
import type {
  AgentProfile,
  AgentRun,
  BentoClient,
  Feature,
  FeaturePullRequestRecord,
  RunArtifact,
  Stage,
} from "@bento/api-client";
import type { AgentEvent } from "@bento/core";
import { terminalSelectionHint, terminalText } from "../terminal.js";
import { useKeyboardInput, useMouseTarget } from "../mouse.js";
import { MouseActions, MouseButton } from "./MouseControls.js";
import { TextInput } from "./TextInput.js";
import { pastedPaths, readAttachment, MAX_ATTACHMENT_BYTES, type DraftAttachment } from "../attachments.js";
import { copyToClipboard, type ClipboardContent } from "../clipboard.js";
import { PullRequests, PullRequestSummary, usePullRequestStatus } from "./PullRequests.js";
import { Reader } from "./Navigator.js";
import { toolDetail, type ToolActivity } from "./tool-activity.js";
import {
  conversationEvent,
  conversationLines,
  mergeConversationTools,
  type ConversationLine,
  type ConversationEntry,
} from "./conversation-layout.js";

export interface ConversationViewState {
  following: boolean;
  offset: number;
  tools: boolean;
  toolGroups?: Record<string, boolean>;
  messageText?: string;
  composing?: boolean;
  attachments?: DraftAttachment[];
}

type History = Awaited<ReturnType<BentoClient["getConversation"]>>;

/** A conversation keeps its roles, stages and live turn instead of flattening into a log. */
export function Conversation({
  client,
  feature,
  stages,
  profiles,
  onClose,
  onMessageSent,
  initialCompose = false,
  allowAttachments = false,
  onArtifacts,
  initialView,
  onViewChange,
}: {
  client: BentoClient;
  feature: Feature;
  stages: Stage[];
  profiles: AgentProfile[];
  onClose: () => void;
  onMessageSent?: () => Promise<void>;
  initialCompose?: boolean;
  allowAttachments?: boolean;
  onArtifacts: (stageSlug?: string, artifactId?: string) => void;
  initialView?: ConversationViewState | undefined;
  onViewChange?: (view: ConversationViewState) => void;
}) {
  const { rows, columns } = useWindowSize();
  const { isRawModeSupported } = useStdin();
  const [history, setHistory] = useState<History>({ blocks: [], pending: [] });
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [live, setLive] = useState<AgentEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [artifactError, setArtifactError] = useState("");
  const [prHistory, setPrHistory] = useState<FeaturePullRequestRecord[]>([]);
  const [prPicker, setPrPicker] = useState<{ url?: string } | null>(null);
  const prs = usePullRequestStatus(client, feature.id, prHistory);
  const [tools] = useState(initialView?.tools ?? false);
  const [toolGroups, setToolGroups] = useState(initialView?.toolGroups ?? {});
  const [selectedTool, setSelectedTool] = useState<ToolActivity | null>(null);
  const [toolFeedback, setToolFeedback] = useState("");
  const [following, setFollowing] = useState(initialView?.following ?? true);
  const [offset, setOffset] = useState(initialView?.offset ?? 0);
  const [messageText, setMessageText] = useState(initialView?.messageText ?? "");
  const [composing, setComposing] = useState(initialCompose || (initialView?.composing ?? false));
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [delivery, setDelivery] = useState("");
  const [attachments, setAttachments] = useState(initialView?.attachments ?? []);
  const pastePending = useRef(false);
  const [pasting, setPasting] = useState(false);
  const attachmentDraft = useRef(attachments);
  attachmentDraft.current = attachments;
  const sendingRef = useRef(false);
  const stoppingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    onViewChange?.({ following, offset, tools, toolGroups, messageText, composing, attachments });
  }, [following, offset, tools, toolGroups, messageText, composing, attachments, onViewChange]);
  async function acceptPaste(content: ClipboardContent): Promise<boolean> {
    if (sendingRef.current) return true;
    const paths = content.files ?? (content.text ? pastedPaths(content.text) : null);
    if (!paths && !content.image) return false;
    if (!allowAttachments) {
      if (content.text || content.files) return false;
      throw new Error("Image attachments are not enabled on this server.");
    }
    let added: DraftAttachment[];
    try {
      added = content.image ? [content.image] : await Promise.all(paths!.map(readAttachment));
    } catch (error) {
      if (content.text && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const next = [...attachmentDraft.current, ...added];
    if (
      next.length > 3 ||
      next.some((file) => Buffer.byteLength(file.data, "base64") > MAX_ATTACHMENT_BYTES) ||
      next.reduce((size, file) => size + Buffer.byteLength(file.data, "base64"), 0) > 8 * 1024 * 1024
    )
      throw new Error("Attach up to 3 files, 5 MB each and 8 MB total.");
    attachmentDraft.current = next;
    setAttachments(next);
    setComposing(true);
    setMessageError("");
    return true;
  }
  const reload = useRef<() => void>(() => {});
  const focusComposer = () => {
    setComposing(true);
  };
  const openArtifacts = (slug?: string, artifactId?: string) => {
    if (!sendingRef.current) onArtifacts(slug, artifactId);
  };
  const close = () => {
    if (!sendingRef.current) onClose();
  };
  async function sendMessage(value: string) {
    if (sendingRef.current || pastePending.current || (!value.trim() && !attachments.length)) return;
    if (value.trim().length > 20000) {
      setMessageError("Messages can contain at most 20,000 characters.");
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setMessageError("");
    setDelivery("");
    try {
      const result = await client.messageFeature(feature.id, value.trim(), attachments);
      if (!mounted.current) return;
      setMessageText("");
      setAttachments([]);
      attachmentDraft.current = [];
      setDelivery(
        result.queued
          ? "Queued. The agent reads it when this run ends."
          : result.live
            ? result.delivery === "steer"
              ? "Sent. The agent is changing course now."
              : "Sent. The agent reads it after the current step."
            : "Sent. Continuing with your instructions.",
      );
      setFollowing(true);
      reload.current();
      // A board refresh failure must never turn a successful send into a retry.
      void Promise.resolve()
        .then(onMessageSent)
        .catch(() => {});
    } catch (error) {
      if (mounted.current) setMessageError(error instanceof Error ? error.message : String(error));
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  }
  async function stopAgent() {
    if (!run || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    setMessageError("");
    setDelivery("");
    try {
      await client.cancelRun(run.id);
      if (!mounted.current) return;
      setRun(null);
      setDelivery("Stopped the agent.");
      setFollowing(true);
      reload.current();
      // Keep the board card and every other run control in sync too.
      void Promise.resolve()
        .then(onMessageSent)
        .catch(() => {});
    } catch (error) {
      if (mounted.current) setMessageError(error instanceof Error ? error.message : String(error));
    } finally {
      stoppingRef.current = false;
      if (mounted.current) setStopping(false);
    }
  }
  useEffect(() => {
    let stopped = false;
    let serial = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const request = ++serial;
      const artifactRequest = client
        .listArtifacts(feature.id)
        .then((items) => {
          if (!stopped && request === serial) {
            setArtifacts(items);
            setArtifactError("");
          }
        })
        .catch(() => {
          if (!stopped && request === serial) setArtifactError("Artifacts unavailable. Press a to retry.");
        });
      try {
        const [conversation, detail] = await Promise.all([
          client.getConversation(feature.id),
          client.getFeature(feature.id),
        ]);
        if (stopped || request !== serial) return;
        setHistory(conversation);
        setRuns(detail.runs);
        setPrHistory(detail.pullRequestHistory ?? []);
        setRun(detail.runs.find((r) => ["queued", "starting", "running"].includes(r.status)) ?? null);
        setError("");
      } catch (error) {
        if (!stopped && request === serial) setError(error instanceof Error ? error.message : String(error));
      } finally {
        await artifactRequest;
        if (!stopped && request === serial) setLoading(false);
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
  }, [client, feature.id, feature.projectId]);
  const runId = run?.id;
  useEffect(() => {
    setLive([]);
    setDraft("");
    if (!runId) return;
    let stopped = false;
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Replay structured events, then follow the same stream. Roles and tool details survive reconnects.
    const stop = client.streamRun(
      runId,
      {
        onEvent: (event) => {
          if (stopped) return;
          setLive((previous) => [...previous, event]);
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
      0,
    );
    return () => {
      stopped = true;
      stop();
      clearTimeout(timer);
    };
  }, [client, runId]);

  const stage = stages.find((stage) => stage.id === feature.currentStageId);
  const agent = profiles.find((profile) => profile.id === run?.agentProfileId)?.name ?? "Agent";
  const sidebar = columns >= 110 && rows >= 30;
  const compact = rows < 20 || columns < 70;
  const sidebarWidth = 30;
  const timelineWidth = Math.max(12, columns - (sidebar ? sidebarWidth + 1 : 0));
  const headerHeight = compact ? 3 : 4;
  const editorRows = Math.max(1, Math.min(composing ? 4 : 2, rows - 16));
  // MouseActions has a one-row gap between wrapped rows, as well as between buttons.
  const actionLabels = [
    composing ? "Send" : "Message",
    ...(run ? [stopping ? "Stopping…" : "Stop"] : []),
    ...(!compact && composing ? ["History"] : []),
    "PRs",
    "Artifacts",
    ...(!compact ? ["Follow", "Back"] : []),
  ];
  let buttonRows = 1,
    buttonWidth = 0;
  for (const label of actionLabels) {
    const size = label.length + 2;
    if (buttonWidth && buttonWidth + 1 + size > columns - 4) {
      buttonRows++;
      buttonWidth = 0;
    }
    buttonWidth += size + Number(buttonWidth > 0);
  }
  const actionRows = buttonRows * 2 - 1;
  const footerHeight = 4 + editorRows + actionRows;
  const bodyHeight = Math.max(3, rows - headerHeight - footerHeight);
  const prLimit = Math.max(0, Math.min(prs.rows.length, Math.floor((bodyHeight - 13) / 4)));
  const prHeight = 5 + (prLimit ? prLimit * 4 : 1);
  const showTimelineHeader = bodyHeight > 3;
  const viewport = Math.max(1, bodyHeight - 2 - Number(showTimelineHeader));
  const entries = useMemo(() => {
    const output: ConversationEntry[] = [];
    if (runs.length > 30)
      output.push({ kind: "system", label: "Earlier runs are available in Run history.", text: "" });
    if (feature.description)
      output.push({ kind: "user", label: "You · Card brief", text: feature.description });
    const runHeader = (id: string, name: string, status: string, queuedAt: string): ConversationEntry => {
      const row = runs.find((run) => run.id === id);
      const stageName =
        stages.find((stage) => stage.id === row?.stageId)?.name ??
        artifacts.find((artifact) => artifact.runId === id)?.stageName ??
        "Earlier stage";
      return {
        kind: "run",
        id,
        running: ["queued", "starting", "running"].includes(status),
        label: `${stageName} · ${name} · ${status}`,
        text: new Date(queuedAt).toLocaleString(),
      };
    };
    for (const block of history.blocks) {
      output.push(runHeader(block.runId, block.agentName, block.status, block.queuedAt));
      output.push(...block.events.flatMap((event) => conversationEvent(event, block.agentName)));
    }
    if (run) {
      output.push(runHeader(run.id, agent, run.status, run.queuedAt));
      output.push(...live.flatMap((event) => conversationEvent(event, agent)));
      if (draft) output.push({ kind: "assistant", label: `${agent} · Writing…`, text: draft });
      else if (!live.length) output.push({ kind: "system", label: "Waiting for agent output…", text: "" });
    }
    for (const message of history.pending)
      output.push({
        kind: "user",
        label: `You · ${message.status === "queued" ? "Queued for agent" : "Sent, awaiting reply"}`,
        text: message.text,
      });
    if (!output.length)
      output.push({
        kind: "system",
        label: loading ? "Loading conversation…" : "No messages yet. Press c to message the agent.",
        text: "",
      });
    return mergeConversationTools(output);
  }, [history, runs, run, live, draft, agent, feature.description, artifacts, stages, loading]);
  const inspectTool = (tool: ToolActivity) => {
    setToolFeedback("");
    setSelectedTool(tool);
  };
  const lines = useMemo(() => {
    const rendered = conversationLines(entries, timelineWidth - 4, tools, toolGroups);
    // Very short terminals should end on the reply, not only its closing border and success marker.
    if (compact)
      while (rendered.length && /^(?:╰|\s*✓ Run succeeded|\s*)$/.test(rendered.at(-1)!.text)) rendered.pop();
    return rendered;
  }, [entries, timelineWidth, tools, toolGroups, compact]);
  const max = Math.max(0, lines.length - viewport);
  const top = following ? max : Math.min(offset, max);
  const position = useRef(top);
  position.current = top;
  const scroll = (delta: number) => {
    setFollowing(false);
    position.current = Math.max(0, Math.min(max, position.current + delta));
    setOffset(position.current);
  };
  const mouse = useMouseTarget({
    onScroll: (event) => {
      if (event.kind === "up" || event.kind === "down") scroll(event.kind === "up" ? -3 : 3);
    },
  });
  useKeyboardInput(
    (input, key) => {
      if (selectedTool || prPicker) return;
      if (key.tab) {
        setComposing((value) => !value);
        return;
      }
      if (composing) return;
      if (key.escape || input === "q") close();
      else if (input === "c") focusComposer();
      else if (input === "x" && run) void stopAgent();
      else if (input === "a") openArtifacts();
      else if (input === "p") setPrPicker({});
      else if (key.upArrow || input === "k") scroll(-1);
      else if (key.downArrow || input === "j") scroll(1);
      else if (key.pageUp) scroll(-viewport);
      else if (key.pageDown || input === " ") scroll(viewport);
      else if (key.home || input === "g") {
        setFollowing(false);
        setOffset(0);
      } else if (key.end || input === "G") {
        setFollowing(true);
        setOffset(max);
      }
    },
    { isActive: isRawModeSupported === true },
  );

  if (prPicker)
    return (
      <PullRequests
        client={client}
        featureId={feature.id}
        rows={prs.rows}
        stage={stage}
        error={prs.error}
        initialUrl={prPicker.url}
        runActive={Boolean(run)}
        finished={feature.status === "done" || feature.status === "cancelled"}
        onRunStarted={() => {
          setPrPicker(null);
          setFollowing(true);
        }}
        onClose={() => setPrPicker(null)}
        onChanged={() => {
          reload.current();
          void onMessageSent?.().catch(() => {});
        }}
      />
    );

  if (selectedTool) {
    // Keep an open inspector current when a running call receives its result.
    const current = entries.find((entry) => entry.tool?.key === selectedTool.key)?.tool ?? selectedTool;
    return (
      <Reader
        title={current.summary}
        lines={toolDetail(current).split("\n").slice(2)}
        document
        description={toolFeedback || "Inputs and results · Esc returns to the conversation"}
        onClose={() => setSelectedTool(null)}
        actions={[
          {
            label: "Copy",
            onClick: () => {
              void copyToClipboard(toolDetail(current)).then(
                () => setToolFeedback("Copied to clipboard."),
                (error: Error) => setToolFeedback(error.message),
              );
            },
          },
        ]}
      />
    );
  }
  return (
    <Box flexDirection="column" height={Math.max(10, rows)} width={columns}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        height={headerHeight}
        flexShrink={0}
      >
        <Text bold wrap="truncate-end">
          {terminalText(feature.title)}
        </Text>
        {!compact && (
          <Text color="gray" wrap="truncate-end">
            {terminalText(stage?.name ?? (feature.status === "backlog" ? "Backlog" : feature.status))} ·{" "}
            {run ? `${terminalText(agent)} · ${run.status}` : "Conversation"}
          </Text>
        )}
      </Box>
      <Box height={bodyHeight} gap={sidebar ? 1 : 0} flexShrink={0}>
        <Box
          ref={mouse}
          width={timelineWidth}
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
        >
          {showTimelineHeader && (
            <Text color="gray" wrap="truncate-end">
              {loading ? "Loading…" : "Conversation"} ·{" "}
              {following
                ? run
                  ? "Following live output"
                  : "Latest messages"
                : "Reading history. G to follow"}
              {terminalSelectionHint() && ` · ${terminalSelectionHint()}`}
            </Text>
          )}
          <Box flexDirection="column" height={viewport} overflow="hidden">
            {lines.slice(top, top + viewport).map((line, i) => (
              <TimelineLine
                key={top + i}
                line={line}
                onClick={
                  line.toolGroup
                    ? () => {
                        const group = line.toolGroup!;
                        // Anchor the clicked group so expanding it does not jump to the bottom.
                        setFollowing(false);
                        setOffset(top + i);
                        setToolGroups((previous) => ({ ...previous, [group]: !(previous[group] ?? tools) }));
                      }
                    : line.tool
                      ? () => inspectTool(line.tool!)
                      : undefined
                }
              />
            ))}
          </Box>
        </Box>
        {sidebar && (
          <Box
            flexDirection="column"
            width={sidebarWidth}
            borderStyle="round"
            borderColor="gray"
            paddingX={1}
          >
            <Box flexDirection="column" height={prHeight} flexShrink={0}>
              <Text bold>Pull requests · {prs.rows.length}</Text>
              {prLimit ? (
                prs.rows
                  .slice(0, prLimit)
                  .map((pr) => (
                    <PullRequestSummary key={pr.url} pr={pr} onOpen={() => setPrPicker({ url: pr.url })} />
                  ))
              ) : (
                <Text color="gray">
                  {prs.rows.length ? "Press p to see all PRs" : "No pull requests yet"}
                </Text>
              )}
              <Text color="gray" wrap="truncate-end">
                Auto PR: {stage?.createPr ? "On" : "Off"}
              </Text>
              <MouseButton
                label={prs.rows.length ? `All PRs (${prs.rows.length})` : "Create PR / settings"}
                onClick={() => setPrPicker({})}
                disabled={sending}
              />
            </Box>
            <SidebarArtifacts
              items={artifacts}
              error={artifactError}
              height={Math.max(3, bodyHeight - prHeight - 2)}
              onOpen={(id) => openArtifacts(undefined, id)}
            />
          </Box>
        )}
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        height={footerHeight}
        flexShrink={0}
      >
        {attachments.length ? (
          <Box height={1}>
            <Box width={Math.max(1, columns - 14)}>
              <Text color="cyan" wrap="truncate-end">
                {attachments.length} files: {terminalText(attachments.map((file) => file.name).join(", "))}
              </Text>
            </Box>
            <MouseButton
              label="Remove"
              disabled={sending}
              onClick={() => {
                attachmentDraft.current = attachments.slice(0, -1);
                setAttachments(attachmentDraft.current);
              }}
            />
          </Box>
        ) : (
          <Text color={composing ? "cyan" : "gray"} bold={composing} wrap="truncate-end">
            {composing ? "Reply to agent" : "Reply · c, Tab or click to type"}
            {sending ? " · Sending…" : ""}
          </Text>
        )}
        <Box height={editorRows} flexShrink={0}>
          <TextInput
            value={messageText}
            onChange={(value) => {
              setMessageText(value);
              setMessageError("");
              setDelivery("");
            }}
            onSubmit={(value) => {
              void sendMessage(value);
            }}
            onCancel={() => setComposing(false)}
            onFocus={focusComposer}
            onPasteContent={acceptPaste}
            onClipboardError={setMessageError}
            onPastePending={(pending) => {
              pastePending.current = pending;
              setPasting(pending);
            }}
            multiline
            isActive={composing && !sending}
            visibleRows={editorRows}
            placeholder="Message the agent…"
          />
        </Box>
        <Box height={actionRows} flexShrink={0}>
          <MouseActions>
            {composing ? (
              <MouseButton
                label="Send"
                onClick={() => {
                  void sendMessage(messageText);
                }}
                disabled={sending || pasting || (!messageText.trim() && !attachments.length)}
              />
            ) : (
              <MouseButton label="Message" onClick={focusComposer} />
            )}
            {run && (
              <MouseButton
                label={stopping ? "Stopping…" : "Stop"}
                onClick={() => {
                  void stopAgent();
                }}
                disabled={stopping}
              />
            )}
            {!compact && composing && <MouseButton label="History" onClick={() => setComposing(false)} />}
            <MouseButton label="PRs" onClick={() => setPrPicker({})} disabled={sending} />
            <MouseButton label="Artifacts" onClick={() => openArtifacts()} disabled={sending} />
            {!compact && (
              <MouseButton
                label="Follow"
                onClick={() => {
                  setFollowing(true);
                  setOffset(max);
                }}
              />
            )}
            {!compact && <MouseButton label="Back" onClick={close} disabled={sending} />}
          </MouseActions>
        </Box>
        <Text
          color={messageError || error ? "yellow" : stopping ? "cyan" : delivery ? "green" : "gray"}
          wrap="truncate-end"
        >
          {messageError
            ? terminalText(messageError)
            : stopping
              ? "Stopping the agent…"
              : delivery ||
              (error
                ? `${terminalText(error)}. Retrying…`
                : composing
                  ? "Enter send · Ctrl+J newline · Esc history"
                  : `c reply${run ? " · x stop" : ""} · p PRs · a artifacts · g/G first/latest`)}
        </Text>
      </Box>
    </Box>
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function TimelineLine({ line, onClick }: { line: ConversationLine; onClick: (() => void) | undefined }) {
  const ref = useMouseTarget({ ...(onClick ? { onClick } : {}), priority: 1 }, Boolean(onClick));
  const { stdout } = useStdout();
  const screenReader = useIsScreenReaderEnabled();
  const [frame, setFrame] = useState(0);
  const animate = Boolean(line.spinning && stdout.isTTY && !screenReader && process.env.TERM !== "dumb");
  useEffect(() => {
    if (!animate) return;
    setFrame(0);
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [animate]);
  return (
    <Box ref={ref} height={1} flexShrink={0}>
      <Text
        color={line.color}
        bold={line.bold ?? Boolean(line.toolGroup)}
        underline={Boolean(line.tool)}
        wrap="truncate-end"
      >
        {animate
          ? `${line.text.slice(0, 2)}${SPINNER_FRAMES[frame]} ${line.text.slice(2)}`
          : line.text || " "}
      </Text>
    </Box>
  );
}

function SidebarArtifacts({
  items,
  error,
  height,
  onOpen,
}: {
  items: RunArtifact[];
  error: string;
  height: number;
  onOpen: (id: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const overflow = items.length > height - 2;
  const visible = Math.max(1, height - 2 - Number(overflow));
  const max = Math.max(0, items.length - visible);
  const top = Math.min(offset, max);
  const scroll = (delta: number) => setOffset((current) => Math.max(0, Math.min(max, current + delta)));
  const mouse = useMouseTarget({
    onScroll: (event) => {
      if (event.kind === "up" || event.kind === "down") scroll(event.kind === "up" ? -1 : 1);
    },
  });
  return (
    <Box ref={mouse} flexDirection="column" height={height} flexShrink={0}>
      <Text bold>Artifacts</Text>
      <Text color="gray">{items.length} files · click to open</Text>
      {error ? (
        <Text color="yellow" wrap="truncate-end">
          {error}
        </Text>
      ) : (
        <>
          <Box flexDirection="column" height={visible} overflow="hidden">
            {items.slice(top, top + visible).map((artifact) => (
              <ArtifactFile key={artifact.id} artifact={artifact} onOpen={() => onOpen(artifact.id)} />
            ))}
            {!items.length && <Text color="gray">No artifacts yet.</Text>}
          </Box>
          {overflow && (
            <MouseActions>
              <MouseButton label="↑" onClick={() => scroll(-visible)} disabled={top === 0} />
              <Text color="gray">
                {top + 1}-{Math.min(items.length, top + visible)}/{items.length}
              </Text>
              <MouseButton label="↓" onClick={() => scroll(visible)} disabled={top === max} />
            </MouseActions>
          )}
        </>
      )}
    </Box>
  );
}

function ArtifactFile({ artifact, onOpen }: { artifact: RunArtifact; onOpen: () => void }) {
  const mouse = useMouseTarget({ onClick: onOpen, priority: 1 });
  return (
    <Box ref={mouse} height={1} flexShrink={0} aria-role="button">
      <Text color="cyan" wrap="truncate-middle">
        {terminalText(artifact.path.split("/").pop() ?? artifact.path)}
      </Text>
    </Box>
  );
}
