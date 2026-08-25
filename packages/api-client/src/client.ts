import { SseParser, type AgentDelta, type AgentEvent, type GateCriteria } from "@bento/core";
import type {
  AgentProfile,
  AgentRun,
  AgentTool,
  Feature,
  FeatureChanges,
  FeaturePullRequest,
  FeatureEvent,
  GateState,
  Pipeline,
  Project,
  ProjectSession,
  ProjectUsage,
  Repository,
  RunArtifact,
  Stage,
} from "./types.js";

export interface TokenStore {
  get(): string | null | Promise<string | null>;
  set(token: string | null): void | Promise<void>;
}

export interface ClientOptions {
  baseUrl: string;
  /** Bearer token source for non-browser clients (TUI, Mac app). */
  tokens?: TokenStore;
  fetch?: typeof fetch;
}

export interface RunStreamHandlers {
  onEvent?: (event: AgentEvent, seq: number) => void;
  onDelta?: (delta: AgentDelta) => void;
  onDone?: (status: string) => void;
  /**
   * The stream failed: a rejected token, a dropped connection, or a
   * handler that threw. Fired on the fetch transport only; the
   * EventSource transport reconnects on its own instead.
   */
  onError?: (error: Error) => void;
}

export interface GitHubConnection {
  configured: boolean;
  connected: boolean;
  /** True when something can actually push: an App installation, or a saved token. */
  canPublish: boolean;
  canManage: boolean;
  installation: { accountLogin: string; accountType: string } | null;
  /**
   * Whether this user has a GitHub identity attached to their Bento
   * account. Installing the App needs one, so an account made with an
   * email and a password has a step to do first.
   */
  identityLinked: boolean;
  /** Whether attaching one is possible here, which needs GitHub sign in configured. */
  canLinkIdentity: boolean;
}

/** An installation of the App the signed-in user could connect. */
export interface GitHubInstallationOption {
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
}

export interface LinearTeamMapping {
  id: string;
  linearTeamId: string;
  linearTeamKey: string;
  linearTeamName: string;
  projectId: string;
}

export interface LinearConnection {
  connected: boolean;
  /** Masked tail of the stored key, so the UI can show which one. */
  hint: string | null;
  /** True when Linear can push changes to us as they happen. */
  webhook: boolean;
  defaultProjectId: string | null;
  canManage: boolean;
  mappings: LinearTeamMapping[];
}

export interface SlackConnection {
  configured: boolean;
  connected: boolean;
  canManage: boolean;
  teamName: string | null;
  defaultProjectId: string | null;
  eventsUrl?: string | null;
  interactivityUrl?: string | null;
}

export interface LinearTeamOption {
  id: string;
  key: string;
  name: string;
}

/** A project inside Linear, not a Bento project. */
export interface LinearProjectOption {
  id: string;
  name: string;
}

export interface LinearSettings {
  defaultProjectId?: string | null;
}

/** One project's outbound settings: only what was sent is written. */
export interface ProjectLinearSettings {
  createIssues?: boolean;
  teamId?: string | null;
  linearProjectId?: string | null;
}

/** What the project settings PATCH answers with: the stored values. */
export interface ProjectLinearState {
  linearCreateIssues: boolean;
  linearTeamId: string | null;
  linearTeamKey: string | null;
  linearTeamName: string | null;
  linearProjectId: string | null;
  linearProjectName: string | null;
}

export interface LinearIssueOption {
  id: string;
  identifier: string;
  title: string;
  url: string;
  stateName: string;
  imported: boolean;
}

export interface LinearIssuePage {
  issues: LinearIssueOption[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    // A refusal arrives as {"error":"..."}, and every client was
    // showing that envelope to a person. The sentence inside is the
    // message; the envelope was only ever transport.
    super(unwrapError(message));
    this.name = "ApiError";
  }
}

/**
 * The sentence inside a refusal body, whatever shape it arrived in.
 *
 * Handlers answer with {"error":"a sentence"}, but a request the
 * validator rejects answers with the ZodError itself under the same
 * key. String() on that object renders "[object Object]", which is
 * what every client used to show for a bad enum value.
 */
export function unwrapError(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (typeof error === "string") return error;
      if (error && typeof error === "object" && "issues" in error) {
        const summary = summariseIssues((error as { issues: unknown }).issues);
        if (summary) return summary;
      }
      return body;
    }
  } catch {
    // Not JSON: an HTML error page or a bare status line. Show as is.
  }
  return body;
}

/**
 * A validation failure as the fields it happened on. Three at most:
 * the rest of a long list scrolls the first one, which is usually the
 * one that was typed wrong.
 */
function summariseIssues(issues: unknown): string | null {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const lines = issues.slice(0, 3).map((raw) => {
    const issue = raw as { path?: unknown[]; message?: string; options?: unknown[]; received?: unknown };
    const field = Array.isArray(issue.path) ? issue.path.join(".") : "";
    const detail =
      Array.isArray(issue.options) && issue.options.length > 0
        ? `expected one of ${issue.options.join(", ")}`
        : issue.received === "undefined"
          ? "required"
          : (issue.message ?? "is not valid");
    return field ? `${field}: ${detail}` : detail;
  });
  const more = issues.length > lines.length ? `, and ${issues.length - lines.length} more` : "";
  return `${lines.join("; ")}${more}`;
}

/**
 * Shared REST client for the web app and TUI.
 *
 * Browsers authenticate with better-auth's session cookie (credentials:
 * include); the TUI and Mac app send a bearer token from the device
 * flow. Supplying a TokenStore switches on the bearer path.
 */
export class BentoClient {
  private baseUrl: string;
  private tokens: TokenStore | undefined;
  private fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokens = options.tokens;
    // Must be bound: an unbound window.fetch throws "Illegal invocation".
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const token = await this.tokens?.get();
    if (token) headers.set("authorization", `Bearer ${token}`);

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      credentials: this.tokens ? "omit" : "include",
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, body || res.statusText);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * The same request path, for routes whose body is a document rather
   * than JSON. Kept separate so `request` can go on assuming JSON.
   */
  private async requestText(path: string, init: RequestInit = {}): Promise<string> {
    const headers = new Headers(init.headers);
    const token = await this.tokens?.get();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      credentials: this.tokens ? "omit" : "include",
    });
    const body = await res.text();
    if (!res.ok) throw new ApiError(res.status, body || res.statusText);
    return body;
  }

  /** The whole pipeline as a YAML document: stages, agents, commands. */
  exportPipeline(projectId: string) {
    return this.requestText(`/api/projects/${projectId}/pipeline/export`);
  }

  /** Applies one. Stages are matched by slug, so a live board keeps its cards. */
  importPipeline(projectId: string, yaml: string) {
    return this.request<{
      stages: number;
      agents: number;
      removedStages: string[];
      skippedRepositories: string[];
    }>(`/api/projects/${projectId}/pipeline/import`, {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: yaml,
    });
  }

  /** Every named agent as a YAML document: tool, model, skill. */
  exportAgents() {
    return this.requestText("/api/profiles/export");
  }

  /** Applies one. Agents are matched by name, so importing twice edits rather than duplicating. */
  importAgents(yaml: string) {
    return this.request<{ agents: number }>("/api/profiles/import", {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: yaml,
    });
  }

  health() {
    return this.request<{
      ok: boolean;
      mode: string;
      driver: string;
      /** Which social logins the server is configured for (multi mode). */
      social?: { github: boolean; google: boolean };
    }>("/api/health");
  }

  listProjects() {
    return this.request<Project[]>("/api/projects");
  }

  /**
   * `localPath` is the single repository shorthand; `repositories` is
   * for a project spanning several, which become one workspace per
   * card with a worktree each. Give one or the other.
   */
  createProject(input: {
    name: string;
    localPath?: string;
    defaultBranch?: string;
    repositories?: {
      name?: string;
      localPath?: string;
      repoUrl?: string;
      githubRepoId?: string;
      defaultBranch?: string;
    }[];
  }) {
    return this.request<Project>("/api/projects", { method: "POST", body: JSON.stringify(input) });
  }

  /**
   * The project's own settings: its name, and whether an arriving Linear
   * issue starts its pipeline. Only what is passed is written.
   */
  updateProject(projectId: string, patch: { name?: string; autoStartPipeline?: boolean }) {
    return this.request<Project>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /**
   * The project and everything on its board. Refused with 409 while an
   * agent is still working a card.
   */
  deleteProject(projectId: string) {
    return this.request<{ ok: boolean; deletedCards: number }>(`/api/projects/${projectId}`, {
      method: "DELETE",
    });
  }

  /** Every conversation in the project, newest activity first. */
  listSessions(projectId: string) {
    return this.request<{ sessions: ProjectSession[] }>(`/api/projects/${projectId}/sessions`);
  }

  getPipeline(projectId: string) {
    return this.request<Pipeline>(`/api/projects/${projectId}/pipeline`);
  }

  listRepositories(projectId: string) {
    return this.request<Repository[]>(`/api/projects/${projectId}/repositories`);
  }

  /** A project can span several checkouts, each its own worktree. */
  addRepository(
    projectId: string,
    input: {
      localPath?: string;
      name?: string;
      repoUrl?: string;
      githubRepoId?: string;
      defaultBranch?: string;
      setupCommand?: string | null;
      testCommand?: string | null;
    },
  ) {
    return this.request<Repository>(`/api/projects/${projectId}/repositories`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** The setup and test commands, changed without re-adding the checkout. */
  updateRepository(
    projectId: string,
    repositoryId: string,
    input: { setupCommand?: string | null; testCommand?: string | null },
  ) {
    return this.request<Repository>(`/api/projects/${projectId}/repositories/${repositoryId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  /** Which coding agents this deployment can start, and how to install the rest. */
  listAgentTools() {
    return this.request<AgentTool[]>("/api/profiles/tools");
  }

  githubStatus() {
    return this.request<GitHubConnection>("/api/github/status");
  }

  /** An issue report or feature request, mailed to the operator. */
  sendContact(input: { kind: "issue" | "feature"; message: string }) {
    return this.request<{ ok: boolean }>("/api/contact", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** The whole order at once, so positions stay unique and contiguous. */
  reorderStages(pipelineId: string, stageIds: string[]) {
    return this.request<{ stageIds: string[] }>("/api/stages/reorder", {
      method: "POST",
      body: JSON.stringify({ pipelineId, stageIds }),
    });
  }

  /** What Bento puts into a pull request, as opposed to how it signs in. */
  githubSettings() {
    return this.request<{ includeStageNotesInPr: boolean; canManage: boolean }>("/api/github/settings");
  }

  setGitHubSettings(input: { includeStageNotesInPr: boolean }) {
    return this.request<{ includeStageNotesInPr: boolean }>("/api/github/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  startGitHubInstall() {
    return this.request<{ url: string }>("/api/github/install", { method: "POST" });
  }

  /** Installations of the App this user could connect: the after-the-fact
      path for installs a GitHub owner approved from a request. */
  listGitHubInstallations() {
    return this.request<GitHubInstallationOption[]>("/api/github/installations");
  }

  connectGitHubInstallation(installationId: string) {
    return this.request<{ ok: boolean }>("/api/github/connect", {
      method: "POST",
      body: JSON.stringify({ installationId }),
    });
  }

  listGitHubRepositories() {
    return this.request<GitHubRepository[]>("/api/github/repositories");
  }

  disconnectGitHub() {
    return this.request<{ ok: boolean }>("/api/github/installation", { method: "DELETE" });
  }

  linearStatus() {
    return this.request<LinearConnection>("/api/linear/status");
  }

  connectLinear(apiKey: string) {
    return this.request<{ connected: boolean; webhook: boolean }>("/api/linear/connect", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
  }

  disconnectLinear() {
    return this.request<{ ok: boolean }>("/api/linear/connect", { method: "DELETE" });
  }

  listLinearTeams() {
    return this.request<LinearTeamOption[]>("/api/linear/teams");
  }

  listLinearProjects(teamId: string) {
    return this.request<LinearProjectOption[]>(
      `/api/linear/projects?teamId=${encodeURIComponent(teamId)}`,
    );
  }

  createLinearMapping(input: { linearTeamId: string; projectId: string }) {
    return this.request<LinearTeamMapping>("/api/linear/mappings", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  deleteLinearMapping(id: string) {
    return this.request<{ ok: boolean }>(`/api/linear/mappings/${id}`, { method: "DELETE" });
  }

  setLinearSettings(input: LinearSettings) {
    return this.request<Required<LinearSettings>>("/api/linear/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  setProjectLinearSettings(projectId: string, input: ProjectLinearSettings) {
    return this.request<ProjectLinearState>(
      `/api/linear/projects/${encodeURIComponent(projectId)}/settings`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  listLinearIssues(teamId: string, after?: string) {
    const cursor = after ? `&after=${encodeURIComponent(after)}` : "";
    return this.request<LinearIssuePage>(`/api/linear/issues?teamId=${encodeURIComponent(teamId)}${cursor}`);
  }

  importLinearIssues(input: { issueIds: string[]; projectId: string }) {
    return this.request<{ imported: number }>("/api/linear/import", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  syncLinearNow() {
    return this.request<{ ok: boolean }>("/api/linear/sync", { method: "POST" });
  }

  slackStatus() {
    return this.request<SlackConnection>("/api/slack/status");
  }

  startSlackInstall() {
    return this.request<{ url: string }>("/api/slack/install", { method: "POST" });
  }

  disconnectSlack() {
    return this.request<{ ok: boolean }>("/api/slack/installation", { method: "DELETE" });
  }

  setSlackSettings(input: { defaultProjectId: string | null }) {
    return this.request<{ defaultProjectId: string | null }>("/api/slack/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  removeRepository(projectId: string, repositoryId: string) {
    return this.request<{ ok: boolean }>(`/api/projects/${projectId}/repositories/${repositoryId}`, {
      method: "DELETE",
    });
  }

  listFeatures(projectId: string) {
    return this.request<Feature[]>(`/api/features?projectId=${encodeURIComponent(projectId)}`);
  }

  /**
   * Every card's newest run status and latest spoken line, in one
   * request.
   *
   * A client that polls needs this for the whole board, not for the
   * card someone happens to have selected: a board where four of five
   * cards claim to be idle while their agents work is worse than no
   * status at all. The line snapshot already carries it, so this reads
   * that rather than asking per card and growing with the board.
   */
  async getBoardSnapshot(projectId: string): Promise<{ statuses: Record<string, string>; outputs: Record<string, string> }> {
    const token = await this.tokens?.get();
    const res = await this.fetchImpl(`${this.baseUrl}/api/projects/${projectId}/board/plain`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      credentials: this.tokens ? "omit" : "include",
    });
    if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText);
    const statuses: Record<string, string> = {};
    const outputs: Record<string, string> = {};
    for (const line of (await res.text()).split("\n")) {
      const [kind, id, , , runStatus, , , output] = line.split("|");
      if (kind !== "feature" || !id) continue;
      if (runStatus && runStatus !== "-") statuses[id] = runStatus;
      if (output && output !== "-") outputs[id] = output;
    }
    return { statuses, outputs };
  }

  /** Just the statuses of the board snapshot, for polling clients. */
  async getRunStatuses(projectId: string): Promise<Record<string, string>> {
    return (await this.getBoardSnapshot(projectId)).statuses;
  }

  createFeature(input: { projectId: string; title: string; description?: string }) {
    return this.request<Feature>("/api/features", { method: "POST", body: JSON.stringify(input) });
  }

  getFeature(featureId: string) {
    return this.request<Feature & { runs: AgentRun[]; pullRequests: FeaturePullRequest[] }>(
      `/api/features/${featureId}`,
    );
  }

  /**
   * Removes the card, its runs and their transcripts, and the sandbox
   * it was worked in. The branch and any pull request are left alone.
   * Refused with 409 while an agent works the card, and answered 404
   * for a card that is already gone.
   */
  deleteFeature(featureId: string) {
    return this.request<{ ok: boolean }>(`/api/features/${featureId}`, { method: "DELETE" });
  }

  advanceFeature(featureId: string) {
    return this.request<Feature>(`/api/features/${featureId}/advance`, { method: "POST" });
  }

  approveFeature(featureId: string) {
    return this.request<{ feature: Feature; gateChecks: unknown[] }>(`/api/features/${featureId}/approve`, {
      method: "POST",
    });
  }

  /** Rejects a manual gate, sending the card back for rework. */
  rejectFeature(featureId: string, reason?: string) {
    const query = reason ? `?reason=${encodeURIComponent(reason)}` : "";
    return this.request<Feature>(`/api/features/${featureId}/reject${query}`, { method: "POST" });
  }

  /**
   * Puts the card in any stage, or the backlog with null. Forward
   * behaves like advance, backward like send-back; no approval is
   * recorded either way.
   */
  moveFeature(featureId: string, stageId: string | null) {
    return this.request<Feature>(`/api/features/${featureId}/move`, {
      method: "POST",
      body: JSON.stringify({ stageId }),
    });
  }

  /** Sends the card back one stage, for work that needs redoing. */
  moveFeatureBack(featureId: string) {
    return this.request<Feature>(`/api/features/${featureId}/back`, { method: "POST" });
  }

  /**
   * Marks the card done from whatever stage it is in, skipping the rest
   * of the pipeline. It keeps that stage, so reopening returns it there.
   */
  finishFeature(featureId: string) {
    return this.request<Feature>(`/api/features/${featureId}/finish`, { method: "POST" });
  }

  /** Stops a running agent so a person can take over. */
  cancelRun(runId: string) {
    return this.request<AgentRun>(`/api/runs/${runId}/cancel`, { method: "POST" });
  }

  /** Everything that has happened to this feature, oldest first. */
  getHistory(featureId: string) {
    return this.request<FeatureEvent[]>(`/api/features/${featureId}/history`);
  }

  /** Appends a stage to a pipeline; it starts manual with no agent. */
  createStage(pipelineId: string, name: string) {
    return this.request<Stage>("/api/stages", { method: "POST", body: JSON.stringify({ pipelineId, name }) });
  }

  /** Removes an empty stage; refused while cards are in it. */
  deleteStage(stageId: string) {
    return this.request<{ ok: boolean }>(`/api/stages/${stageId}`, { method: "DELETE" });
  }

  getGate(featureId: string) {
    return this.request<GateState>(`/api/features/${featureId}/gate`);
  }

  /**
   * Says something to the card's agent. Resumes the latest session
   * immediately when the agent is idle; queues for delivery at the end
   * of the run when it is working. The result says which happened.
   */
  messageFeature(featureId: string, text: string) {
    return this.request<{
      queued: boolean;
      /** True when a live session took the message mid-run. */
      live?: boolean;
      /** How that session treats it: steered into the work, or read after this turn. */
      delivery?: "steer" | "queue";
      run?: AgentRun;
    }>(`/api/features/${featureId}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  /**
   * Every finished run's events in order, with who spoke them, plus
   * the messages still waiting for an agent (queued on the card or
   * sent to a run that has not confirmed a turn yet).
   */
  getConversation(featureId: string) {
    return this.request<{
      blocks: { runId: string; agentName: string; queuedAt: string; status: string; events: AgentEvent[] }[];
      pending: { id: string; text: string; status: "queued" | "sent"; createdAt: string }[];
    }>(`/api/features/${featureId}/conversation`);
  }

  /** Committed work: per-repo diffs and the stage write-ups, from the feature branch. */
  getChanges(featureId: string) {
    return this.request<FeatureChanges>(`/api/features/${featureId}/changes`);
  }

  /** The card's artifacts, newest first: write-ups, mockups, screenshots. */
  listArtifacts(featureId: string) {
    return this.request<RunArtifact[]>(`/api/features/${featureId}/artifacts`);
  }

  /** One artifact's body as text, for the kinds the console renders itself. */
  getArtifactText(artifactId: string) {
    return this.requestText(`/api/artifacts/${artifactId}/content`);
  }

  /**
   * One artifact's metadata, for a tab that opens the viewer by id
   * rather than from a card's already-loaded list.
   */
  getArtifact(artifactId: string) {
    return this.request<RunArtifact>(`/api/artifacts/${artifactId}`);
  }

  /**
   * Where an artifact's bytes are served. For <img> tags and download
   * links in the browser, which ride the session cookie; bearer-token
   * clients fetch through getArtifactText instead.
   */
  artifactContentUrl(artifactId: string): string {
    return `${this.baseUrl}/api/artifacts/${artifactId}/content`;
  }

  /** Pushes the card's branch and opens (or updates) its pull requests. */
  publishFeature(featureId: string) {
    return this.request<{
      published: { name: string; repoUrl: string; prNumber: number; url: string }[];
      failures: { name: string; reason: string }[];
    }>(`/api/features/${featureId}/publish`, { method: "POST" });
  }

  recheckGate(featureId: string) {
    return this.request<Feature>(`/api/features/${featureId}/recheck`, { method: "POST" });
  }

  linkPullRequest(featureId: string, prNumber: number) {
    return this.request<Feature>(`/api/features/${featureId}/link-pr`, {
      method: "POST",
      body: JSON.stringify({ prNumber }),
    });
  }

  listSecrets() {
    return this.request<{ id: string; name: string; hint: string }[]>("/api/secrets");
  }

  /** Values are write only: nothing reads a secret back. */
  createSecret(input: { name: string; value: string }) {
    return this.request<{ id: string; name: string; hint: string }>("/api/secrets", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  deleteSecret(secretId: string) {
    return this.request<{ ok: boolean }>(`/api/secrets/${secretId}`, { method: "DELETE" });
  }

  /**
   * Settings belonging to the machine the server runs on, and which
   * agent logins that machine has. Local mode only: a shared server
   * reports mode "multi" and nothing else.
   */
  getMachineSettings() {
    return this.request<{
      mode: "local" | "multi";
      shareAgentAuth: boolean;
      pinnedByEnv?: boolean;
      /** What is stored here, which the environment can still override. */
      gitAuthorName?: string;
      gitAuthorEmail?: string;
      /** What a commit would actually say, from whichever source wins. */
      gitIdentity?: { name: string; email: string } | null;
      gitIdentityPinnedByEnv?: boolean;
      logins: { cli: string; signedIn: boolean }[];
      claude?: { loggedIn: boolean; subscriptionType?: string; email?: string } | null;
    }>("/api/settings");
  }

  setShareAgentAuth(shareAgentAuth: boolean) {
    return this.request<{ shareAgentAuth: boolean }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ shareAgentAuth }),
    });
  }

  /** Who agent commits are attributed to. Blank clears it. */
  setGitIdentity(input: { gitAuthorName: string; gitAuthorEmail: string }) {
    return this.request<{ gitAuthorName: string; gitAuthorEmail: string }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  /**
   * Agent spend for a project. `runsWithoutCost` matters: the total
   * only covers tools that report one, and most do not. `byFeature`
   * is every card, so a spend page can sort without a second fetch.
   */
  getUsage(projectId: string) {
    return this.request<ProjectUsage>(`/api/projects/${projectId}/usage`);
  }

  listProfiles() {
    return this.request<AgentProfile[]>("/api/profiles");
  }

  createProfile(input: { name: string; cli: string; model: string; skill?: string }) {
    return this.request<AgentProfile>("/api/profiles", { method: "POST", body: JSON.stringify(input) });
  }

  /**
   * Changes an agent in place. Every stage pointing at it follows,
   * which is the difference between editing one and replacing it.
   */
  updateProfile(
    profileId: string,
    changes: { name?: string; cli?: string; model?: string; extraArgs?: string[]; skill?: string | null },
  ) {
    return this.request<AgentProfile>(`/api/profiles/${profileId}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
  }

  deleteProfile(profileId: string) {
    return this.request<{ ok: boolean }>(`/api/profiles/${profileId}`, { method: "DELETE" });
  }

  updateStage(
    stageId: string,
    patch: {
      name?: string;
      defaultAgentProfileId?: string | null;
      gateType?: "manual" | "auto";
      gateCriteria?: GateCriteria;
      createPr?: boolean;
    },
  ) {
    return this.request<Stage>(`/api/stages/${stageId}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  startRun(input: { featureId: string; agentProfileId: string; stageId?: string; prompt?: string }) {
    return this.request<AgentRun>("/api/runs", { method: "POST", body: JSON.stringify(input) });
  }

  quickRun(featureId: string, cli: string, model?: string) {
    const query = new URLSearchParams({ cli, ...(model ? { model } : {}) });
    return this.request<AgentRun>(`/api/features/${featureId}/quick-run?${query}`, { method: "POST" });
  }

  resumeRun(runId: string, prompt: string) {
    return this.request<AgentRun>(`/api/runs/${runId}/resume`, { method: "POST", body: JSON.stringify({ prompt }) });
  }

  /** Restores the sandbox to the snapshot taken before this run. */
  rollbackRun(runId: string) {
    return this.request<{ ok: boolean; restoredTo: string }>(`/api/runs/${runId}/rollback`, { method: "POST" });
  }

  getRun(runId: string) {
    return this.request<AgentRun>(`/api/runs/${runId}`);
  }

  /** Plain text transcript with a cursor, for clients that cannot hold SSE. */
  async getTranscript(runId: string, since = 0): Promise<{ cursor: number; status: string; lines: string[] }> {
    const token = await this.tokens?.get();
    const res = await this.fetchImpl(`${this.baseUrl}/api/runs/${runId}/transcript?since=${since}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      credentials: this.tokens ? "omit" : "include",
    });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    const text = await res.text();
    const [header = "cursor|0|unknown", ...lines] = text.split("\n");
    const [, cursor = "0", status = "unknown"] = header.split("|");
    return { cursor: Number(cursor), status, lines };
  }

  /**
   * Streams a run's events. Replays from `since`, then follows live
   * until the run ends. Returns a function that stops the stream.
   *
   * onDelta carries the typing: token sized fragments of the message
   * the agent is composing. Live only, never replayed; the finished
   * message arrives through onEvent and supersedes every fragment
   * before it.
   */
  streamRun(
    runId: string,
    handlers: RunStreamHandlers,
    since = 0,
  ): () => void {
    const url = `${this.baseUrl}/api/runs/${runId}/events?since=${since}`;
    // EventSource cannot carry an Authorization header, so a client
    // that authenticates with a bearer token (the TUI, the Mac app)
    // reads the same stream over fetch. This is why the TUI could
    // never follow a run live before.
    if (this.tokens) return this.streamRunWithFetch(url, handlers, since);

    /**
     * EventSource reconnects on its own after a drop, and the server
     * replays from ?since= on every connection, so without this
     * filter a wifi blip showed the whole conversation twice. The
     * seq rides on the SSE id field precisely so replays are
     * recognizable.
     */
    let lastSeq = since;
    const source = new EventSource(url, { withCredentials: true });
    source.addEventListener("run_event", (e) => {
      const message = e as MessageEvent<string>;
      const seq = Number(message.lastEventId);
      if (Number.isFinite(seq) && seq > 0) {
        if (seq <= lastSeq) return;
        lastSeq = seq;
      }
      handlers.onEvent?.(JSON.parse(message.data) as AgentEvent, seq);
    });
    source.addEventListener("run_delta", (e) => {
      handlers.onDelta?.(JSON.parse((e as MessageEvent<string>).data) as AgentDelta);
    });
    source.addEventListener("done", (e) => {
      const message = e as MessageEvent<string>;
      handlers.onDone?.((JSON.parse(message.data) as { status: string }).status);
      source.close();
    });
    return () => source.close();
  }

  /**
   * The SSE stream over plain fetch: same frames, but the request can
   * carry the bearer token. Reconnects after a drop from the last seen
   * seq, which is the same recovery a browser gets from EventSource
   * itself: the server replays persisted events past ?since=, so a
   * deploy or a network blip costs at most the in-flight typing. It
   * used to not reconnect at all, and the TUI spent the rest of the
   * run on its polling fallback with nothing saying so.
   *
   * It keeps trying for as long as the caller wants the stream, with
   * the delay capped, because the outage it most has to survive is a
   * deploy: the agent works on inside its sandbox and the restarted
   * server reattaches to it, so a client that gave up after a handful
   * of seconds would go blind exactly when there was still something
   * to watch. Only a refusal that retrying cannot fix, an expired or
   * rejected token, stops the loop and reaches onError.
   */
  private streamRunWithFetch(url: string, handlers: RunStreamHandlers, since: number): () => void {
    const controller = new AbortController();
    const base = url.replace(/\?since=\d+$/, "");
    let lastSeq = since;
    void (async () => {
      let failures = 0;
      while (!controller.signal.aborted) {
        try {
          const token = await this.tokens!.get();
          const res = await this.fetchImpl(`${base}?since=${lastSeq}`, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
            credentials: "omit",
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new ApiError(res.status, res.statusText);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const parser = new SseParser();
          /**
           * Whether this connection carried anything. The backoff grows
           * on connections that deliver nothing as well as on ones that
           * fail outright, because a server that accepts and closes at
           * once would otherwise be reconnected to every second for as
           * long as it kept doing it.
           */
          let carried = false;
          while (true) {
            const { value, done } = await reader.read();
            // The server only ends the stream on purpose after a done
            // frame; a bare end is a disconnect, so reconnect and let
            // ?since= deduplicate.
            if (done) break;
            carried = true;
            failures = 0;
            for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
              // A consumer handler that throws must not kill the
              // stream: the frames after it are still wanted.
              try {
                if (frame.event === "run_event") {
                  const seq = Number(frame.id);
                  if (Number.isFinite(seq) && seq > 0) {
                    if (seq <= lastSeq) continue;
                    lastSeq = seq;
                  }
                  handlers.onEvent?.(JSON.parse(frame.data) as AgentEvent, seq);
                } else if (frame.event === "run_delta") {
                  handlers.onDelta?.(JSON.parse(frame.data) as AgentDelta);
                } else if (frame.event === "done") {
                  handlers.onDone?.((JSON.parse(frame.data) as { status: string }).status);
                  controller.abort();
                  return;
                }
              } catch (err) {
                handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
              }
            }
          }
          if (!carried) failures += 1;
        } catch (err) {
          if (controller.signal.aborted) return;
          // A credential the server refuses is the one failure another
          // attempt cannot mend, so it ends the stream and is said out
          // loud. Everything else is an outage to wait out.
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            handlers.onError?.(err);
            return;
          }
          failures += 1;
        }
        if (controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * 2 ** failures, 8_000)));
      }
    })();
    return () => controller.abort();
  }

  /**
   * Streams board changes for a project (card moved, run status changed).
   *
   * Board events live only in memory on the server, so anything emitted
   * while this stream was down (a deploy, a network drop) never arrives.
   * `onReconnect` fires when the stream opens again after a drop, which
   * is the caller's cue to refetch a snapshot and fill the gap.
   */
  streamBoard(projectId: string, onEvent: (event: unknown) => void, onReconnect?: () => void): () => void {
    const source = new EventSource(`${this.baseUrl}/api/board/${projectId}/events`, {
      withCredentials: !this.tokens,
    });
    let opened = false;
    source.onopen = () => {
      if (opened) onReconnect?.();
      opened = true;
    };
    source.addEventListener("board_event", (e) => onEvent(JSON.parse((e as MessageEvent<string>).data)));
    return () => source.close();
  }
}
