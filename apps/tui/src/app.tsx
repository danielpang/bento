import { useKeyboardInput as useInput } from "./mouse.js";
import { useBoardMouse } from "./mouse.js";
import { MouseActions, MouseButton } from "./components/MouseControls.js";
import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useStdin, useWindowSize, usePaste, type DOMElement } from "ink";
import {
  ApiError,
  BentoClient,
  type AgentProfile,
  type AgentRun,
  type Feature,
  type FeatureEvent,
  type FeatureMergeStatus,
  type GateState,
  type Project,
  type Stage,
} from "@bento/api-client";
import { actorDisplayName, forgetsBetweenRuns, hasNoLiveTranscript, historyTriggerLabel } from "@bento/core";
import { Workbench, type WorkbenchPage } from "./components/Workbench.js";
import { Reader } from "./components/Navigator.js";
import { terminalText } from "./terminal.js";
import { Board, cardState, orderFeatures, statusColor } from "./components/Board.js";
import { Kanban, boardLanes, kanbanSelection, moveKanban } from "./components/Kanban.js";
import { describeCriterion } from "./criteria.js";
import { Login } from "./components/Login.js";
import { Setup } from "./components/Setup.js";
import { FileTokenStore } from "./credentials.js";
import type { CliOptions } from "./cli-options.js";
import { startEmbedded, type EmbeddedHandle } from "./embedded.js";
import { LocalRunner } from "./runner.js";
import { RunnerNotice } from "./components/RunnerNotice.js";
import { describeMode } from "./cli-options.js";
import { repositoryPathOwnerForMode } from "./repository-path.js";

type Screen = "starting" | "loading" | "login" | "board" | "setup";

export function App({ options }: { options: CliOptions }) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [baseUrl, setBaseUrl] = useState(options.mode === "local" ? "" : options.server!);
  const [embedded, setEmbedded] = useState<EmbeddedHandle | null>(null);
  const [bootMessage, setBootMessage] = useState("Starting...");
  const [bootError, setBootError] = useState("");

  // Embedded mode brings up the database, orchestrator, and API in this
  // process before the board can talk to anything.
  useEffect(() => {
    if (options.mode !== "local") return;
    let cancelled = false;
    void startEmbedded(options, (message) => {
      if (!cancelled) setBootMessage(message);
    })
      .then((handle) => {
        if (cancelled) {
          void handle.stop();
          return;
        }
        setEmbedded(handle);
        setBaseUrl(handle.url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing has started, so there is no board to drive: the only key
  // worth binding is the one that leaves.
  useInput(
    (input) => {
      if (input === "q") exit();
    },
    { isActive: Boolean(bootError) && isRawModeSupported === true },
  );

  if (bootError) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} paddingY={1}>
        <Text bold color="red">
          Could not start Bento on this machine.
        </Text>
        <Text color="gray">{bootError}</Text>
        <Text>{startupRemedy(bootError)}</Text>
        <Box marginTop={1}>
          <Text color="gray">{isRawModeSupported ? "q quit" : "press Ctrl-C to quit"}</Text>
          <MouseButton label="Quit" onClick={() => exit()} />
        </Box>
      </Box>
    );
  }
  if (!baseUrl) return <Text color="gray">{bootMessage}</Text>;

  return <Console baseUrl={baseUrl} options={options} embedded={embedded} />;
}

/**
 * The fix for a failure to start, matched on the error the driver
 * threw. Local mode brings up a database and a container runtime, and
 * both fail in ways whose remedy is a flag away but nowhere in the
 * message the underlying tool produced.
 */
function startupRemedy(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes("docker") || lower.includes("/var/run/docker.sock")) {
    return "Start Docker Desktop, or pass --db <url> to use a Postgres you already run.";
  }
  if (lower.includes("eaddrinuse")) {
    return "Something already holds that port. Pass --port <number> for a different one, or stop the other process.";
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("password authentication") ||
    lower.includes("database")
  ) {
    return "Check the database is running and that --db <url> points at it.";
  }
  return "Run bento --help for the options. Passing --db <url> uses a Postgres you already run, which skips the container.";
}

/** Null stage means the backlog, or past the end of the pipeline. */
function describeEvent(event: FeatureEvent, stages: Stage[]): string {
  const name = (id: string | null) => (id ? (stages.find((s) => s.id === id)?.name ?? "removed") : "Backlog");
  if (event.kind === "stage_moved") {
    // The trigger tells the two null-destination stories apart: a
    // backward move went to the backlog, a forward one finished.
    if (!event.toStageId && event.fromStageId && !event.trigger.endsWith("_back")) {
      // Off the last stage is finishing it; off an earlier one is a card
      // marked done with stages left, which finished nothing.
      const last = stages[stages.length - 1];
      return last && event.fromStageId !== last.id
        ? `done from ${name(event.fromStageId)}`
        : `finished ${name(event.fromStageId)}`;
    }
    return `${name(event.fromStageId)} to ${name(event.toStageId)}`;
  }
  const why = event.detail?.failedCriteria?.length ? ` (${event.detail.failedCriteria.join(", ")})` : "";
  return `status ${event.fromStatus ?? "new"} to ${event.toStatus ?? "?"}${why}`;
}

function triggerLabel(event: FeatureEvent): string {
  return historyTriggerLabel(event.trigger, actorDisplayName(event.actorName, event.actorEmail));
}

/**
 * Why each held card is held.
 *
 * A card that says only "gated" tells you it stopped, not what would
 * start it again, and the answer is one line long. Manual stages
 * answer without asking the server at all, and only cards that are
 * actually held are asked, so a board that is moving costs nothing.
 */
async function gateWaits(
  client: BentoClient,
  stages: Stage[],
  features: Feature[],
  profiles: AgentProfile[],
): Promise<Record<string, string>> {
  const waits: Record<string, string> = {};
  await Promise.all(
    features
      .filter((feature) => feature.status === "gated")
      .map(async (feature) => {
        const stage = stages.find((s) => s.id === feature.currentStageId);
        if (stage && stage.gateType !== "auto") {
          waits[feature.id] = "waiting for your approval";
          return;
        }
        const gate = await client.getGate(feature.id).catch(() => null);
        waits[feature.id] = gate ? describeGateWait(gate, profiles) : "waiting at its gate";
      }),
  );
  return waits;
}

/**
 * Tools that hold a live session, and what a message means there. pi
 * steers the agent it is in the middle of; Claude Code queues behind
 * the current turn. Anything absent takes messages between runs. The
 * adapters decide this; the list is repeated here because the board
 * has to name it before the message is sent.
 */
const LIVE_TOOLS: Record<string, "steer" | "queue" | undefined> = {
  pi: "steer",
  "claude-code": "queue",
};

/**
 * What will happen to the text being typed. Saying it above the field
 * is the difference between taking over and hoping: the same keystroke
 * changes an agent's course, waits a turn, or waits for the run to end,
 * depending only on which tool is working.
 */
export function takeoverTitle(cli: string | undefined, active: boolean, name: string): string {
  if (!active) return `Nothing is running. Enter starts ${name} again with your instructions.`;
  switch (LIVE_TOOLS[cli ?? ""]) {
    case "steer":
      return `${name} is working. Your message steers it, changing course without finishing the current plan.`;
    case "queue":
      return `${name} is working. Your message is read after the current step, in the same conversation.`;
    default:
      return forgetsBetweenRuns(cli ?? "")
        ? `${name} is working. Your message is delivered the moment this run ends, as a new run with a compacted transcript of this conversation.`
        : `${name} is working. Your message is delivered the moment this run ends, as a resume of the same session.`;
  }
}

/**
 * The live log line for a tool that prints nothing until it exits.
 * Shared with the web quiet-run copy so the two clients cannot drift
 * the way FORGETS_BETWEEN_RUNS used to.
 */
export function quietRunStatus(cli: string | undefined, active: boolean): string | null {
  if (!active || !cli || !hasNoLiveTranscript(cli)) return null;
  return "No live output from this tool. It prints one final message when the run ends. That is the tool, not a stall.";
}

/** The requirements standing between this card and the next stage. */
function describeGateWait(gate: GateState, profiles: AgentProfile[]): string {
  const failed = gate.checks.filter((check) => check.status === "failed");
  const outstanding = failed.length > 0 ? failed : gate.checks.filter((check) => check.status === "pending");
  if (outstanding.length === 0) return "waiting for your approval";
  const named = outstanding.map((check) => describeCriterion(check.criterion, profiles));
  const rest = named.length > 2 ? `, and ${named.length - 2} more` : "";
  return `waiting: ${named.slice(0, 2).join(", ")}${rest}`;
}

export function Console({
  baseUrl,
  options,
  embedded,
}: {
  baseUrl: string;
  options: CliOptions;
  embedded: EmbeddedHandle | null;
}) {
  const { exit } = useApp();
  // Keyboard input needs a TTY. Without one (piped output, CI) the board
  // still renders and refreshes; it just cannot be driven by keys.
  const { isRawModeSupported } = useStdin();
  const [tokens] = useState(() => new FileTokenStore(baseUrl));
  const [client] = useState(() => new BentoClient({ baseUrl, tokens }));
  const [screen, setScreen] = useState<Screen>("loading");
  const [error, setError] = useState("");

  const { rows: terminalRows, columns: terminalColumns } = useWindowSize();
  const compactBoard = terminalRows < 24 || terminalColumns < 70;
  const [boardView, setBoardView] = useState<"kanban" | "list">("kanban");
  const [focusedLaneId, setFocusedLaneId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const projectRef = useRef<string | null>(null);
  const refreshSerial = useRef(0);
  const [beta, setBeta] = useState(false);
  const [workbench, setWorkbench] = useState<WorkbenchPage | null>(null);
  const [activity, setActivity] = useState(false);
  const actionRef = useRef<(input: string) => void>(() => {});
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [runStatus, setRunStatus] = useState<Record<string, string | undefined>>({});
  /** Why each held card is held, in words, so "gated" says what for. */
  const [gateWait, setGateWait] = useState<Record<string, string | undefined>>({});
  // By id, not index: a board event can move a card between lanes, and
  // lanes would silently move the highlight to a different card.
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string[]>([]);
  /**
   * The message the agent is typing right now, streamed as fragments.
   * The transcript endpoint cannot render it (fragments are never
   * persisted), so the draft lives here and is dropped the moment the
   * finished message makes it into the transcript.
   */
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<FeatureEvent[]>([]);
  const [setupHint, setSetupHint] = useState("");
  const [notice, setNotice] = useState("");
  const [offline, setOffline] = useState(false);

  // Notices expire: "Approved X" from an hour ago reads as new news.
  // Standing conditions (no projects, no agents) are re-set by every
  // periodic refresh, so they survive the expiry without special cases.
  useEffect(() => {
    if (!notice) return;
    // The sign in screen's notice says why that screen is up at all,
    // so it lasts as long as the screen does.
    if (screen === "login") return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice, screen]);
  const [runnerStatus, setRunnerStatus] = useState("Waiting for work");
  // A second D confirms. One press that removed a card (and its
  // sandbox) would be the wrong moment to learn there is no undo.
  const mutationPending = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Feature | null>(null);
  const [latestRunId, setLatestRunId] = useState<string | null>(null);
  const [cardRuns, setCardRuns] = useState<AgentRun[]>([]);
  const [latestRunStatus, setLatestRunStatus] = useState<string>("");
  const [mergeStates, setMergeStates] = useState<FeatureMergeStatus[]>([]);

  const queuedAction = useRef<{ key: string; featureId?: string | undefined } | null>(null);
  useEffect(() => {
    if (!workbench && queuedAction.current) {
      const action = queuedAction.current;
      queuedAction.current = null;
      if (action.featureId && !features.some((f) => f.id === action.featureId)) {
        setNotice("That card is no longer available.");
        return;
      }
      actionRef.current(action.key);
    }
  }, [workbench]);

  // Where to land once the server is reachable and, in multi mode,
  // signed in: the board normally, the credentials wizard for `setup`.
  const landing: Screen = options.command === "setup" ? "setup" : "board";

  /** Leaving, with the embedded stack stopped first when there is one. */
  const quit = () => {
    void embedded?.stop().finally(() => exit());
    if (!embedded) exit();
  };

  // Local mode needs no sign in; multi mode requires a stored token.
  const connect = async () => {
    try {
      setError("");
      setScreen("loading");
      const health = await client.health();
      if (health.mode === "multi" && !(await tokens.get())) {
        setScreen("login");
        return;
      }
      setBeta((await client.flags().catch(() => ({ betaTesters: false }))).betaTesters);
      await refresh();
      setScreen(landing);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setScreen("login");
        setNotice("Your session expired. Sign in again.");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void connect();
  }, [client]);

  const refresh = async () => {
    const serial = ++refreshSerial.current;
    const projectRows = await client.listProjects();
    if (serial !== refreshSerial.current) return;
    setProjects(projectRows);
    const requested = projectRef.current ?? options.project;
    const project = projectRows.find((p) => p.id === requested || p.name === requested) ?? projectRows[0];
    if (!project) {
      projectRef.current = null;
      setProjectId(null);
      setProjectName("");
      setFeatures([]);
      setStages([]);
      setNotice("No projects yet. Press p to create one, or comma to open setup.");
      return;
    }
    if (requested && !projectRows.some((p) => p.id === requested || p.name === requested)) {
      setNotice(`Project ${requested} is unavailable. Opened ${project.name}. Press p to choose another.`);
    }
    projectRef.current = project.id;
    setProjectName(project.name);
    setProjectId(project.id);
    const [pipeline, featureRows, profileRows, statuses] = await Promise.all([
      client.getPipeline(project.id),
      client.listFeatures(project.id),
      client.listProfiles(),
      // Every card's run, not only the selected one's. Replaced whole
      // rather than merged, so a run that ended stops being reported
      // as running the moment the board next refreshes.
      client.getRunStatuses(project.id).catch(() => ({})),
    ]);
    if (serial !== refreshSerial.current || projectRef.current !== project.id) return;
    setStages(pipeline.stages);
    setFeatures(featureRows);
    setProfiles(profileRows);
    setRunStatus(statuses);
    const waits = await gateWaits(client, pipeline.stages, featureRows, profileRows);
    if (serial !== refreshSerial.current) return;
    setGateWait(waits);

    // A board with no agent cannot run anything, and the reason is not
    // visible from the cards, so say it here rather than let a person
    // press start and watch nothing happen.
    if (profileRows.length === 0) {
      setSetupHint("No coding agents yet. Press comma to choose a tool and model.");
    } else if (!pipeline.stages.some((stage) => stage.defaultAgentProfileId)) {
      setSetupHint("No stage has an agent. Press comma to assign one.");
    } else {
      setSetupHint("");
    }
  };

  const onRefreshError = (err: unknown) => {
    // An expired token is a login problem, not an outage; anything else
    // is said as an outage instead of freezing the board silently.
    if (err instanceof ApiError && err.status === 401) {
      setScreen("login");
      setNotice("Your session expired. Sign in again.");
      return;
    }
    setOffline(true);
  };

  useEffect(() => {
    if (screen !== "board") return;
    void refresh()
      .then(() => setOffline(false))
      .catch(onRefreshError);
    const timer = setInterval(
      () =>
        void refresh()
          .then(() => setOffline(false))
          .catch(onRefreshError),
      15000,
    );
    return () => clearInterval(timer);
  }, [screen]);

  useEffect(() => {
    if (screen !== "board" || !projectId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void refresh()
          .then(() => setOffline(false))
          .catch(onRefreshError);
      }, 150);
    };
    const stop = client.streamBoard(projectId, schedule, schedule);
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [client, projectId, screen]);

  // In runner mode this machine executes the agent runs the server holds
  // for it, so the board is shared but the containers are local.
  useEffect(() => {
    if (options.mode !== "runner" || (screen !== "board" && screen !== "setup")) return;
    const runner = new LocalRunner({
      baseUrl,
      tokens,
      runnerId: options.runnerId,
      sandbox: options.sandbox,
      dataDir: options.dataDir,
      onStatus: setRunnerStatus,
    });
    void runner.start();
    return () => runner.stop();
  }, [options.mode, screen === "board" || screen === "setup", baseUrl]);

  const ordered = orderFeatures(stages, features);
  const found = selectedFeatureId ? ordered.findIndex((f) => f.id === selectedFeatureId) : 0;
  /**
   * Where the selection sat while it still resolved.
   *
   * A card deleted in the web console leaves this terminal holding an
   * id that matches nothing. Falling back to index 0 put the highlight
   * on the first backlog card while selectedFeatureId kept the dead id,
   * so every per-card fetch went on 404ing into a swallowed catch and
   * the board answered nothing until somebody pressed j or k. The card
   * that took the deleted one's place is at the same index, and the one
   * before it when the deleted card was last.
   */
  const lastIndex = useRef(0);
  if (found >= 0) lastIndex.current = found;
  const selected = found >= 0 ? found : Math.max(0, Math.min(lastIndex.current, ordered.length - 1));
  const lanes = boardLanes(stages, features);
  const columnSelection = kanbanSelection(lanes, selectedFeatureId, focusedLaneId);
  const current = boardView === "kanban" ? columnSelection.feature : ordered[selected];
  const boardRoot = useRef<DOMElement | null>(null);
  const mouseSelection = useRef({ cardId: current?.id ?? null, laneId: columnSelection.lane.id });
  mouseSelection.current = { cardId: current?.id ?? null, laneId: columnSelection.lane.id };
  const mouse = useBoardMouse({
    enabled: screen === "board" && !workbench && !activity && !deleteConfirm && !error,
    root: boardRoot,
    onSelect: (target) => {
      const lane = lanes.find((lane) => lane.id === target.laneId);
      const cardId =
        target.cardId ??
        (lane?.cards.some((card) => card.id === mouseSelection.current.cardId)
          ? mouseSelection.current.cardId
          : (lane?.cards[0]?.id ?? null));
      if (target.laneId) setFocusedLaneId(target.laneId);
      if (cardId || target.laneId) {
        mouseSelection.current = { cardId, laneId: target.laneId ?? mouseSelection.current.laneId };
        setSelectedFeatureId(cardId);
      }
    },
    onOpen: (target) => {
      if (target.cardId) {
        setSelectedFeatureId(target.cardId);
        setWorkbench("conversation");
      }
    },
    onScroll: (target, direction) => {
      if (boardView === "kanban") {
        const laneId =
          direction === "left" || direction === "right"
            ? mouseSelection.current.laneId
            : (target.laneId ?? mouseSelection.current.laneId);
        const cardId =
          laneId === mouseSelection.current.laneId ? mouseSelection.current.cardId : (target.cardId ?? null);
        const next = moveKanban(lanes, cardId, laneId, direction);
        mouseSelection.current = next;
        setSelectedFeatureId(next.cardId);
        setFocusedLaneId(next.laneId);
      } else if (direction === "up" || direction === "down") {
        const index = ordered.findIndex((card) => card.id === mouseSelection.current.cardId);
        const cardId =
          ordered[Math.max(0, Math.min(ordered.length - 1, index + (direction === "up" ? -1 : 1)))]?.id ??
          null;
        mouseSelection.current.cardId = cardId;
        setSelectedFeatureId(cardId);
      }
    },
  });

  // Said out loud, and the id written back, so the selection is a card
  // that exists rather than one the board is quietly pretending about.
  useEffect(() => {
    if (!selectedFeatureId || features.some((f) => f.id === selectedFeatureId)) return;
    setSelectedFeatureId(current?.id ?? null);
    setNotice("That card was deleted.");
  }, [features, selectedFeatureId, current?.id]);

  /**
   * What the card has cost so far, and how much of it is known. Codex,
   * Cursor, and opencode print no cost, so a bare total would read as a
   * cheap card rather than an unmeasured one.
   */
  const spend = (() => {
    const finished = cardRuns.filter((r) => ["succeeded", "failed", "cancelled"].includes(r.status));
    if (finished.length === 0) return "";
    const measured = finished.filter((r) => r.costUsd !== null && r.costUsd !== undefined);
    if (measured.length === 0) return "cost not reported";
    const total = measured.reduce((sum, r) => sum + Number(r.costUsd), 0);
    const silent = finished.length - measured.length;
    return silent > 0 ? `$${total.toFixed(2)}+ (${silent} unmeasured)` : `$${total.toFixed(2)}`;
  })();

  /** The agent on the newest run, which decides what a message does to it. */
  const cardAgent = profiles.find((profile) => profile.id === cardRuns[0]?.agentProfileId);
  const runActive = ["queued", "starting", "running"].includes(
    runStatus[current?.id ?? ""] ?? latestRunStatus,
  );
  const quietLine = quietRunStatus(cardAgent?.cli, runActive);
  const latestSettledRunId =
    latestRunId && ["succeeded", "failed", "cancelled"].includes(latestRunStatus) ? latestRunId : null;
  const hasConflicts = mergeStates.some((state) => state.state === "conflicted");
  const canResolveConflicts = hasConflicts && current?.status !== "done" && current?.status !== "cancelled";

  /**
   * Merge state on its own cadence: when the selected card changes, and
   * again when a run settles. The board refresh must not ask GitHub;
   * that is a round trip per pull request per viewer. No pull requests
   * answers [] without a GitHub call.
   */
  useEffect(() => {
    if (!current) {
      setMergeStates([]);
      return;
    }
    let cancelled = false;
    setMergeStates([]);
    void client
      .getMergeStatus(current.id)
      .then((states) => {
        if (!cancelled) setMergeStates(states);
      })
      .catch(() => {
        if (!cancelled) setMergeStates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, current?.id, latestSettledRunId]);

  useEffect(() => {
    setLatestRunId(null);
    setLatestRunStatus("");
    setCardRuns([]);
    setTranscript([]);
    setHistory([]);
    setDraft("");
    setDeleteConfirm(null);
    transcriptCursor.current = null;
  }, [current?.id]);

  // Follow the selected card's newest run.
  useEffect(() => {
    if (!current || screen !== "board" || workbench) return;
    let cancelled = false;
    void (async () => {
      client
        .getHistory(current.id)
        .then((rows) => {
          if (!cancelled) setHistory(rows);
        })
        .catch(() => {});
      const detail = await client.getFeature(current.id);
      if (cancelled) return;
      setCardRuns(detail.runs);
      // The server sends runs newest first.
      const latest = detail.runs[0];
      if (cancelled) return;
      if (!latest) {
        // A card with no runs must also forget the previous card's:
        // stale latestRunId kept the live follow subscribed to it and
        // streamed another card's conversation into this pane.
        setLatestRunId(null);
        setLatestRunStatus("");
        setTranscript([]);
        return;
      }
      setRunStatus((prev) => ({ ...prev, [current.id]: latest.status }));
      setLatestRunId(latest.id);
      setLatestRunStatus(latest.status);
      const { cursor, lines } = await client.getTranscript(latest.id);
      if (cancelled) return;
      setTranscript(lines);
      transcriptCursor.current = { runId: latest.id, cursor };
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [current?.id, features, screen, workbench]);

  /**
   * Live follow of the run being watched. The periodic board refresh
   * above keeps working as the fallback; this subscription is what
   * makes output appear the moment it happens, and it carries the
   * fragments of the message being typed, which no transcript fetch
   * can ever return. Fragment bursts are coalesced on short timers so
   * the terminal is not redrawn per token.
   */
  const followedRunId = screen === "board" && !workbench && runActive ? latestRunId : null;
  const transcriptCursor = useRef<{ runId: string; cursor: number } | null>(null);
  useEffect(() => {
    setDraft("");
    if (!followedRunId) return;
    let stopped = false;
    let draftText = "";
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const dropDraft = () => {
      // Both halves, or a flush timer scheduled just before the drop
      // would put the stale text right back on screen.
      draftText = "";
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = null;
      }
      setDraft("");
    };
    const refetchTranscript = () => {
      refetchTimer ??= setTimeout(() => {
        refetchTimer = null;
        /**
         * From the cursor, not from zero: a chatty run fires this
         * four times a second, and re-reading the whole transcript
         * each time made the run cost quadratic in its own length.
         * The card-switch effect above resets the cursor whenever it
         * replaces the transcript outright.
         */
        const since = transcriptCursor.current?.runId === followedRunId ? transcriptCursor.current.cursor : 0;
        client
          .getTranscript(followedRunId, since)
          .then(({ cursor, lines }) => {
            if (stopped) return;
            // Another fetch replaced the transcript meanwhile; these
            // rows would double-append.
            const held = transcriptCursor.current;
            if (since > 0 && (held?.runId !== followedRunId || held.cursor !== since)) return;
            transcriptCursor.current = { runId: followedRunId, cursor };
            if (since > 0) setTranscript((prev) => [...prev, ...lines]);
            else setTranscript(lines);
          })
          .catch(() => {});
      }, 250);
    };
    const stop = client.streamRun(followedRunId, {
      onEvent: (event) => {
        if (stopped) return;
        // The persisted line supersedes the draft that previewed it.
        // Assistant lines and results only: the user's own steer says
        // nothing about the message still being typed, and clearing
        // on it froze the draft mid sentence.
        if (event.type === "result" || (event.type === "message" && event.role === "assistant")) {
          dropDraft();
        }
        refetchTranscript();
      },
      onDelta: (delta) => {
        if (stopped || delta.channel !== "text") return;
        // Offset zero starts a draft (new message or the server's
        // catch-up snapshot); anything else must continue this one.
        if (delta.offset === 0) draftText = delta.text;
        else if (delta.offset === draftText.length) draftText += delta.text;
        else return;
        draftTimer ??= setTimeout(() => {
          draftTimer = null;
          if (!stopped) setDraft(draftText);
        }, 150);
      },
      onDone: () => {
        if (stopped) return;
        dropDraft();
        refetchTranscript();
      },
      onError: () => {
        if (stopped) return;
        // The stream is gone (token rejected, connection dropped).
        // The periodic poll still covers the transcript; what must
        // not survive is a frozen half sentence posing as live.
        dropDraft();
      },
    });
    return () => {
      stopped = true;
      stop();
      if (draftTimer) clearTimeout(draftTimer);
      if (refetchTimer) clearTimeout(refetchTimer);
    };
  }, [client, followedRunId]);

  function mutate(work: () => Promise<unknown>, success: string) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setActionBusy(true);
    void work()
      .then(async () => {
        setNotice(success);
        await refresh().catch(onRefreshError);
      })
      .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        mutationPending.current = false;
        setActionBusy(false);
      });
  }

  usePaste(() => setNotice("Open a text field before pasting. Press n for a card or c for a message."), {
    isActive: isRawModeSupported === true && screen === "board" && !workbench && !activity,
  });

  const handleInput = (input: string, key: Partial<import("ink").Key> = {}) => {
    // The connection screen has no board to drive, and leaving is the
    // only thing it can offer.
    if (error) {
      if (input === "q") quit();
      if (input === "r") void connect();
      return;
    }
    if (screen !== "board") return;

    if (workbench || activity) return;
    if (deleteConfirm) {
      if (input === "y" || input === "D") {
        setDeleteConfirm(null);
        const target = deleteConfirm;
        mutate(() => client.deleteFeature(target.id), `Deleted ${target.title}`);
        return;
      }
      if (key.escape || input === "n") {
        setDeleteConfirm(null);
        setNotice("Kept the card.");
        return;
      }
      return;
    }

    if (input === ":" || input === "?" || (key.ctrl && input === "p")) {
      setWorkbench("commands");
      return;
    }
    if (input === "v") {
      if (current) setSelectedFeatureId(current.id);
      setBoardView((view) => (view === "kanban" ? "list" : "kanban"));
      return;
    }
    if (
      boardView === "kanban" &&
      (key.leftArrow ||
        key.rightArrow ||
        key.tab ||
        key.upArrow ||
        key.downArrow ||
        input === "j" ||
        input === "k" ||
        input === "g" ||
        input === "G")
    ) {
      const direction =
        key.leftArrow || (key.tab && key.shift)
          ? "left"
          : key.rightArrow || key.tab
            ? "right"
            : key.upArrow || input === "k"
              ? "up"
              : input === "g"
                ? "first"
                : input === "G"
                  ? "last"
                  : "down";
      const next = moveKanban(lanes, selectedFeatureId, focusedLaneId, direction);
      setFocusedLaneId(next.laneId);
      setSelectedFeatureId(next.cardId);
      return;
    }
    if (input === "/") {
      setWorkbench("search");
      return;
    }
    if (input === "p") {
      setWorkbench("projects");
      return;
    }
    if (input === ",") {
      setScreen("setup");
      return;
    }
    if (input === "u" && projectId) {
      setWorkbench("spend");
      return;
    }
    if (input === "e" && projectId) {
      setWorkbench("sessions");
      return;
    }
    if (input === "n") {
      setWorkbench(projectId ? "new" : "projects");
      return;
    }
    if (current && key.return) {
      setWorkbench("conversation");
      return;
    }
    if (current && input === "d") {
      setWorkbench("changes");
      return;
    }
    if (current && input === "h") {
      setActivity(true);
      return;
    }
    if (input === "q") quit();
    if (key.downArrow || input === "j") {
      setDeleteConfirm(null);
      setSelectedFeatureId(ordered[Math.min(selected + 1, ordered.length - 1)]?.id ?? null);
    }
    if (key.upArrow || input === "k") {
      setDeleteConfirm(null);
      setSelectedFeatureId(ordered[Math.max(selected - 1, 0)]?.id ?? null);
    }
    if (!current) return;
    if (mutationPending.current) return;
    const isDone = current.status === "done";
    const inAStage = Boolean(current.currentStageId) && !isDone;
    const finishedHint = "This card is finished. Press b to reopen it.";
    if (input === "D") {
      if (runActive) setNotice("An agent is working. Stop it with x before deleting the card.");
      else setDeleteConfirm(current);
      return;
    }
    if (input === "b") {
      if (!current.currentStageId && !isDone) setNotice("Already in the backlog.");
      else mutate(() => client.moveFeatureBack(current.id), isDone ? "Card reopened" : "Sent back a stage");
      return;
    }
    if (input === "x") {
      const run = cardRuns.find(
        (r) => r.featureId === current.id && ["queued", "starting", "running"].includes(r.status),
      );
      if (run) mutate(() => client.cancelRun(run.id), "Stopped the agent");
      else
        setNotice(
          runActive ? "Loading the active run. Try again in a moment." : "No agent is running on this card.",
        );
      return;
    }
    if (isDone) {
      if ("acsfmRr".includes(input) && input) setNotice(finishedHint);
      return;
    }
    if (current.status === "cancelled") {
      setNotice("This card was cancelled.");
      return;
    }
    if (input === "c") {
      if (cardRuns.some((r) => r.featureId === current.id)) setWorkbench("message");
      else setWorkbench("agents");
    }
    if (input === "a")
      mutate(
        () => (inAStage ? client.approveFeature(current.id) : client.advanceFeature(current.id)),
        inAStage ? "Card approved" : "Pipeline started",
      );
    if (input === "R") {
      if (inAStage) setWorkbench("reject");
      else setNotice("No stage to reject. Press a to start the pipeline.");
    }
    if (input === "r") {
      if (inAStage) mutate(() => client.recheckGate(current.id), "Rechecked the requirements");
      else setNotice("No gate to check. Press a to start the pipeline.");
    }
    if (input === "f") mutate(() => client.finishFeature(current.id), "Card marked done");
    if (input === "m") {
      if (runActive) setNotice("Wait for the agent to finish before resolving conflicts.");
      else if (!canResolveConflicts) setNotice("GitHub reports no merge conflicts on this card.");
      else
        mutate(
          () => client.resolveConflicts(current.id),
          "Resolving conflicts. The pull request updates when the agent finishes.",
        );
    }
    if (input === "s") {
      if (runActive) {
        setNotice("An agent is already working. Press c to send instructions.");
        return;
      }
      const profileId = stages.find((stage) => stage.id === current.currentStageId)?.defaultAgentProfileId;
      if (!inAStage || !profileId) {
        setWorkbench("agents");
        return;
      }
      mutate(() => client.startRun({ featureId: current.id, agentProfileId: profileId }), "Agent started");
    }
  };
  actionRef.current = (input) => handleInput(input);
  useInput(handleInput, { isActive: isRawModeSupported === true });

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} paddingY={1}>
        <Text bold color="red">
          Could not reach {baseUrl}
        </Text>
        <Text color="gray">{error}</Text>
        <Text>Check the address, and that the server is running.</Text>
        <Box marginTop={1}>
          <Text color="gray">{isRawModeSupported ? "r retry · q quit" : "press Ctrl-C to quit"}</Text>
          <MouseActions>
            <MouseButton
              label="Retry"
              onClick={() => {
                void connect();
              }}
            />
            <MouseButton label="Quit" onClick={quit} />
          </MouseActions>
        </Box>
      </Box>
    );
  }
  async function resetSessionView(signedOut = false) {
    refreshSerial.current += 1;
    projectRef.current = null;
    setWorkbench(null);
    setActivity(false);
    setProjects([]);
    setProjectId(null);
    setProjectName("");
    setFeatures([]);
    setStages([]);
    setProfiles([]);
    setSelectedFeatureId(null);
    setFocusedLaneId(null);
    setRunStatus({});
    setGateWait({});
    setTranscript([]);
    setDraft("");
    setHistory([]);
    setBeta(false);
    setNotice("");
    setError("");
    setScreen(signedOut ? "login" : "loading");
    if (!signedOut) await connect();
  }

  if (screen === "loading") return <Text color="gray">Connecting to {baseUrl}...</Text>;
  if (screen === "setup") {
    return (
      <Setup
        client={client}
        repositoryPathOwner={repositoryPathOwnerForMode(options.mode)}
        agentsRunLocally={options.mode !== "client"}
        selectedProjectId={projectId ?? options.project}
        // Setup is a screen, not a program: everything it configures is
        // for the board, which is already running behind it.
        onDone={() => setScreen("board")}
      />
    );
  }
  if (screen === "login") {
    return (
      <Login
        baseUrl={baseUrl}
        {...(notice ? { notice } : {})}
        onToken={(token) => {
          void tokens
            .set(token)
            .then(() => resetSessionView())
            .catch((err: unknown) => {
              setNotice(err instanceof Error ? err.message : String(err));
            });
        }}
        onQuit={quit}
      />
    );
  }

  if (workbench)
    return (
      <Workbench
        client={client}
        baseUrl={baseUrl}
        initial={workbench}
        project={projects.find((p) => p.id === projectId)}
        projects={projects}
        feature={current}
        features={features}
        stages={stages}
        profiles={profiles}
        beta={beta}
        onProject={(id) => {
          refreshSerial.current += 1;
          projectRef.current = id;
          setProjectId(id);
          setFeatures([]);
          setSelectedFeatureId(null);
          setFocusedLaneId(null);
          void refresh().catch(onRefreshError);
        }}
        onFeature={setSelectedFeatureId}
        onSetup={() => {
          setWorkbench(null);
          setScreen("setup");
        }}
        onAction={(key, featureId) => {
          if (featureId) setSelectedFeatureId(featureId);
          setWorkbench(null);
          queuedAction.current = { key, featureId };
        }}
        onClose={() => setWorkbench(null)}
        onChanged={refresh}
        onSessionChanged={resetSessionView}
      />
    );
  if (activity)
    return (
      <Reader
        title="Card activity"
        lines={history.map(
          (event) =>
            `${new Date(event.at).toLocaleString()} ${describeEvent(event, stages)} ${triggerLabel(event)}`,
        )}
        onClose={() => setActivity(false)}
      />
    );

  return (
    <Box ref={boardRoot} flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text wrap="truncate-end">
          <Text bold color="magenta">
            Bento
          </Text>{" "}
          <Text bold>{terminalText(projectName || "Workspace")}</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {describeMode(options, embedded?.sandbox)}
        </Text>
      </Box>
      {offline && (
        <Text color="yellow" wrap="truncate-end">
          Lost the connection to {baseUrl}. Retrying...
        </Text>
      )}

      {options.mode === "runner" && boardView === "list" && (
        <RunnerNotice server={options.server ?? baseUrl} sandbox={options.sandbox} />
      )}

      {boardView === "kanban" && !deleteConfirm && (
        <Kanban
          lanes={lanes}
          cardId={selectedFeatureId}
          laneId={focusedLaneId}
          runStatus={runStatus}
          mouse={mouse}
          width={Math.max(1, terminalColumns - 2)}
          height={Math.max(
            4,
            terminalRows -
              7 -
              Number(terminalColumns < 65) -
              Number(offline) -
              Number(actionBusy) -
              Number(Boolean(notice || (!runActive && setupHint))) -
              Number(options.mode === "runner"),
          )}
        />
      )}
      {boardView === "list" && !(compactBoard && deleteConfirm) && (
        <Board
          stages={stages}
          features={features}
          profiles={profiles}
          selectedIndex={selected}
          runStatus={runStatus}
          gateWait={gateWait}
          mouse={mouse}
          maxRows={Math.max(1, terminalRows - (compactBoard ? 10 : 18) - Number(terminalColumns < 65))}
        />
      )}

      {current && boardView === "list" && !compactBoard && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Text wrap="truncate-end">
            <Text color={statusColor(cardState(current, runStatus[current.id] ?? latestRunStatus))}>
              {cardState(current, runStatus[current.id] ?? latestRunStatus)}
            </Text>
            {" · "}
            <Text bold>{terminalText(current.title)}</Text>
          </Text>
          {spend && (
            <Text dimColor wrap="truncate-end">
              {spend}
            </Text>
          )}
          {canResolveConflicts && (
            <Text color="yellow">
              GitHub cannot merge{" "}
              {mergeStates.filter((s) => s.state === "conflicted").length === 1
                ? "this card's pull request"
                : "some of this card's pull requests"}
              : the base branch has moved and the changes collide. Press m to resolve conflicts.
            </Text>
          )}
          {!runActive && gateWait[current.id] && (
            <Text color="yellow" wrap="truncate-end">
              {terminalText(gateWait[current.id]!)}
            </Text>
          )}
          <Text bold color="gray">
            Agent output · Enter for full conversation
          </Text>
          {transcript.length > 3 && <Text color="gray">... {transcript.length - 3} earlier lines</Text>}
          {transcript.slice(-3).map((line, i) => (
            <Text key={i} color="gray" wrap="truncate-end">
              {terminalText(line).replaceAll(/\s+/g, " ")}
            </Text>
          ))}
          {draft !== "" && (
            // The typing edge of the message in progress: its tail,
            // because that is where the new words appear. Flattened
            // to one line; embedded newlines grew the fixed pane
            // and bounced the panels below it on every flush.
            <Text wrap="truncate-end">
              {terminalText(`${cardAgent?.name ?? "agent"}> ${draft}`)
                .replaceAll(/\s+/g, " ")
                .slice(-100)}
            </Text>
          )}
          {quietLine && draft === "" && <Text color="gray">{quietLine}</Text>}
          {!quietLine && transcript.length === 0 && draft === "" && <Text color="gray">No output yet.</Text>}
        </Box>
      )}

      {deleteConfirm && (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red" wrap="truncate-end">
            Delete {terminalText(deleteConfirm.title)}?
          </Text>
          <Text color="gray">
            {compactBoard
              ? "Deletes this card permanently."
              : "It leaves the board for everyone. The branch and any pull request stay. There is no undo."}
          </Text>
          <Text color="gray">y delete · n cancel</Text>
          <MouseActions>
            <MouseButton label="Cancel" onClick={() => handleInput("n")} />
            <MouseButton label="Delete card" onClick={() => handleInput("y")} danger />
          </MouseActions>
        </Box>
      )}
      {options.mode === "runner" && <Text color="cyan">runner: {runnerStatus}</Text>}
      {!notice && !runActive && setupHint && (
        <Text dimColor wrap="truncate-end">
          {setupHint}
        </Text>
      )}
      {actionBusy && <Text color="cyan">Saving…</Text>}
      {notice && (
        <Text color="yellow" wrap="truncate-end">
          {terminalText(notice)}
        </Text>
      )}
      {/*
        Two lines, grouped by what they do. One line of every key ran
        past eighty columns and wrapped mid-word, which is where the
        shift on reject was getting lost.
      */}
      {isRawModeSupported ? (
        <Box flexDirection="column">
          <Text color="gray" wrap="truncate-end">
            {compactBoard
              ? boardView === "kanban"
                ? "←/→ stages · ↑/↓ cards · v list"
                : "↑/↓ cards · v kanban · Enter read"
              : boardView === "kanban"
                ? "←/→ stages · ↑/↓ cards · Enter read · / search · v list · : commands"
                : "↑/↓ move · Enter read · / search · v kanban · : commands · p projects · , setup"}
          </Text>
          {!deleteConfirm && (
            <MouseActions>
              <MouseButton label="Commands" onClick={() => handleInput(":")} />
              <MouseButton label="Projects" onClick={() => handleInput("p")} />
              <MouseButton label="Setup" onClick={() => handleInput(",")} />
              <MouseButton label="New" onClick={() => handleInput("n")} />
              <MouseButton
                label={boardView === "kanban" ? "List" : "Kanban"}
                onClick={() => handleInput("v")}
              />
              <MouseButton label="Quit" onClick={quit} />
            </MouseActions>
          )}
        </Box>
      ) : (
        <Text color="gray">read only: no terminal input available</Text>
      )}
    </Box>
  );
}
