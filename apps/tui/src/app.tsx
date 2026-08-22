import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import {
  ApiError,
  BentoClient,
  type AgentProfile,
  type AgentRun,
  type Feature,
  type FeatureEvent,
  type GateState,
  type Stage,
} from "@bento/api-client";
import { actorDisplayName, historyTriggerLabel } from "@bento/core";
import { Board, orderFeatures, statusColor } from "./components/Board.js";
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
  if (lower.includes("econnrefused") || lower.includes("password authentication") || lower.includes("database")) {
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
      return cli === "pool"
        ? `${name} is working. Your message is delivered the moment this run ends, as a new run.`
        : `${name} is working. Your message is delivered the moment this run ends, as a resume of the same session.`;
  }
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

function Console({
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

  const [projectName, setProjectName] = useState("");
  const [stages, setStages] = useState<Stage[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [runStatus, setRunStatus] = useState<Record<string, string | undefined>>({});
  /** Why each held card is held, in words, so "gated" says what for. */
  const [gateWait, setGateWait] = useState<Record<string, string | undefined>>({});
  // By id, not index: the board refetches every 3s and a card changing
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
  const [showHistory, setShowHistory] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [changeLines, setChangeLines] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [offline, setOffline] = useState(false);

  // Notices expire: "Approved X" from an hour ago reads as new news.
  // Standing conditions (no projects, no agents) are re-set by every
  // 3s refresh, so they survive the expiry without special cases.
  useEffect(() => {
    if (!notice) return;
    // The sign in screen's notice says why that screen is up at all,
    // so it lasts as long as the screen does.
    if (screen === "login") return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice, screen]);
  const [runnerStatus, setRunnerStatus] = useState("Waiting for work");
  // When set, keystrokes compose a follow-up prompt instead of driving
  // the board. This is how a person takes over from an agent.
  const [takeover, setTakeover] = useState<string | null>(null);
  const [latestRunId, setLatestRunId] = useState<string | null>(null);
  const [cardRuns, setCardRuns] = useState<AgentRun[]>([]);
  const [latestRunStatus, setLatestRunStatus] = useState<string>("");

  // Where to land once the server is reachable and, in multi mode,
  // signed in: the board normally, the credentials wizard for `setup`.
  const landing: Screen = options.command === "setup" ? "setup" : "board";

  /** Leaving, with the embedded stack stopped first when there is one. */
  const quit = () => {
    void embedded?.stop().finally(() => exit());
    if (!embedded) exit();
  };

  // Local mode needs no sign in; multi mode requires a stored token.
  useEffect(() => {
    void (async () => {
      try {
        const health = await client.health();
        if (health.mode === "multi" && !(await tokens.get())) {
          setScreen("login");
          return;
        }
        setScreen(landing);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [client]);

  const refresh = async () => {
    const projects = await client.listProjects();
    const project = projects[0];
    if (!project) {
      setNotice(`No projects yet. Run \`bento setup\` to connect a repository, or open ${baseUrl} in a browser.`);
      return;
    }
    setProjectName(project.name);
    const [pipeline, featureRows, profileRows, statuses] = await Promise.all([
      client.getPipeline(project.id),
      client.listFeatures(project.id),
      client.listProfiles(),
      // Every card's run, not only the selected one's. Replaced whole
      // rather than merged, so a run that ended stops being reported
      // as running the moment the board next refreshes.
      client.getRunStatuses(project.id).catch(() => ({})),
    ]);
    setStages(pipeline.stages);
    setFeatures(featureRows);
    setProfiles(profileRows);
    setRunStatus(statuses);
    setGateWait(await gateWaits(client, pipeline.stages, featureRows, profileRows));

    // A board with no agent cannot run anything, and the reason is not
    // visible from the cards, so say it here rather than let a person
    // press start and watch nothing happen.
    if (profileRows.length === 0) {
      setNotice("No coding agents yet. Run `bento setup` to choose a tool and model.");
    } else if (!pipeline.stages.some((stage) => stage.defaultAgentProfileId)) {
      setNotice("No stage has an agent. Run `bento setup` to assign one.");
    } else if (featureRows.length === 0) {
      // A configured board with nothing on it looks broken, and the
      // terminal cannot add a card, so name the place that can.
      setNotice(`No cards yet. Add one in the web console at ${baseUrl}.`);
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
    void refresh().then(() => setOffline(false)).catch(onRefreshError);
    const timer = setInterval(
      () => void refresh().then(() => setOffline(false)).catch(onRefreshError),
      3000,
    );
    return () => clearInterval(timer);
  }, [screen]);

  // In runner mode this machine executes the agent runs the server holds
  // for it, so the board is shared but the containers are local.
  useEffect(() => {
    if (options.mode !== "runner" || screen !== "board") return;
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
  }, [options.mode, screen, baseUrl]);

  const ordered = orderFeatures(stages, features);
  const selected = Math.max(0, selectedFeatureId ? ordered.findIndex((f) => f.id === selectedFeatureId) : 0);
  const current = ordered[selected];

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
  const runActive = Boolean(latestRunStatus) && !["succeeded", "failed", "cancelled"].includes(latestRunStatus);

  // Follow the selected card's newest run.
  useEffect(() => {
      if (!current) return;
    let cancelled = false;
    void (async () => {
      client.getHistory(current.id).then(setHistory).catch(() => {});
      const detail = await client.getFeature(current.id);
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
  }, [current?.id, features]);

  /**
   * Live follow of the run being watched. The 3 second board refresh
   * above keeps working as the fallback; this subscription is what
   * makes output appear the moment it happens, and it carries the
   * fragments of the message being typed, which no transcript fetch
   * can ever return. Fragment bursts are coalesced on short timers so
   * the terminal is not redrawn per token.
   */
  const followedRunId = runActive ? latestRunId : null;
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
        const since =
          transcriptCursor.current?.runId === followedRunId ? transcriptCursor.current.cursor : 0;
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
        // The 3 second poll still covers the transcript; what must
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

  // What the card's agents committed: files touched and the stage
  // write-ups, summarised to fit the pane.
  useEffect(() => {
    if (!showChanges || !current) return;
    let cancelled = false;
    void client
      .getChanges(current.id)
      .then((committed) => {
        if (cancelled) return;
        const lines: string[] = [];
        for (const repo of committed.repositories) {
          const adds = repo.files.reduce((n, f) => n + f.additions, 0);
          const dels = repo.files.reduce((n, f) => n + f.deletions, 0);
          lines.push(`${repo.name}  +${adds} -${dels} in ${repo.files.length} file${repo.files.length === 1 ? "" : "s"}`);
          for (const f of repo.files) lines.push(`  +${f.additions} -${f.deletions}  ${f.path}`);
          for (const artifact of repo.artifacts) lines.push(`  write-up: ${artifact.path}`);
        }
        if (lines.length === 0) lines.push("Nothing committed yet.");
        setChangeLines(lines);
      })
      .catch((err: unknown) => setChangeLines([err instanceof Error ? err.message : String(err)]));
    return () => {
      cancelled = true;
    };
  }, [showChanges, current?.id, features]);

  useInput(
    (input, key) => {
      // The connection screen has no board to drive, and leaving is the
      // only thing it can offer.
      if (error) {
        if (input === "q") quit();
        return;
      }
      if (screen !== "board") return;

      // Composing a follow-up prompt: everything goes into the text.
      if (takeover !== null) {
        if (key.escape) {
          setTakeover(null);
          return;
        }
        if (key.return) {
          const prompt = takeover.trim();
          setTakeover(null);
          if (!prompt || !current) return;
          // Not resumeRun: that refuses while a run is active, and the
          // whole point of the composer is to be able to say something
          // to an agent that is working. The message endpoint decides
          // between steering a live session and parking the text for
          // the end of the run, and says which it did.
          void client
            .messageFeature(current.id, prompt)
            .then((result) =>
              setNotice(
                result.queued
                  ? "Queued. The agent reads it when this run ends."
                  : result.live
                    ? result.delivery === "steer"
                      ? "Sent. The agent is changing course now."
                      : "Sent. The agent reads it after the current step."
                    : "Continuing with your instructions",
              ),
            )
            .then(refresh)
            .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
          return;
        }
        if (key.backspace || key.delete) {
          setTakeover(takeover.slice(0, -1));
          return;
        }
        if (input) setTakeover(takeover + input);
        return;
      }
      if (input === "q") quit();
      if (key.downArrow || input === "j") setSelectedFeatureId(ordered[Math.min(selected + 1, ordered.length - 1)]?.id ?? null);
      if (key.upArrow || input === "k") setSelectedFeatureId(ordered[Math.max(selected - 1, 0)]?.id ?? null);
      if (!current) return;
      /**
       * Three places a card can be, and the keys mean different things
       * in each. Every key answers in every state: an action that
       * cannot apply says what would apply instead, because the raw
       * server refusal ({"error":"feature is not in a stage"}) tells
       * the person nothing about which key they wanted.
       */
      const inAStage = Boolean(current.currentStageId) && current.status !== "done";
      const isDone = current.status === "done";
      const finishedHint = "This card is finished. Press b to reopen it.";
      if (input === "a") {
        if (isDone) {
          setNotice(finishedHint);
        } else {
          // From the backlog the key moves the card forward, which is
          // what approve means before there is a gate to approve.
          void (inAStage ? client.approveFeature(current.id) : client.advanceFeature(current.id))
            .then(() => setNotice(inAStage ? `Approved ${current.title}` : `Started ${current.title}`))
            .then(refresh)
            .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
        }
      }
      // Reject is the other half of a manual gate: capital R, since r
      // already re-checks and the two are easy to confuse.
      if (input === "R") {
        if (!inAStage) {
          setNotice(isDone ? finishedHint : "Nothing to reject yet. Press a to start the pipeline.");
        } else {
          void client
            .rejectFeature(current.id)
            .then(() => setNotice(`Rejected ${current.title}, sent back`))
            .then(refresh)
            .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
        }
      }
      if (input === "r") {
        if (!inAStage) {
          setNotice(isDone ? finishedHint : "No gate to check yet. Press a to start the pipeline.");
        } else {
          void client
            .recheckGate(current.id)
            .then(() => setNotice("Re-checked the gate"))
            .then(refresh)
            .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
        }
      }
      // Stop the agent, so a person can take over.
      if (input === "x") {
        if (latestRunId && !["succeeded", "failed", "cancelled"].includes(latestRunStatus)) {
          void client
            .cancelRun(latestRunId)
            .then(() => setNotice("Stopped the agent"))
            .then(refresh)
            .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
        } else {
          setNotice("No agent is running on this card.");
        }
      }
      // Continue in your own words, reusing the agent's session.
      if (input === "c") {
        if (isDone) setNotice(finishedHint);
        else if (latestRunId) setTakeover("");
        else setNotice("Nothing to continue: no agent has run on this card yet.");
      }
      if (input === "h") {
        setShowHistory(!showHistory);
        setShowChanges(false);
      }
      if (input === "d") {
        setShowChanges(!showChanges);
        setShowHistory(false);
      }
      if (input === "b") {
        if (!current.currentStageId) {
          setNotice("Already in the backlog.");
        } else {
          // On a finished card the same request reopens it into the
          // stage it finished in; the server tells the two apart.
          void client
            .moveFeatureBack(current.id)
            .then(() => setNotice(isDone ? `Reopened ${current.title}` : "Sent back a stage"))
            .then(refresh)
            .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
        }
      }
      if (input === "s") {
        if (!inAStage) {
          setNotice(isDone ? finishedHint : "Start the pipeline first: press a.");
          return;
        }
        const stage = stages.find((st) => st.id === current.currentStageId);
        const profileId = stage?.defaultAgentProfileId ?? profiles[0]?.id;
        if (!profileId) {
          setNotice("Assign an agent to this stage first.");
          return;
        }
        const startedName = profiles.find((pr) => pr.id === profileId)?.name ?? "the agent";
        void client
          .startRun({ featureId: current.id, agentProfileId: profileId })
          .then(() => setNotice(`Started ${startedName}`))
          .then(refresh)
          .catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)));
      }
    },
    // Must be a real boolean: Ink only honours isActive when it is
    // strictly false, and isRawModeSupported is undefined without a TTY.
    { isActive: isRawModeSupported === true },
  );

  if (error) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} paddingY={1}>
        <Text bold color="red">
          Could not reach {baseUrl}
        </Text>
        <Text color="gray">{error}</Text>
        <Text>Check the address, and that the server is running.</Text>
        <Box marginTop={1}>
          <Text color="gray">{isRawModeSupported ? "q quit" : "press Ctrl-C to quit"}</Text>
        </Box>
      </Box>
    );
  }
  if (screen === "loading") return <Text color="gray">Connecting to {baseUrl}...</Text>;
  if (screen === "setup") {
    return (
      <Setup
        client={client}
        repositoryPathOwner={repositoryPathOwnerForMode(options.mode)}
        agentsRunLocally={options.mode !== "client"}
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
          void tokens.set(token).then(() => {
            setNotice("");
            setScreen(landing);
          });
        }}
        onQuit={quit}
      />
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">
          Bento
        </Text>
        <Text color="gray"> {projectName}</Text>
        <Text color="gray">
          {"  "}
          {describeMode(options, embedded?.sandbox)}
        </Text>
        <Text color="gray">
          {"  "}
          {baseUrl}
        </Text>
      </Box>
      {offline && <Text color="yellow">Lost the connection to {baseUrl}. Retrying...</Text>}

      {options.mode === "runner" && <RunnerNotice server={options.server ?? baseUrl} sandbox={options.sandbox} />}

      <Board
        stages={stages}
        features={features}
        profiles={profiles}
        selectedIndex={selected}
        runStatus={runStatus}
        gateWait={gateWait}
      />

      {current && (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          <Box>
            <Text bold>{current.title}</Text>
            <Text color={statusColor(current.status)}> {current.status}</Text>
            {spend && <Text color="gray"> {spend}</Text>}
          </Box>
          <Text bold color="gray">{showChanges ? "Changes" : showHistory ? "History" : "Agent logs"}</Text>
          {showChanges ? (
            <>
              {changeLines.slice(0, 8).map((line, i) => (
                <Text key={i} color="gray">
                  {line.slice(0, 100)}
                </Text>
              ))}
              {changeLines.length > 8 && <Text color="gray">... {changeLines.length - 8} more in the web console</Text>}
              {changeLines.length === 0 && <Text color="gray">Nothing committed yet.</Text>}
            </>
          ) : showHistory ? (
            <>
              {history.slice(-8).map((event) => (
                <Text key={event.id} color="gray">
                  {new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
                  {describeEvent(event, stages)} {triggerLabel(event)}
                </Text>
              ))}
              {history.length === 0 && <Text color="gray">Nothing has happened yet.</Text>}
            </>
          ) : (
            <>
              {transcript.length > 8 && <Text color="gray">... {transcript.length - 8} earlier lines</Text>}
              {transcript.slice(-8).map((line, i) => (
                <Text key={i} color="gray">
                  {line.slice(0, 100)}
                </Text>
              ))}
              {draft !== "" && (
                // The typing edge of the message in progress: its tail,
                // because that is where the new words appear. Flattened
                // to one line; embedded newlines grew the fixed pane
                // and bounced the panels below it on every flush.
                <Text>{`${cardAgent?.name ?? "agent"}> ${draft}`.replaceAll(/\s+/g, " ").slice(-100)}</Text>
              )}
              {transcript.length === 0 && draft === "" && <Text color="gray">No output yet.</Text>}
            </>
          )}
        </Box>
      )}

      {takeover !== null && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text color="cyan">{takeoverTitle(cardAgent?.cli, runActive, cardAgent?.name ?? "The agent")}</Text>
          <Text color="gray">Enter to send, Escape to cancel.</Text>
          <Text>{takeover}▊</Text>
        </Box>
      )}
      {options.mode === "runner" && <Text color="cyan">runner: {runnerStatus}</Text>}
      {notice && <Text color="yellow">{notice}</Text>}
      {/*
        Two lines, grouped by what they do. One line of every key ran
        past eighty columns and wrapped mid-word, which is where the
        shift on reject was getting lost.
      */}
      {isRawModeSupported ? (
        <Box flexDirection="column">
          <Text color="gray">
            look: j/k move · h {showHistory ? "logs" : "history"} · d {showChanges ? "logs" : "changes"} · r recheck · q
            quit
          </Text>
          <Text color="gray">act: s start · x stop · c message · a approve · shift+R reject · b send back</Text>
        </Box>
      ) : (
        <Text color="gray">read only: no terminal input available</Text>
      )}
    </Box>
  );
}
