import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { BentoClient, type AgentProfile, type Feature, type Stage } from "@bento/api-client";
import { spendCoverageNote, type AgentEvent } from "@bento/core";
import { authClient, useSession, useListOrganizations, signOut } from "./auth-client.js";
import { useCountUp } from "./count-up.js";
import { Board, matchesQuery, type CardPulse } from "./components/Board.js";
import { BoardSearch } from "./components/BoardSearch.js";
import { BottomBar } from "./components/BottomBar.js";
import { BrandLockup } from "./components/BrandLockup.js";
import { useGitHubOutcome } from "./components/GitHubIdentity.js";
import { SignOutButton } from "./components/IconButtons.js";
import { NavMenu, type NavAction } from "./components/NavMenu.js";
import { OutOfCompute } from "./components/OutOfCompute.js";
import { SignIn } from "./components/SignIn.js";
import { NewFeatureDialog, NewProjectDialog, PromptDialog } from "./components/PromptDialog.js";
import { ProjectPicker } from "./components/ProjectPicker.js";

/*
 * Everything below here is fetched when it is first needed.
 *
 * One bundle meant someone opening the sign-in page also downloaded
 * the settings pages, the session viewer, the diff review, and every
 * drawer on the board, none of which they can reach until they are
 * signed in. What stays eager is what the first screen actually
 * renders: the board, the sign-in form, and the small dialogs, which
 * are opened often enough that a fetch on click would show.
 *
 * Named exports, so each import is mapped to the default shape lazy
 * expects rather than the files being changed to suit it.
 */
const AcceptInvitation = lazy(() => import("./components/AcceptInvitation.js").then((m) => ({ default: m.AcceptInvitation })));
const AgentsPanel = lazy(() => import("./components/AgentsPanel.js").then((m) => ({ default: m.AgentsPanel })));
const ChangelogPage = lazy(() => import("./components/ChangelogPage.js").then((m) => ({ default: m.ChangelogPage })));
const ContactDialog = lazy(() => import("./components/ContactDialog.js").then((m) => ({ default: m.ContactDialog })));
const CreateTeam = lazy(() => import("./components/CreateTeam.js").then((m) => ({ default: m.CreateTeam })));
const DeviceApproval = lazy(() => import("./components/DeviceApproval.js").then((m) => ({ default: m.DeviceApproval })));
const FeatureDrawer = lazy(() => import("./components/FeatureDrawer.js").then((m) => ({ default: m.FeatureDrawer })));
const RepositoriesPanel = lazy(() => import("./components/RepositoriesPanel.js").then((m) => ({ default: m.RepositoriesPanel })));
const ResetPassword = lazy(() => import("./components/ResetPassword.js").then((m) => ({ default: m.ResetPassword })));
const SessionPage = lazy(() => import("./components/SessionPage.js").then((m) => ({ default: m.SessionPage })));
const SessionsPage = lazy(() => import("./components/SessionsPage.js").then((m) => ({ default: m.SessionsPage })));
const SettingsPage = lazy(() => import("./components/SettingsPage.js").then((m) => ({ default: m.SettingsPage })));
const StageConfig = lazy(() => import("./components/StageConfig.js").then((m) => ({ default: m.StageConfig })));

/**
 * What a route shows while its code arrives.
 *
 * The same empty centred frame the settings page already uses while it
 * works out which mode it is in, so a slow chunk looks like the app
 * thinking rather than like a blank tab.
 */
function RouteFallback() {
  return <div className="center" />;
}


const client = new BentoClient({ baseUrl: window.location.origin });

const PROJECT_KEY = "bento:projectId";

export function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Route />
    </Suspense>
  );
}

function Route() {
  if (window.location.pathname === "/device") return <DeviceApproval />;
  if (window.location.pathname === "/accept-invitation") return <AcceptInvitation />;
  // Membership and billing are pages, not drawers: they have room,
  // and an address that survives reload.
  if (window.location.pathname === "/settings") return <SettingsPage client={client} />;
  // Ahead of the session check on purpose: what shipped is not private,
  // and a release link shared in an issue has to open for whoever
  // follows it rather than showing them a sign-in form.
  if (window.location.pathname === "/changelog") return <ChangelogPage client={client} />;
  // Reached from the reset email, with no session and nothing else open.
  if (window.location.pathname === "/reset-password") return <ResetPassword />;
  // A card's conversation in its own tab; the SPA fallback serves it.
  const session = window.location.pathname.match(/^\/session\/([0-9a-f-]{36})$/);
  if (session) return <SessionPage client={client} featureId={session[1]!} />;
  return <Console />;
}

function Console() {
  const { data: session, isPending } = useSession();
  const [mode, setMode] = useState<"local" | "multi" | "unreachable">("local");
  const [social, setSocial] = useState<{ github: boolean; google: boolean } | undefined>(undefined);
  const [checkedMode, setCheckedMode] = useState(false);
  const [retry, setRetry] = useState(0);
  /**
   * Whether the session has ever resolved.
   *
   * The session hook goes pending again on every refetch, including the
   * one that follows signing up. Blanking the screen for those unmounts
   * the sign-in component and throws away what it was showing, which
   * silently swallowed the "confirm your email" step: the person filled
   * the form, the mail went out, and they were handed the sign-in form
   * again as though nothing had happened.
   */
  const [sessionSettled, setSessionSettled] = useState(false);

  useEffect(() => {
    if (!isPending) setSessionSettled(true);
  }, [isPending]);

  // Installing the App and connecting a GitHub account both leave for
  // github.com and come back here with the outcome in the address.
  useGitHubOutcome();

  useEffect(() => {
    // A dead server is not multi mode: sending someone to a sign-in
    // form that can never work misdiagnoses the outage as their fault.
    void client
      .health()
      .then((h) => {
        setMode(h.mode === "multi" ? "multi" : "local");
        setSocial(h.social);
      })
      .catch(() => setMode("unreachable"))
      .finally(() => setCheckedMode(true));
  }, [retry]);

  if (!checkedMode || (isPending && !sessionSettled)) return <div className="center" />;
  if (mode === "unreachable") {
    return (
      <div className="center">
        <div className="unreachable">
          <p>Cannot reach the Bento server.</p>
          <p className="muted">Check that it is running, then try again.</p>
          <button className="btn btn-primary" onClick={() => { setCheckedMode(false); setRetry((n) => n + 1); }}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  // Local mode runs as a single user with no sign in.
  if (mode === "multi" && !session) return <SignIn social={social} />;
  if (mode === "multi" && session) {
    return <FirstTeamGate userName={session.user.name ?? ""} />;
  }
  return <BoardScreen showSignOut={false} />;
}

/**
 * Everything in multi mode belongs to an organization, so an account
 * without one is prompted to name a team before it reaches the board.
 * The check lives in its own component so the organizations hook only
 * runs signed in, and "created" short-circuits it: the hook's cache
 * does not refresh on its own.
 */
function FirstTeamGate({ userName }: { userName: string }) {
  const { data: organizations, isPending, error } = useListOrganizations();
  const [created, setCreated] = useState(false);
  if (isPending && !created) return <div className="center" />;
  /**
   * A failed lookup is not an account without a team. Reading it as one
   * showed the onboarding screen to an existing member, and creating a
   * team from there switched them into an empty organization, hiding
   * the board they actually work on.
   */
  if (!created && error) {
    return (
      <div className="center">
        <div className="unreachable">
          <p>Could not load your teams.</p>
          <p className="muted">Check the connection, then try again.</p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!created && Array.isArray(organizations) && organizations.length === 0) {
    return <FirstTeam userName={userName} onCreated={() => setCreated(true)} />;
  }
  return <BoardScreen showSignOut />;
}

/**
 * An account with no organization is not always one that should found
 * a team. An invitee who signed up and then landed here instead of on
 * the invitation link still has that invitation pending, and opening on
 * "name your team" buries the team they were actually asked to join. So
 * pending invitations are checked first, and the oldest one wins; the
 * accept page handles the rest. Only when there is nothing waiting does
 * this fall through to creating a team.
 */
function FirstTeam({ userName, onCreated }: { userName: string; onCreated: () => void }) {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void authClient.organization
      .listUserInvitations()
      .then((result) => {
        if (cancelled) return;
        const first = (Array.isArray(result.data) ? result.data : [])[0] as { id?: string } | undefined;
        if (first?.id) {
          window.location.replace(`/accept-invitation?id=${encodeURIComponent(first.id)}`);
          return;
        }
        setChecked(true);
      })
      // A failed lookup must not block onboarding: with no invitation
      // to show, creating a team remains the only door forward.
      .catch(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!checked) return <div className="center" />;
  return <CreateTeam userName={userName} onCreated={onCreated} />;
}

function BoardScreen({ showSignOut }: { showSignOut: boolean }) {
  // Sessions is a sibling tab of the board inside the same chrome, so
  // both addresses land here and only the slab between the topbar and
  // the bottom bar differs. Navigation is full page loads, so reading
  // the address once at render is the routing. Trailing slashes are
  // tolerated: the SPA fallback serves "/sessions/" too, and answering
  // it with the board under a sessions address helped nobody.
  const screen: "board" | "sessions" =
    window.location.pathname.replace(/\/+$/, "") === "/sessions" ? "sessions" : "board";
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  // Remembered across reloads: which board a user was last looking at.
  // The list effect below still re-checks the stored id against the
  // rows the current tenant can see, so a stale value from before an
  // organization switch falls back to the first visible project
  // rather than landing on one this session cannot open.
  const [projectId, setProjectId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PROJECT_KEY) ?? null;
    } catch {
      return null;
    }
  });
  const [stages, setStages] = useState<Stage[]>([]);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [runStatus, setRunStatus] = useState<Record<string, string | undefined>>({});
  const [runTicks, setRunTicks] = useState<Record<string, number>>({});
  /** The agent's latest line per card, straight off the board stream. */
  const [lastOutput, setLastOutput] = useState<Record<string, string | undefined>>({});
  const [pulses, setPulses] = useState<Record<string, CardPulse | undefined>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "pipeline" | "repos" | "agents">("none");
  const [dialog, setDialog] = useState<"none" | "feature" | "project">("none");
  /**
   * The board's search, held here rather than in the field.
   *
   * Deliberately not persisted and not in the address: a filtered board
   * that survived a reload would be a board with cards missing and no
   * memory of why, which is the failure this console keeps designing
   * against.
   */
  const [query, setQuery] = useState("");
  /** Opened from the bottom bar and from the menu; one dialog either way. */
  const [contactOpen, setContactOpen] = useState(false);
  const [usage, setUsage] = useState<{ totalUsd: number; totalRuns: number; runsWithoutCost: number } | null>(null);
  // Called unconditionally: the chip below it is conditional, a hook
  // cannot be.
  const spendShown = useCountUp(usage?.totalUsd ?? 0);
  /** A board-level load or action failure, shown under the topbar. */
  const [loadError, setLoadError] = useState("");

  /**
   * Agents are not scoped to a project, so they load independently:
   * otherwise you could not add one before creating your first project.
   */
  const refresh = useCallback(async () => {
    // A failed load must not masquerade as an empty board: "No projects
    // yet" on a network error invites recreating projects that exist.
    try {
      setProfiles(await client.listProfiles());
      if (!projectId) {
        setStages([]);
        setFeatures([]);
        return;
      }
      const [pipeline, featureRows, snapshot] = await Promise.all([
        client.getPipeline(projectId),
        client.listFeatures(projectId),
        // The run status behind every card's face. Seeding it here
        // rather than only from live board events: a run that started
        // before this page opened (or while its stream was down) never
        // emits into a fresh session, so the card used to read
        // "not started" while its agent worked.
        client.getBoardSnapshot(projectId),
      ]);
      setStages(pipeline.stages);
      setPipelineId(pipeline.id);
      setFeatures(featureRows);
      setRunStatus(snapshot.statuses);
      setLastOutput(snapshot.outputs);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void client
      .listProjects()
      .then((rows) => {
        setProjects(rows);
        // The selection is rebuilt rather than kept: after an
        // organization switch the project it names belongs to a tenant
        // this session can no longer see, and every panel keyed on it
        // would go on describing that one.
        setProjectId((current) =>
          current && rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? null),
        );
        setLoadError("");
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  // Persist the selection so a refresh lands on the same board. The
  // list effect above has already rejected ids this tenant cannot see,
  // so anything reaching here is one the session can open. Private
  // browsing can refuse storage; the write is best effort.
  useEffect(() => {
    try {
      if (projectId) localStorage.setItem(PROJECT_KEY, projectId);
      else localStorage.removeItem(PROJECT_KEY);
    } catch {
      // ignore: storage unavailable
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Spend is shown, never enforced: the figure comes from whatever the
  // agent CLI printed, and most print nothing, so it is not a number to
  // make decisions on behalf of anyone.
  useEffect(() => {
    if (!projectId) return setUsage(null);
    void client
      .getUsage(projectId)
      .then(setUsage)
      .catch(() => setUsage(null));
  }, [projectId, features]);

  // Board events tell us a card moved or a run changed state. Status
  // lands optimistically; the refetch is coalesced so a burst of events
  // costs one round trip instead of one per event. Board screen only:
  // the sessions tab runs its own stream for its own list, and holding
  // a second one here meant two connections per viewer, both refetching
  // board data nothing on that screen renders. The one initial
  // refresh() still happens on either screen, because the panels
  // (Pipeline, Repositories) read stages and features wherever opened.
  useEffect(() => {
    if (!projectId || screen !== "board") return;
    let timer: number | null = null;
    const stop = client.streamBoard(
      projectId,
      (event) => {
        const e = event as { featureId?: string; status?: string; type?: string; text?: string };
        if (e.type === "run_updated" && e.featureId && e.status) {
          setRunStatus((prev) => ({ ...prev, [e.featureId!]: e.status }));
          // The drawer refetches its runs list on this tick, so a run
          // started elsewhere (another tab, the API, an auto-start) still
          // surfaces its Stop button and its row without reopening.
          setRunTicks((prev) => ({ ...prev, [e.featureId!]: (prev[e.featureId!] ?? 0) + 1 }));
        }
        // What the agent last said, shown on the card face so a board of
        // running agents reads as work rather than as spinners.
        if (e.type === "run_output" && e.featureId && e.text) {
          setLastOutput((prev) => ({ ...prev, [e.featureId!]: e.text }));
          return;
        }
        timer ??= window.setTimeout(() => {
          timer = null;
          void refresh();
        }, 250);
      },
      // Board events are not persisted, so whatever fired while the
      // stream was down (a deploy, a dropped connection) is lost.
      // Coming back up is the signal to resync from the snapshot.
      () => void refresh(),
    );
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [projectId, refresh]);

  const recordEvent = useCallback((featureId: string, event: AgentEvent) => {
    const kind = event.type === "result" && !event.ok ? "result-failed" : event.type;
    setPulses((prev) => {
      const ticks = [...(prev[featureId]?.ticks ?? []), kind].slice(-40);
      return { ...prev, [featureId]: { ticks } };
    });
  }, []);

  const selected = useMemo(() => features.find((f) => f.id === selectedId) ?? null, [features, selectedId]);

  /**
   * A board with no agent cannot run anything, and the cards give no
   * hint why. Name the missing step and offer the panel that fixes it.
   */
  const setupNeeded = useMemo(() => {
    if (stages.length === 0) return null;
    if (profiles.length === 0) {
      return {
        message: "No coding agents yet. Pair a tool with a model before a stage can run.",
        action: "Add an agent",
        panel: "agents" as const,
      };
    }
    if (!stages.some((stage) => stage.defaultAgentProfileId)) {
      return {
        message: "No stage has an agent, so nothing starts on its own.",
        action: "Assign agents",
        panel: "pipeline" as const,
      };
    }
    return null;
  }, [profiles, stages]);

  async function addFeature(title: string, description: string) {
    if (!projectId) return;
    await client.createFeature({ projectId, title, ...(description ? { description } : {}) });
    await refresh();
  }

  /**
   * Both fields in one dialog. As two browser prompts in a row there
   * was no way back from the second: cancelling it discarded the name
   * already typed.
   */
  async function addProject(
    name: string,
    repositories: { localPath?: string; githubRepoId?: string; repoUrl?: string; name?: string; defaultBranch?: string }[],
  ) {
    const created = await client.createProject({ name, repositories });
    const rows = await client.listProjects();
    setProjects(rows);
    setProjectId(created.id);
  }

  const dialogs = (
    <>
      {dialog === "feature" && (
        <NewFeatureDialog onClose={() => setDialog("none")} onSubmit={addFeature} />
      )}
      {dialog === "project" && (
        <NewProjectDialog client={client} onClose={() => setDialog("none")} onSubmit={addProject} />
      )}
    </>
  );

  /*
   * Their own boundary, with nothing to show.
   *
   * These are lazy too, and without a boundary here they would suspend
   * to the one around the whole app: opening a drawer would blank the
   * board behind it for as long as the chunk took. A null fallback
   * because the board is still there and still readable; a spinner
   * over it would be a worse answer than a drawer that arrives a frame
   * later.
   */
  const panels = (
    <Suspense fallback={null}>
      {panel === "pipeline" && (
        <StageConfig
          client={client}
          projectId={projectId}
          pipelineId={pipelineId}
          stages={stages}
          features={features}
          profiles={profiles}
          onClose={() => setPanel("none")}
          onChanged={refresh}
        />
      )}
      {panel === "repos" && (
        <RepositoriesPanel client={client} projectId={projectId} onClose={() => setPanel("none")} />
      )}
      {panel === "agents" && (
        <AgentsPanel client={client} profiles={profiles} onClose={() => setPanel("none")} onChanged={refresh} />
      )}
    </Suspense>
  );

  const spend = usage && usage.totalRuns > 0 && (
    <span
      className="chip"
      // The tool list comes from the catalog, so it cannot drift
      // from which adapters actually report a figure.
      title={
        usage.runsWithoutCost > 0
          ? `$${usage.totalUsd.toFixed(2)} across ${usage.totalRuns - usage.runsWithoutCost} of ${usage.totalRuns} runs. ${spendCoverageNote()}`
          : `Across ${usage.totalRuns} runs. ${spendCoverageNote()}`
      }
    >
      spend $<span className="spend-figure">{spendShown.toFixed(2)}</span>
      {usage.runsWithoutCost > 0 ? "+" : ""}
    </span>
  );

  /*
   * The board's tools, as one list.
   *
   * The topbar renders them as a row and the hamburger renders them as
   * a menu, and this is why the two cannot disagree about what exists.
   * The order is the row's order, which is the order they were in
   * before the menu existed.
   */
  const actions: NavAction[] = [
    { id: "board", label: "Board", href: "/", current: screen === "board" },
    { id: "sessions", label: "Sessions", href: "/sessions", current: screen === "sessions" },
    { id: "agents", label: "Agents", onSelect: () => setPanel("agents") },
    ...(projects.length > 0
      ? [
          { id: "pipeline", label: "Pipeline", onSelect: () => setPanel("pipeline") },
          { id: "repos", label: "Repositories", onSelect: () => setPanel("repos") },
        ]
      : []),
  ];

  const bottom = (
    <>
      <BottomBar onContact={() => setContactOpen(true)} />
      <Suspense fallback={null}>
        {contactOpen && <ContactDialog client={client} onClose={() => setContactOpen(false)} />}
      </Suspense>
    </>
  );

  if (projects.length === 0) {
    return (
      <div className="app">
        <TopBar
          showSignOut={showSignOut}
          actions={actions}
          meta={spend}
          onContact={() => setContactOpen(true)}
          primary={
            <button className="btn btn-primary" onClick={() => setDialog("project")}>
              New project
            </button>
          }
        />
        <div className="empty-state">
          <p className="muted">No projects yet. Point Bento at a git repository to start a board.</p>
          <button className="btn btn-primary" onClick={() => setDialog("project")}>
            New project
          </button>
        </div>
        {panels}
        {dialogs}
        {bottom}
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar
        showSignOut={showSignOut}
        actions={actions}
        meta={spend}
        onContact={() => setContactOpen(true)}
        picker={
          <ProjectPicker
            projects={projects}
            projectId={projectId}
            onSelect={setProjectId}
            onNewProject={() => setDialog("project")}
          />
        }
        search={
          screen === "board" ? (
            <BoardSearch
              value={query}
              onChange={setQuery}
              matches={features.filter((f) => matchesQuery(f, query)).length}
            />
          ) : undefined
        }
        primary={
          screen === "board" ? (
            <button className="btn btn-primary" onClick={() => setDialog("feature")}>
              New card
            </button>
          ) : undefined
        }
      />

      {/* Ahead of the setup prompt: a team with no compute left cannot
          act on any advice below it either. */}
      <OutOfCompute onOpenBilling={() => window.location.assign("/settings")} />

      {setupNeeded && (
        <div className="setup-prompt">
          <span>{setupNeeded.message}</span>
          <button className="btn btn-primary" onClick={() => setPanel(setupNeeded.panel)}>
            {setupNeeded.action}
          </button>
        </div>
      )}
      {loadError && (
        <div className="setup-prompt" role="alert">
          <span>{loadError}</span>
          <button className="btn" onClick={() => { setLoadError(""); void refresh(); }}>
            Retry
          </button>
        </div>
      )}

      {screen === "sessions" ? (
        // Its own boundary, like the panels and the drawer: without one
        // the chunk load suspends to the app root and blanks the chrome.
        <Suspense fallback={<div className="center" />}>
          <SessionsPage client={client} projectId={projectId} profiles={profiles} />
        </Suspense>
      ) : (
      <Board
        drawerOpen={selected !== null}
        query={query}
        stages={stages}
        features={features}
        profiles={profiles}
        runStatusByFeature={runStatus}
        lastOutputByFeature={lastOutput}
        pulses={pulses}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNewCard={() => setDialog("feature")}
        onMove={(featureId, stageId) => {
          // Optimistic: the card lands in the lane it was dropped on,
          // and the refetch settles the truth. Waiting for the server
          // makes a drop feel like it bounced.
          setFeatures((current) =>
            current.map((f) => (f.id === featureId ? { ...f, currentStageId: stageId, status: "active" } : f)),
          );
          void client
            .moveFeature(featureId, stageId)
            .then(() => setLoadError(""))
            // The refetch will snap the card back; without a reason the
            // bounce reads as a glitch rather than a refusal.
            .catch((err: unknown) =>
              setLoadError(`The move was refused: ${err instanceof Error ? err.message : String(err)}`),
            )
            .finally(() => void refresh());
        }}
        onFinish={(featureId) => {
          // Optimistic like a move, and the card keeps its stage: that
          // is what the server does, and what reopening reads.
          setFeatures((current) =>
            current.map((f) => (f.id === featureId ? { ...f, status: "done" } : f)),
          );
          void client
            .finishFeature(featureId)
            .then(() => setLoadError(""))
            .catch((err: unknown) =>
              setLoadError(`The move was refused: ${err instanceof Error ? err.message : String(err)}`),
            )
            .finally(() => void refresh());
        }}
      />
      )}

      {/* Same reason as the panels: the board stays put while the
          drawer's code arrives. */}
      <Suspense fallback={null}>
        {screen === "board" && selected && (
          <FeatureDrawer
            client={client}
            feature={selected}
            stages={stages}
            profiles={profiles}
            runsVersion={runTicks[selected.id] ?? 0}
            onClose={() => setSelectedId(null)}
            onChanged={refresh}
            onEvent={recordEvent}
          />
        )}
      </Suspense>

      {panels}
      {dialogs}
      {bottom}
    </div>
  );
}

/**
 * The settings gear.
 *
 * Drawn rather than set as U+2699, which is what this was. That glyph
 * occupies a fraction of its em box and the fraction differs per font,
 * so it rendered visibly smaller than the 12px labels beside it and no
 * font size fixed that without throwing the row's alignment out. Eight
 * teeth around a ring, at whatever size the rule below asks for.
 */
function GearMark() {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false">
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect key={deg} x="7.05" y="0.6" width="1.9" height="3.6" rx="0.6" transform={`rotate(${deg} 8 8)`} />
      ))}
      <path
        fillRule="evenodd"
        d="M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm0 2.65a2.35 2.35 0 1 1 0 4.7 2.35 2.35 0 0 1 0-4.7Z"
      />
    </svg>
  );
}

/**
 * The console's chrome.
 *
 * Two renderings of one set of controls. Above 720px they are a row, as
 * they always were. Below it the row is a menu behind a hamburger, and
 * only the three things worth a tap without one stay out: the project
 * picker, the search field, and the primary action.
 *
 * The narrow layout was not a small version of the wide one, it was the
 * wide one wrapping. A picker, a search field, four ghost buttons, a
 * gear and Sign out came to three rows of scattered text stacked above
 * a board with no height left to show a card in.
 */
function TopBar({
  actions = [],
  primary,
  picker,
  search,
  meta,
  onContact,
  showSignOut,
}: {
  /** The board's tools. Rendered as a row, and as menu entries. */
  actions?: NavAction[];
  /** The one button that stays out of the menu at every width. */
  primary?: React.ReactNode;
  picker?: React.ReactNode;
  search?: React.ReactNode;
  /** The spend chip: read, not operated, so it never enters the menu. */
  meta?: React.ReactNode;
  onContact: () => void;
  showSignOut: boolean;
}) {
  /*
   * What the row spells out in controls the menu has to spell out in
   * words. The gear is a gear because the row has no space for a word
   * and every console puts settings behind one; a menu is a list of
   * labels, and an unlabelled gear in it would be the only entry you
   * had to recognise rather than read.
   *
   * Contact and the changelog live in the bottom bar, and are repeated
   * here: on a phone the bottom bar is a thumb's reach away, but the
   * menu is where somebody goes looking for "everything else", and the
   * cost of answering that twice is two lines.
   */
  const entries: NavAction[] = [
    ...actions,
    { id: "contact", label: "Contact", onSelect: onContact },
    { id: "changelog", label: "Changelog", href: "/changelog" },
    { id: "settings", label: "Settings", href: "/settings" },
    ...(showSignOut ? [{ id: "signout", label: "Sign out", onSelect: () => void signOut() }] : []),
  ];

  return (
    <header className="topbar">
      <BrandLockup />
      {/* One block, so it can drop to a row of its own on a phone
          without the picker and the field being separated by whatever
          happened to wrap between them. */}
      {(picker || search) && (
        <div className="topbar-lead">
          {picker}
          {search}
        </div>
      )}
      <span className="topbar-spacer" />
      {meta}
      <nav className="topbar-nav" aria-label="Board">
        {actions.map((action) =>
          action.href === undefined ? (
            <button key={action.id} className="btn btn-ghost" onClick={action.onSelect}>
              {action.label}
            </button>
          ) : (
            <a key={action.id} className="btn btn-ghost" href={action.href} aria-current={action.current ? "page" : undefined}>
              {action.label}
            </a>
          ),
        )}
        <a className="btn btn-ghost settings-gear" aria-label="Settings" title="Settings" href="/settings">
          <GearMark />
        </a>
        {showSignOut && <SignOutButton onClick={() => signOut()} />}
      </nav>
      {primary}
      <NavMenu actions={entries} />
    </header>
  );
}

