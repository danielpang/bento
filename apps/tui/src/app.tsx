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
import { Kanban, boardLanes, kanbanSelection, moveKanban } from "./components/Kanban.js";
import { describeCriterion } from "./criteria.js";
import { Login } from "./components/Login.js";
import { Setup } from "./components/Setup.js";
import { Startup } from "./components/Startup.js";
import { FileTokenStore } from "./credentials.js";
import type { CliOptions } from "./cli-options.js";
import { startEmbedded, type EmbeddedHandle } from "./embedded.js";
import { LocalRunner } from "./runner.js";
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
  if (!baseUrl) return <Startup message={bootMessage} />;

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
  const [connectionFailed, setConnectionFailed] = useState(false);

  const { rows: terminalRows, columns: terminalColumns } = useWindowSize();
  const compactBoard = terminalRows < 24 || terminalColumns < 70;
  const [focusedLaneId, setFocusedLaneId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const projectRef = useRef<string | null>(null);
  const refreshSerial = useRef(0);
  const [beta, setBeta] = useState(false);
  const [serverMode, setServerMode] = useState<"local" | "multi">("local");
  const [workbench, setWorkbench] = useState<WorkbenchPage | null>(null);
  const [activity, setActivity] = useState(false);
  const actionRef = useRef<(input: string) => void>(() => {});
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [runStatus, setRunStatus] = useState<Record<string, string | undefined>>({});
  // By id, not index: a board event can move a card between lanes, and
  // lanes would silently move the highlight to a different card.
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
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
      setConnectionFailed(false);
      setScreen("loading");
      const health = await client.health();
      setServerMode(health.mode === "multi" ? "multi" : "local");
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
      // A wrong server URL often returns an entire HTML page. Keep response
      // bodies out of the connection screen and show an actionable message.
      setConnectionFailed(true);
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
      setNotice("No projects yet. Press p to create one, or comma to open settings.");
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

  const lanes = boardLanes(stages, features);
  const columnSelection = kanbanSelection(lanes, selectedFeatureId, focusedLaneId);
  const current = columnSelection.feature;
  const boardRoot = useRef<DOMElement | null>(null);
  const mouseSelection = useRef({ cardId: current?.id ?? null, laneId: columnSelection.lane.id });
  mouseSelection.current = { cardId: current?.id ?? null, laneId: columnSelection.lane.id };
  const mouse = useBoardMouse({
    enabled: screen === "board" && !workbench && !activity && !deleteConfirm && !connectionFailed,
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
    },
  });

  // Said out loud, and the id written back, so the selection is a card
  // that exists rather than one the board is quietly pretending about.
  useEffect(() => {
    if (!selectedFeatureId || features.some((f) => f.id === selectedFeatureId)) return;
    setSelectedFeatureId(current?.id ?? null);
    setNotice("That card was deleted.");
  }, [features, selectedFeatureId, current?.id]);

  const runActive = ["queued", "starting", "running"].includes(
    runStatus[current?.id ?? ""] ?? latestRunStatus,
  );
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
    setHistory([]);
    setDeleteConfirm(null);
  }, [current?.id]);

  // Read the selected card's run state for board actions. Conversation owns transcript streaming.
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
        // A card with no runs must not inherit the previous card's run actions.
        setLatestRunId(null);
        setLatestRunStatus("");
        return;
      }
      setRunStatus((prev) => ({ ...prev, [current.id]: latest.status }));
      setLatestRunId(latest.id);
      setLatestRunStatus(latest.status);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [current?.id, features, screen, workbench]);

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
    if (connectionFailed) {
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
    if (
      key.leftArrow ||
      key.rightArrow ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      input === "j" ||
      input === "k" ||
      input === "g" ||
      input === "G"
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
    if ((input === "v" || input === "e") && projectId) {
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

  if (connectionFailed) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} paddingY={1}>
        <Text bold color="red">
          Could not connect to Bento at {terminalText(baseUrl)}
        </Text>
        <Text>Check the server URL and make sure Bento is running there.</Text>
        <Text color="gray">For hosted Bento, run: bento --server https://app.usebento.ai</Text>
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
    setHistory([]);
    setBeta(false);
    setNotice("");
    setConnectionFailed(false);
    setScreen(signedOut ? "login" : "loading");
    if (!signedOut) await connect();
  }

  if (screen === "loading") return <Startup message={`Connecting to ${baseUrl}...`} />;
  if (screen === "setup" && !workbench) {
    return (
      <Setup
        client={client}
        repositoryPathOwner={repositoryPathOwnerForMode(options.mode)}
        agentsRunLocally={options.mode !== "client"}
        selectedProjectId={projectId ?? options.project}
        serverMode={serverMode}
        onSection={setWorkbench}
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

      {!deleteConfirm && (
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
              ? "←/→ stages · ↑/↓ cards · v sessions"
              : "←/→ stages · ↑/↓ cards · Enter read · / search · v sessions · : commands"}
          </Text>
          {!deleteConfirm && (
            <MouseActions>
              <MouseButton label="Commands" onClick={() => handleInput(":")} />
              <MouseButton label="Projects" onClick={() => handleInput("p")} />
              <MouseButton label="Settings" onClick={() => handleInput(",")} />
              <MouseButton label="New" onClick={() => handleInput("n")} />
              <MouseButton label="Sessions" onClick={() => handleInput("v")} disabled={!projectId} />
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
