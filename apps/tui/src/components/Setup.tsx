import { useKeyboardInput as useInput } from "../mouse.js";
import {
  Children,
  cloneElement,
  createContext,
  useContext,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from "react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Box, Text, useStdin, useWindowSize, usePaste } from "ink";
import {
  AGENT_CREDENTIALS,
  MODEL_GUIDANCE,
  checkAgentPairing,
  modelStringFor,
  providersForCli,
  resolveRepositoryCommands,
  type AgentCli,
} from "@bento/core";
import type { GateCriteria, GateCriterion } from "@bento/core";
import { getAdapter } from "@bento/agents";
import { terminalText } from "../terminal.js";
import type { AgentProfile, AgentTool, BentoClient, Project, Repository, Stage } from "@bento/api-client";
import { useMouseTarget, useSuspendMouse } from "../mouse.js";
import { MouseActions, MouseButton } from "./MouseControls.js";
import { TextInput } from "./TextInput.js";
import { AgentEditor } from "./AgentEditor.js";
import { Form } from "./Form.js";
import { Navigator } from "./Navigator.js";
export type SettingsSection = "integrations" | "mcp" | "team" | "account" | "billing" | "identity";
import { CRITERION_KINDS, describeCriterion } from "../criteria.js";
import { prepareRepositoryPath, repositoryNameHint, type RepositoryPathOwner } from "../repository-path.js";

/**
 * Everything needed before a board can do any work: the repositories
 * agents check out, the tools and models they run, which stage uses
 * which, and the provider keys that pay for it.
 *
 * A hub rather than a linear wizard, so it shows what is already set and
 * can be reopened later to change one thing. Nothing here is a step a
 * person should have to do by calling the API themselves.
 */
type Screen =
  | { name: "hub" }
  | { name: "repos" }
  | { name: "repoPath"; value: string }
  | { name: "agents" }
  | { name: "agentProvider"; cli: AgentCli }
  | { name: "agentModelList"; cli: AgentCli; providerId: string }
  | { name: "agentModel"; cli: AgentCli; value: string }
  | { name: "agentEdit"; profile: AgentProfile }
  | { name: "stages" }
  | { name: "stageDetails"; stageId: string }
  | { name: "stageGate"; stageId: string }
  | { name: "stageDelete"; stageId: string }
  | { name: "stagePrompt"; stageId: string; value: string }
  | { name: "criteria"; stageId: string }
  | { name: "criterionCmd"; stageId: string; value: string }
  /** Which agent rules on the work, for an agent_judge requirement. */
  | { name: "judge"; stageId: string }
  | { name: "assign"; stageId: string }
  | { name: "stageName"; stageId: string; value: string }
  | { name: "newStage"; value: string }
  | { name: "keys" }
  | { name: "subscription" }
  | { name: "keyValue"; credential: string; from: "keys"; value: string }
  | { name: "yamlAgents" }
  | { name: "yamlPipeline" }
  | {
      name: "yamlPath";
      kind: "agents-export" | "agents-import" | "pipeline-export" | "pipeline-import";
      value: string;
    }
  | { name: "repoSetup"; repoId: string; value: string };

/** What the server reports about the machine it runs on. */
type MachineSettings = Awaited<ReturnType<BentoClient["getMachineSettings"]>>;

/** Screens where typing composes text rather than driving a list. */
const TYPING = new Set([
  "repoPath",
  "agentModel",
  "agentEdit",
  "stageName",
  "stageDetails",
  "stageGate",
  "stageDelete",
  "stagePrompt",
  "newStage",
  "keyValue",
  "criterionCmd",
  "yamlPath",
  "repoSetup",
]);

/**
 * Model provider credentials, and only those.
 *
 * The Claude subscription token belongs to the subscription row, which
 * is where someone looking for it goes, and the GitHub token buys pull
 * requests rather than models. One list holding all three taught people
 * this screen was about something broader than it is.
 */
const PROVIDER_CREDENTIALS = AGENT_CREDENTIALS.filter(
  (credential) => credential.name !== "CLAUDE_CODE_OAUTH_TOKEN" && credential.name !== "GITHUB_TOKEN",
);

/** Screens whose hint advertises d, so d owes an answer on every row. */
const REMOVABLE = new Set(["repos", "agents", "criteria", "keys", "stages"]);

/** The key whose presence means a provider is paid for, per provider. */
export const PROVIDER_KEYS = [
  { label: "Anthropic", name: "ANTHROPIC_API_KEY" },
  { label: "OpenAI", name: "OPENAI_API_KEY" },
  { label: "OpenRouter", name: "OPENROUTER_API_KEY" },
  { label: "Cursor", name: "CURSOR_API_KEY" },
  { label: "Gemini", name: "GEMINI_API_KEY" },
  { label: "Poolside", name: "POOLSIDE_API_KEY" },
  { label: "DeepSeek", name: "DEEPSEEK_API_KEY" },
] as const;

type SetupPointer = {
  pick: (index: number) => void;
  move: (delta: number) => void;
  key: (input: string) => void;
  back: () => void;
  typing: boolean;
  busy: boolean;
  actions: { label: string; key: string }[];
};
const SetupMouse = createContext<SetupPointer | null>(null);

export function Setup({
  client,
  repositoryPathOwner,
  agentsRunLocally,
  selectedProjectId,
  serverMode = "local",
  onSection,
  onDone,
}: {
  client: BentoClient;
  /** The machine whose filesystem repository paths refer to. */
  repositoryPathOwner: RepositoryPathOwner;
  /** Whether agents execute on this machine, which is what makes its logins usable. */
  agentsRunLocally: boolean;
  selectedProjectId?: string | undefined;
  serverMode?: "local" | "multi";
  onSection?: (section: SettingsSection) => void;
  onDone: () => void;
}) {
  const [screen, setScreen] = useState<Screen>({ name: "hub" });
  const { columns } = useWindowSize();
  const [index, setIndex] = useState(0);
  /**
   * The selected row, readable synchronously.
   *
   * Keystrokes arrive faster than React re-renders, so a move followed
   * quickly by Enter would otherwise act on the row selected one render
   * ago. Pressing j and return in quick succession is ordinary typing,
   * not an edge case.
   */
  const indexRef = useRef(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  /** Needed to append a stage; a project has exactly one pipeline. */
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<{ id: string; name: string; hint: string }[]>([]);
  const [canManageCredentials, setCanManageCredentials] = useState(false);
  const [machine, setMachine] = useState<MachineSettings | null>(null);
  /** Coding tools signed in wherever the agents actually run. */
  const [logins, setLogins] = useState<{ cli: string; label: string; signedIn: boolean; detail?: string }[]>([]);
  /**
   * Which coding agents this deployment can actually start. Absent when
   * the question could not be answered, which is shown as nothing at
   * all rather than as "missing".
   */
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const { setRawMode, isRawModeSupported } = useStdin();
  const suspendMouse = useSuspendMouse();

  const project =
    projects.find((p) => p.id === selectedProjectId || p.name === selectedProjectId) ?? projects[0] ?? null;
  const existingAgents = profiles;
  const hints: Record<string, string> = Object.fromEntries(secrets.map((row) => [row.name, row.hint]));

  async function load() {
    const [projectRows, profileRows, secretRows, machineRow, toolRows] = await Promise.all([
      client.listProjects(),
      client.listProfiles(),
      client.listSecrets(),
      // A shared server has no machine to configure, and an older one
      // has no such route; neither is worth failing setup over.
      client.getMachineSettings().catch(() => null),
      client.listAgentTools().catch(() => []),
    ]);
    setProjects(projectRows);
    setProfiles(profileRows);
    setSecrets(secretRows.secrets);
    setCanManageCredentials(secretRows.canManage);
    setMachine(machineRow);
    setTools(toolRows);
    // In local mode the server is this process, so its report and this
    // machine's are the same answer. With a remote server they are not:
    // the agents run here, so the logins that matter are here, and the
    // server's own are none of this machine's business.
    setLogins(
      machineRow && machineRow.mode === "local" && machineRow.logins.length > 0
        ? machineRow.logins.map((row) => ({
            cli: row.cli,
            label: toolLabel(row.cli),
            signedIn: row.signedIn,
            ...(row.detail ? { detail: row.detail } : {}),
          }))
        : agentsRunLocally
          ? localLogins()
          : [],
    );
    const first =
      projectRows.find((p) => p.id === selectedProjectId || p.name === selectedProjectId) ?? projectRows[0];
    if (first) {
      const [pipeline, repoRows] = await Promise.all([
        client.getPipeline(first.id),
        client.listRepositories(first.id),
      ]);
      setStages(pipeline.stages);
      setPipelineId(pipeline.id);
      setRepos(repoRows);
    } else {
      setStages([]);
      setPipelineId(null);
      setRepos([]);
    }
  }

  useEffect(() => {
    void load()
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Hands the terminal to `claude auth login`, which prompts and then
   * opens a browser.
   *
   * Ink holds stdin in raw mode to read keystrokes, which would swallow
   * the answers the prompt is waiting for, so raw mode is released for
   * the duration and taken back afterwards. The status is re-read at
   * the end either way: a cancelled login is not an error worth
   * shouting about, it just leaves things as they were.
   */
  async function signInToClaude(): Promise<void> {
    setBusy(true);
    setError("");
    const restoreMouse = suspendMouse();
    try {
      if (isRawModeSupported) setRawMode(false);
      await new Promise<void>((resolve, reject) => {
        const child = spawn("claude", ["auth", "login"], { stdio: "inherit" });
        child.on("error", () =>
          reject(new Error("could not run `claude`. Install Claude Code, or check it is on your PATH.")),
        );
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`claude auth login exited ${code}`)),
        );
      });
      setNotice("Signed in to Claude Code.");
    } catch (err) {
      setError(message(err));
    } finally {
      if (isRawModeSupported) setRawMode(true);
      restoreMouse();
      setBusy(false);
      await load().catch(() => {});
    }
  }

  /**
   * Runs a mutation, then refreshes so the hub reflects it. Returns
   * whether it worked, because callers navigate on success and moving
   * screens clears the error that explains a failure.
   */
  async function act(what: string, fn: () => Promise<unknown>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
      setNotice(what);
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function go(next: Screen) {
    setScreen(next);
    indexRef.current = 0;
    setIndex(0);
    setNotice("");
    setError("");
  }

  /** Create a new agent once its harness and model have been selected. */
  function saveAgent(cli: AgentCli, model: string) {
    const trimmed = model.trim();
    if (!trimmed) return;
    // The server refuses a pairing its tool cannot reach, and so does
    // the console, but only after a round trip. Saying it here is the
    // same sentence at the moment the model was typed.
    const pairing = checkAgentPairing(cli, trimmed);
    if (pairing.status === "impossible") {
      setError(pairing.detail);
      return;
    }
    const label = MODEL_GUIDANCE.find((g) => g.cli === cli)?.label ?? cli;
    // Two profiles for one tool need telling apart, so the model joins
    // the name only when the plain label is already taken.
    const name = profiles.some((p) => p.name === label) ? `${label} ${trimmed}` : label;
    void act(`Added ${label} on ${trimmed}`, () => client.createProfile({ name, cli, model: trimmed })).then(
      (ok) => {
        if (ok) go({ name: "agents" });
      },
    );
  }

  async function saveStage(stageId: string, patch: Parameters<BentoClient["updateStage"]>[1]) {
    if (await act("Stage updated", () => client.updateStage(stageId, patch)))
      go({ name: "stageDetails", stageId });
  }
  async function moveStage(stageId: string, delta: number) {
    if (!project) return;
    if (
      await act("Stage order updated", async () => {
        const fresh = await client.getPipeline(project.id);
        const ids = fresh.stages.map((stage) => stage.id);
        const from = ids.indexOf(stageId),
          to = from + delta;
        if (from < 0 || to < 0 || to >= ids.length)
          throw new Error("The pipeline changed. Open the stage again.");
        [ids[from], ids[to]] = [ids[to]!, ids[from]!];
        await client.reorderStages(fresh.id, ids);
      })
    )
      go({ name: "stageDetails", stageId });
  }

  /** The criteria currently on a stage. */
  function criteriaOf(stageId: string): GateCriterion[] {
    return [...((stages.find((s) => s.id === stageId)?.gateCriteria ?? []) as GateCriterion[])];
  }

  /**
   * Whether a stage consults requirements at all. A stage carrying the
   * legacy manual criterion is manual whatever its mode field says,
   * which is the rule the evaluator itself follows.
   */
  function isAutomatic(stageId: string): boolean {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage) return false;
    return stage.gateType === "auto" && !criteriaOf(stageId).some((c) => c.type === "manual");
  }

  function moveBy(delta: number) {
    const rows = rowCount();
    indexRef.current = Math.max(0, Math.min(indexRef.current + delta, rows - 1));
    setIndex(indexRef.current);
  }

  const assigned = stages.filter((s) => s.defaultAgentProfileId).length;

  const hubRows = [
    {
      label: "Repositories",
      status: project ? `${project.name}, ${repos.length} checked out` : "none connected yet",
      open: () => go({ name: "repos" }),
    },
    {
      label: "Agents",
      status: `${profiles.length} configured · harness, model and prompt`,
      open: () => go({ name: "agents" }),
    },
    {
      label: "Pipeline",
      status: !project ? "connect a repository first" : `${assigned} of ${stages.length} have an agent`,
      open: () => (project ? go({ name: "stages" }) : setNotice("Connect a repository first.")),
    },
    // Logins on this machine are worth offering exactly when this
    // machine runs the agents, which a thin client does not.
    ...(agentsRunLocally
      ? [
          {
            label: "Local agent sign-ins",
            status: subscriptionStatus(machine, logins),
            open: () => go({ name: "subscription" }),
          },
        ]
      : []),
    {
      label: "Model provider keys",
      status: providerKeyStatus(hints),
      open: () => go({ name: "keys" }),
    },
    ...(onSection
      ? [
          {
            label: "MCP",
            status: "featured servers, connections and custom servers",
            open: () => onSection("mcp"),
          },
          {
            label: "Integrations",
            status: "GitHub, Linear" + (serverMode === "multi" ? ", Slack" : ""),
            open: () => onSection("integrations"),
          },
          ...(serverMode === "multi"
            ? [
                {
                  label: "Team",
                  status: "organizations, members and invitations",
                  open: () => onSection("team"),
                },
                { label: "Account", status: "profile and sign out", open: () => onSection("account") },
                { label: "Billing", status: "plan and usage", open: () => onSection("billing") },
              ]
            : [
                {
                  label: "Git identity",
                  status: "commit author name and email",
                  open: () => onSection("identity"),
                },
              ]),
        ]
      : []),
    { label: "Back to board", status: "", open: onDone },
  ];

  usePaste(() => setNotice("Choose a text field before pasting."), {
    isActive: isRawModeSupported === true && !TYPING.has(screen.name),
  });

  const handleSetupInput = (input: string, key: Partial<import("ink").Key> = {}) => {
    // Moving and leaving stay responsive while a save is in flight;
    // only the actions that would start a second one are held back.
    if (key.downArrow || input === "j") moveBy(1);
    if (key.upArrow || input === "k") moveBy(-1);

    if (key.escape || (input === "q" && screen.name === "hub")) {
      if (screen.name === "hub") onDone();
      else if (screen.name === "yamlAgents") go({ name: "agents" });
      else if (screen.name === "yamlPipeline") go({ name: "stages" });
      else if (screen.name === "criteria" || screen.name === "assign")
        go({ name: "stageDetails", stageId: screen.stageId });
      else if (screen.name === "judge") go({ name: "criteria", stageId: screen.stageId });
      else go({ name: "hub" });
      return;
    }

    if (busy || loading) return;

    if (screen.name === "subscription") {
      if (input === "s") {
        if (machine?.mode !== "local") {
          setNotice("The board is on a server, so this is chosen at launch: pass --share-agent-auth.");
          return;
        }
        if (machine.pinnedByEnv) {
          setNotice("BENTO_SHARE_AGENT_AUTH is set, so this is decided at launch.");
          return;
        }
        const next = !(machine?.shareAgentAuth ?? false);
        void act(next ? "Sharing this machine's logins with runs" : "No longer sharing logins", () =>
          client.setShareAgentAuth(next),
        );
        return;
      }
      if (input === "l") {
        void signInToClaude();
        return;
      }
      return;
    }

    // Deleting is a d away wherever a saved thing is listed.
    if (input === "d") {
      if (screen.name === "criteria") {
        const current = criteriaOf(screen.stageId);
        const doomed = current[indexRef.current];
        if (doomed) {
          const next = current.filter((_, i) => i !== indexRef.current);
          void act("Removed the requirement", () =>
            client.updateStage(screen.stageId, { gateCriteria: next as GateCriteria }),
          );
          return;
        }
      }
      if (screen.name === "stages") {
        const stage = stages[indexRef.current];
        if (stage) {
          // The server refuses while cards are in the stage, and its
          // refusal names the fix, so it is shown rather than
          // second-guessed here.
          go({ name: "stageDelete", stageId: stage.id });
          return;
        }
      }
      if (screen.name === "agents" && existingAgents[indexRef.current]) {
        const profile = existingAgents[indexRef.current]!;
        void act(`Removed ${profile.name}`, () => client.deleteProfile(profile.id));
        return;
      }
      if (screen.name === "keys") {
        if (!canManageCredentials) {
          setNotice("Only owners and admins can change credentials.");
          return;
        }
        const credential = PROVIDER_CREDENTIALS[indexRef.current];
        const saved = credential && secrets.find((s) => s.name === credential.name);
        if (saved) {
          void act(`Removed ${saved.name}`, () => client.deleteSecret(saved.id));
          return;
        }
      }
      if (screen.name === "repos" && project && repos[indexRef.current]) {
        const repo = repos[indexRef.current]!;
        if (repos.length === 1) {
          setNotice("A project keeps at least one repository.");
          return;
        }
        void act(`Removed ${repo.name}`, () => client.removeRepository(project.id, repo.id));
        return;
      }
      // A screen whose hint advertises d owes an answer on every row,
      // including the ones with nothing behind them.
      if (REMOVABLE.has(screen.name)) setNotice("Nothing saved here yet.");
      return;
    }

    if (input === "e" && screen.name === "agents") {
      const profile = existingAgents[indexRef.current];
      if (profile) go({ name: "agentEdit", profile });
      return;
    }

    if (!key.return) return;
    choose();
  };
  useInput(handleSetupInput, { isActive: !TYPING.has(screen.name) && isRawModeSupported === true });

  /** How many selectable rows the current screen shows. */
  function rowCount(): number {
    switch (screen.name) {
      case "hub":
        return hubRows.length;
      case "repos":
        return repos.length + 2; // repositories, add, back
      case "agents":
        return existingAgents.length + MODEL_GUIDANCE.length + 2;
      case "criteria":
        // A manual stage consults no requirements, so it offers none:
        // only the way back.
        return isAutomatic(screen.stageId)
          ? criteriaOf(screen.stageId).length + CRITERION_KINDS.length + 1
          : 1;
      case "judge":
        return profiles.length + 1; // judges, then back
      case "agentProvider":
        return providersForCli(screen.cli).length + 1; // providers, then manual
      case "agentModelList":
        return modelsFor(screen.cli, screen.providerId).length + 1;
      case "stages":
        return stages.length + 3; // stages, add, import/export, back
      case "assign":
        return profiles.length + 1; // profiles, then no agent
      case "keys":
        return PROVIDER_CREDENTIALS.length + 1;
      case "yamlAgents":
      case "yamlPipeline":
        return 3; // export, import, back
      default:
        return 1;
    }
  }

  function choose() {
    const index = indexRef.current;
    switch (screen.name) {
      case "hub":
        hubRows[index]?.open();
        return;
      case "repos": {
        if (index === repos.length) {
          go({ name: "repoPath", value: repositoryPathOwner === "client" ? process.cwd() : "" });
        } else if (index === repos.length + 1) {
          go({ name: "hub" });
        } else if (project && repos[index]) {
          go({ name: "repoSetup", repoId: repos[index]!.id, value: repos[index]!.setupCommand ?? "" });
        }
        return;
      }
      case "yamlAgents": {
        if (index === 0) go({ name: "yamlPath", kind: "agents-export", value: "agents.yaml" });
        else if (index === 1) go({ name: "yamlPath", kind: "agents-import", value: "agents.yaml" });
        else go({ name: "agents" });
        return;
      }
      case "yamlPipeline": {
        if (index === 0) go({ name: "yamlPath", kind: "pipeline-export", value: "pipeline.yaml" });
        else if (index === 1) go({ name: "yamlPath", kind: "pipeline-import", value: "pipeline.yaml" });
        else go({ name: "stages" });
        return;
      }
      case "agents": {
        if (index < existingAgents.length) {
          go({ name: "agentEdit", profile: existingAgents[index]! });
          return;
        }
        const at = index - existingAgents.length;
        if (at === MODEL_GUIDANCE.length) {
          go({ name: "yamlAgents" });
          return;
        }
        if (at === MODEL_GUIDANCE.length + 1) {
          go({ name: "hub" });
          return;
        }
        const tool = MODEL_GUIDANCE[at]!;
        const cli = tool.cli as AgentCli;
        const options = providersForCli(cli);
        // One provider is not a choice, so skip straight to its models.
        if (options.length === 1) {
          go({ name: "agentModelList", cli, providerId: options[0]!.id });
          return;
        }
        if (options.length === 0) {
          go({ name: "agentModel", cli, value: tool.defaultModel });
          return;
        }
        go({ name: "agentProvider", cli });
        return;
      }
      case "agentProvider": {
        const options = providersForCli(screen.cli);
        if (index === options.length) {
          const tool = MODEL_GUIDANCE.find((g) => g.cli === screen.cli);
          go({ name: "agentModel", cli: screen.cli, value: tool?.defaultModel ?? "" });
          return;
        }
        go({ name: "agentModelList", cli: screen.cli, providerId: options[index]!.id });
        return;
      }
      case "agentModelList": {
        const provider = providersForCli(screen.cli).find((p) => p.id === screen.providerId);
        const models = provider?.models ?? [];
        if (index === models.length) {
          const tool = MODEL_GUIDANCE.find((g) => g.cli === screen.cli);
          go({ name: "agentModel", cli: screen.cli, value: tool?.defaultModel ?? "" });
          return;
        }
        const model = models[index]!;
        const value = modelStringFor(screen.cli, screen.providerId, model.id);
        saveAgent(screen.cli, value);
        return;
      }
      case "stages": {
        if (index === stages.length) {
          if (!pipelineId) {
            setNotice("Connect a repository first.");
            return;
          }
          go({ name: "newStage", value: "" });
          return;
        }
        if (index === stages.length + 1) {
          go({ name: "yamlPipeline" });
          return;
        }
        if (index === stages.length + 2) {
          go({ name: "hub" });
          return;
        }
        go({ name: "stageDetails", stageId: stages[index]!.id });
        return;
      }
      case "criteria": {
        if (!isAutomatic(screen.stageId)) {
          go({ name: "stageDetails", stageId: screen.stageId });
          return;
        }
        const current = criteriaOf(screen.stageId);
        if (index < current.length) {
          setNotice("Press d to remove this requirement.");
          return;
        }
        const at = index - current.length;
        if (at === CRITERION_KINDS.length) {
          go({ name: "stageDetails", stageId: screen.stageId });
          return;
        }
        const kind = CRITERION_KINDS[at]!;
        if (kind.type === "command") {
          go({ name: "criterionCmd", stageId: screen.stageId, value: "" });
          return;
        }
        if (current.some((c) => c.type === kind.type)) {
          setNotice("That requirement is already on this stage.");
          return;
        }
        // A judge is an agent, so it needs naming before it can be added.
        if (kind.type === "agent_judge") {
          if (profiles.length === 0) {
            setNotice("Add a coding agent first: a judge is one of them.");
            return;
          }
          go({ name: "judge", stageId: screen.stageId });
          return;
        }
        void act("Added the requirement", () =>
          client.updateStage(screen.stageId, {
            gateCriteria: [...current, { type: kind.type }] as GateCriteria,
          }),
        );
        return;
      }
      case "judge": {
        if (index === profiles.length) {
          go({ name: "criteria", stageId: screen.stageId });
          return;
        }
        const judge = profiles[index]!;
        const current = criteriaOf(screen.stageId);
        void act(`${judge.name} verifies the work is complete`, () =>
          client.updateStage(screen.stageId, {
            gateCriteria: [...current, { type: "agent_judge", agentProfileId: judge.id }] as GateCriteria,
          }),
        ).then((ok) => {
          if (ok) go({ name: "criteria", stageId: screen.stageId });
        });
        return;
      }
      case "assign": {
        const stageId = screen.stageId;
        const stage = stages.find((s) => s.id === stageId);
        const profile = profiles[index];
        const defaultAgentProfileId = index === profiles.length ? null : (profile?.id ?? null);
        void act(
          defaultAgentProfileId
            ? `${stage?.name ?? "Stage"} runs ${profile?.cli} ${profile?.model}`
            : `${stage?.name ?? "Stage"} has no agent`,
          () => client.updateStage(stageId, { defaultAgentProfileId }),
        ).then((ok) => {
          if (ok) go({ name: "stageDetails", stageId });
        });
        return;
      }
      case "keys": {
        const credential = PROVIDER_CREDENTIALS[index];
        if (!credential) {
          go({ name: "hub" });
          return;
        }
        if (!canManageCredentials) {
          setNotice("Only owners and admins can change credentials.");
          return;
        }
        go({ name: "keyValue", credential: credential.name, from: "keys", value: "" });
        return;
      }
      default:
        return;
    }
  }

  const mouseActions = [
    ...(screen.name === "agents" ? [{ label: "Edit", key: "e" }] : []),
    ...(REMOVABLE.has(screen.name) && (screen.name !== "keys" || canManageCredentials)
      ? [{ label: "Remove", key: "d" }]
      : []),
    ...(screen.name === "subscription"
      ? [
          { label: "Toggle sharing", key: "s" },
          { label: "Sign in to Claude", key: "l" },
        ]
      : []),
  ];
  return (
    <SetupMouse.Provider
      key={screen.name}
      value={{
        pick: (row) => {
          if (busy || loading) return;
          indexRef.current = row;
          setIndex(row);
          choose();
        },
        move: (delta) => {
          if (!TYPING.has(screen.name)) moveBy(delta);
        },
        key: (input) => handleSetupInput(input),
        back: () => handleSetupInput("", { escape: true }),
        typing: TYPING.has(screen.name),
        busy: busy || loading,
        actions: mouseActions,
      }}
    >
      {renderScreen()}
    </SetupMouse.Provider>
  );

  function renderScreen(): React.ReactNode {
    if (error && screen.name === "hub" && projects.length === 0 && profiles.length === 0) {
      return (
        <Box flexDirection="column">
          <Text color="red">{error}</Text>
          <MouseActions>
            <MouseButton
              label="Retry"
              onClick={() => {
                setError("");
                setLoading(true);
                void load()
                  .catch((err: unknown) => setError(message(err)))
                  .finally(() => setLoading(false));
              }}
            />
            <MouseButton label="Back" onClick={onDone} />
          </MouseActions>
        </Box>
      );
    }

    // Typing screens each own the keyboard while they are up.
    if (loading)
      return (
        <Box flexDirection="column">
          <Text color="gray">Loading project settings…</Text>
          <MouseButton label="Back" onClick={onDone} />
        </Box>
      );

    if (screen.name === "repoPath") {
      const pathLocation = repositoryPathOwner === "client" ? "this machine" : "the server";
      return (
        <Form
          title={project ? "Connect a repository" : "Create project"}
          fields={[
            ...(!project
              ? [{ id: "name", label: "Project name (optional)", placeholder: "Use the repository name" }]
              : []),
            { id: "path", label: `Repository path on ${pathLocation}`, value: screen.value, required: true },
          ]}
          description="Choose the Git checkout agents will use."
          submitLabel={project ? "Connect repository" : "Create project"}
          onCancel={() => go({ name: "repos" })}
          onSubmit={async ({ path: raw = "", name = "" }) => {
            const dir = prepareRepositoryPath(raw, repositoryPathOwner);
            if (!dir) throw new Error("Enter a repository path.");
            const problem = repositoryPathOwner === "client" ? pathProblem(dir) : null;
            if (problem) throw new Error(problem);
            if (project) await client.addRepository(project.id, { localPath: dir });
            else await client.createProject({ name: name.trim() || repositoryNameHint(dir), localPath: dir });
            await load();
            go({ name: "repos" });
          }}
        />
      );
    }

    if (screen.name === "agentProvider") {
      const options = providersForCli(screen.cli);
      const tool = MODEL_GUIDANCE.find((g) => g.cli === screen.cli);
      return (
        <Frame
          title={`${tool?.label ?? screen.cli}: which provider?`}
          hint="j/k move · Enter choose · Escape back"
        >
          <Text color="gray">Only providers this tool can reach are listed.</Text>
          <Box flexDirection="column" marginTop={1}>
            {options.map((provider, i) => (
              <Row
                key={provider.id}
                selected={i === index}
                label={provider.name}
                status={`${provider.models.length} models`}
              />
            ))}
            <Row selected={index === options.length} label="Type a model id myself" />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "agentModelList") {
      const models = modelsFor(screen.cli, screen.providerId);
      const tool = MODEL_GUIDANCE.find((g) => g.cli === screen.cli);
      // A provider can list hundreds, so show a window around the cursor.
      const size = 12;
      const start = Math.max(0, Math.min(index - Math.floor(size / 2), models.length - size));
      const visible = models.slice(Math.max(0, start), Math.max(0, start) + size);
      return (
        <Frame
          title={`${tool?.label ?? screen.cli}: which model?`}
          hint="j/k move · Enter choose · Escape back"
          notice={notice}
          error={error}
        >
          <Text color="gray">
            {models.length} models, {index + 1} of {models.length + 1}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {visible.map((model, i) => (
              <Row
                key={model.id}
                selected={Math.max(0, start) + i === index}
                label={model.name.slice(0, 28)}
                status={model.id}
              />
            ))}
            <Row selected={index === models.length} label="Type a model id myself" />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "agentModel") {
      const tool = MODEL_GUIDANCE.find((g) => g.cli === screen.cli)!;
      return (
        <Frame title={`${tool.label}: which model?`} hint="Enter to save, Escape to go back" error={error}>
          <Text color="gray">{tool.format}</Text>
          <Text color="gray">For example {tool.examples.join(", ")}</Text>
          <Box marginTop={1}>
            <Text>Model: </Text>
            <TextInput
              value={screen.value}
              onChange={(value) => setScreen({ ...screen, value })}
              onCancel={() => go({ name: "agents" })}
              onSubmit={(model) => saveAgent(screen.cli, model)}
            />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "agentEdit") {
      return (
        <AgentEditor
          profile={screen.profile}
          onCancel={() => go({ name: "agents" })}
          onSave={async (draft) => {
            await client.updateProfile(screen.profile.id, draft);
            await load();
            go({ name: "agents" });
            setNotice(`Updated ${draft.name}.`);
          }}
        />
      );
    }

    if (screen.name === "stageDetails" || screen.name === "stageGate" || screen.name === "stageDelete") {
      const stage = stages.find((item) => item.id === screen.stageId);
      if (!stage)
        return (
          <Box flexDirection="column">
            <Text>Stage no longer exists.</Text>
            <MouseButton label="Back to pipeline" onClick={() => go({ name: "stages" })} />
          </Box>
        );
      if (busy) return <Text>Saving stage…</Text>;
      const at = stages.findIndex((item) => item.id === stage.id);
      const choices =
        screen.name === "stageDelete"
          ? [
              {
                id: "delete",
                label: `Delete ${stage.name}`,
                select: () => {
                  void act("Stage removed", () => client.deleteStage(stage.id)).then((ok) => {
                    if (ok) go({ name: "stages" });
                  });
                },
              },
              {
                id: "cancel",
                label: "Cancel",
                select: () => go({ name: "stageDetails", stageId: stage.id }),
              },
            ]
          : screen.name === "stageGate"
            ? [
                {
                  id: "manual",
                  label: "Manual approval",
                  select: () => {
                    void saveStage(stage.id, { gateType: "manual" });
                  },
                },
                {
                  id: "auto",
                  label: "Automatic when requirements pass",
                  select: () => {
                    void saveStage(stage.id, {
                      gateType: "auto",
                      gateCriteria: criteriaOf(stage.id).filter(
                        (criterion) => criterion.type !== "manual",
                      ) as GateCriteria,
                    });
                  },
                },
              ]
            : [
                {
                  id: "name",
                  label: `Name: ${stage.name}`,
                  select: () => go({ name: "stageName", stageId: stage.id, value: stage.name }),
                },
                {
                  id: "agent",
                  label: `Agent: ${profiles.find((item) => item.id === stage.defaultAgentProfileId)?.name ?? "None"}`,
                  select: () => go({ name: "assign", stageId: stage.id }),
                },
                {
                  id: "prompt",
                  label: `Prompt: ${stage.description?.split("\n")[0] || "None"}`,
                  select: () =>
                    go({ name: "stagePrompt", stageId: stage.id, value: stage.description ?? "" }),
                },
                {
                  id: "gate",
                  label: `Advancement: ${isAutomatic(stage.id) ? "Automatic" : "Manual approval"}`,
                  select: () => go({ name: "stageGate", stageId: stage.id }),
                },
                {
                  id: "requirements",
                  label: `Requirements: ${criteriaOf(stage.id).length}${isAutomatic(stage.id) ? "" : " (inactive with manual approval)"}`,
                  select: () => go({ name: "criteria", stageId: stage.id }),
                },
                {
                  id: "pr",
                  label: `Open pull request: ${stage.createPr ? "On" : "Off"}`,
                  select: () => {
                    void saveStage(stage.id, { createPr: !stage.createPr });
                  },
                },
                ...(at > 0
                  ? [
                      {
                        id: "earlier",
                        label: "Move stage earlier",
                        select: () => {
                          void moveStage(stage.id, -1);
                        },
                      },
                    ]
                  : []),
                ...(at < stages.length - 1
                  ? [
                      {
                        id: "later",
                        label: "Move stage later",
                        select: () => {
                          void moveStage(stage.id, 1);
                        },
                      },
                    ]
                  : []),
                {
                  id: "delete",
                  label: "Delete stage",
                  select: () => go({ name: "stageDelete", stageId: stage.id }),
                },
              ];
      return (
        <Box flexDirection="column">
          <Navigator
            key={`${screen.name}:${stage.id}`}
            title={
              screen.name === "stageDelete"
                ? "Delete stage?"
                : screen.name === "stageGate"
                  ? "Stage advancement"
                  : `Stage: ${stage.name}`
            }
            choices={choices}
            onClose={() =>
              go(
                screen.name === "stageDetails"
                  ? { name: "stages" }
                  : { name: "stageDetails", stageId: stage.id },
              )
            }
          />
          {error && <Text color="red">{terminalText(error)}</Text>}
        </Box>
      );
    }
    if (screen.name === "stagePrompt")
      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Stage prompt</Text>
          <Text dimColor>Ctrl+J newline · Enter save · Esc back</Text>
          <TextInput
            value={screen.value}
            onChange={(value) => setScreen({ ...screen, value })}
            multiline
            showActions
            isActive={!busy}
            onCancel={() => go({ name: "stageDetails", stageId: screen.stageId })}
            onSubmit={(description) => {
              void saveStage(screen.stageId, { description });
            }}
          />
          {error && <Text color="red">{terminalText(error)}</Text>}
        </Box>
      );

    if (screen.name === "stageName") {
      return (
        <Frame title="Rename this stage" hint="Enter to save, Escape to go back" error={error}>
          <Box marginTop={1}>
            <Text>Name: </Text>
            <TextInput
              value={screen.value}
              onChange={(value) => setScreen({ ...screen, value })}
              onCancel={() => go({ name: "stageDetails", stageId: screen.stageId })}
              onSubmit={(name) => {
                const trimmed = name.trim();
                if (!trimmed) return;
                void act(`Renamed to ${trimmed}`, () =>
                  client.updateStage(screen.stageId, { name: trimmed }),
                ).then(
                  // Leaving on failure would clear the error and make a
                  // failed rename look like it just did not stick.
                  (ok) => {
                    if (ok) go({ name: "stageDetails", stageId: screen.stageId });
                  },
                );
              }}
            />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "keyValue") {
      const credential = AGENT_CREDENTIALS.find((row) => row.name === screen.credential)!;
      const back: Screen = { name: screen.from };
      return (
        <Frame title={credential.label} hint="Enter to save, Escape to go back" error={error}>
          <Text color="gray">{credential.help}</Text>
          {hints[credential.name] && (
            <Text color="gray">Currently {hints[credential.name]}. Saving replaces it.</Text>
          )}
          <Box marginTop={1}>
            <Text>{credential.secret ? "Paste the key: " : "Value: "}</Text>
            <TextInput
              value={screen.value}
              mask={credential.secret}
              onChange={(value) => setScreen({ ...screen, value })}
              onCancel={() => go(back)}
              onSubmit={(raw) => {
                const value = raw.trim();
                if (!value) {
                  go(back);
                  return;
                }
                void act(`Saved ${credential.name}`, () =>
                  client.createSecret({ name: credential.name, value }),
                ).then((ok) => {
                  if (ok) go(back);
                });
              }}
            />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "newStage") {
      return (
        <Frame title="Add a stage" hint="Enter to add, Escape to go back" error={error}>
          <Text color="gray">
            It joins the end of the pipeline, waiting for your approval and with no agent, until you say
            otherwise.
          </Text>
          <Box marginTop={1}>
            <Text>Name: </Text>
            <TextInput
              value={screen.value}
              placeholder="Security review"
              onChange={(value) => setScreen({ ...screen, value })}
              onCancel={() => go({ name: "stages" })}
              onSubmit={(raw) => {
                const name = raw.trim();
                if (!name || !pipelineId) return;
                void act(`Added ${name}`, () => client.createStage(pipelineId, name)).then((ok) => {
                  if (ok) go({ name: "stages" });
                });
              }}
            />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "subscription") {
      const claude = machine?.claude ?? null;
      const labelWidth = Math.max(14, ...logins.map((tool) => tool.label.length + 2));
      const sharing = machine?.shareAgentAuth === true;
      const pinned = machine?.pinnedByEnv === true;
      /** The sharing setting lives on the machine the server runs on. */
      const settable = machine?.mode === "local";

      return (
        <Frame
          title="Local agent sign-ins"
          hint="l sign in to Claude · s share on/off · Escape back"
          notice={notice}
          error={error}
        >
          <Text color="gray">
            Agents can use the logins already on this machine instead of an API key, so a subscription you
            already pay for drives the run.
          </Text>

          <Box marginTop={1} flexDirection="column">
            {logins.map((tool) => (
              <Box key={tool.cli}>
                <Text color={tool.signedIn ? "green" : "gray"}>{tool.signedIn ? "●" : "○"}</Text>
                <Text> {tool.label.padEnd(labelWidth)}</Text>
                <Text color="gray">{tool.detail ?? (tool.signedIn ? "signed in" : "not signed in")}</Text>
              </Box>
            ))}
            {logins.length === 0 && <Text color="gray">No coding tool on this machine has a login.</Text>}
          </Box>

          {claude && (
            <Box marginTop={1}>
              <Text color={claude.loggedIn ? "green" : "yellow"}>
                {claude.loggedIn
                  ? `Claude Code is signed in${claude.email ? ` as ${claude.email}` : ""}${
                      claude.subscriptionType ? ` on a ${claude.subscriptionType} plan` : ""
                    }.`
                  : "Claude Code is installed but not signed in yet."}
              </Text>
            </Box>
          )}

          <Box marginTop={1}>
            {settable ? (
              <Text>
                Sharing is <Text color={sharing ? "green" : "gray"}>{sharing ? "on" : "off"}</Text>
                {pinned ? " and pinned by BENTO_SHARE_AGENT_AUTH, so it cannot be changed here." : "."}
              </Text>
            ) : (
              <Text color="gray">
                The board is on a server, so sharing is decided when this machine starts: pass
                --share-agent-auth to use these logins for runs here.
              </Text>
            )}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text color="gray">
              l sign in to Claude Code ({"claude auth login"}), which opens your browser
            </Text>
            {settable && (
              <Text color="gray">s turn sharing {sharing ? "off" : "on"} for runs on this machine</Text>
            )}
          </Box>

          <Box marginTop={1}>
            <Text color="yellow">
              These are long lived credentials for a paid account, and an agent can read anything its sandbox
              can. Use it on repositories you trust.
            </Text>
          </Box>
        </Frame>
      );
    }

    if (screen.name === "repos") {
      return (
        <Frame
          title="Repositories"
          hint="j/k move · Enter commands · d remove · Escape back"
          notice={notice}
          error={error}
        >
          <Text color="gray">
            The agent can inspect the repository and install its dependencies. Optional commands let you
            specify dependency setup before work and build or test checks after edits.
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {repos.map((repo, i) => (
              <Row
                key={repo.id}
                selected={i === index}
                label={repo.name}
                status={`${repo.localPath}${repo.setupCommand ? ` · setup: ${repo.setupCommand}` : ""}${repo.testCommand ? ` · test: ${repo.testCommand}` : ""}`}
              />
            ))}
            <Row
              selected={index === repos.length}
              label={project ? "Add another repository" : "Connect a repository"}
            />
            <Row selected={index === repos.length + 1} label="Back" />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "repoSetup") {
      const repo = repos.find((item) => item.id === screen.repoId);
      const commands = resolveRepositoryCommands(repo ?? {});
      return (
        <Form
          title="Repository commands"
          fields={[
            {
              id: "setup",
              label: "Install dependencies (optional, before work)",
              value: commands.setupCommand ?? "",
              placeholder: "Leave blank for agent-managed setup",
            },
            {
              id: "test",
              label: "Build and test (optional, after edits)",
              value: commands.testCommand ?? "",
              placeholder: "pnpm run build && pnpm test",
            },
          ]}
          description={
            commands.deferredSetup
              ? "Your build command was moved to checks after edits. Save to apply. Leave dependency setup blank to let the agent configure the environment."
              : "Leave setup blank to let the agent inspect the repo and install dependencies. Builds and tests run after edits, before the agent reports completion."
          }
          fullDescription
          onCancel={() => go({ name: "repos" })}
          onSubmit={async ({ setup = "", test = "" }) => {
            if (!project) throw new Error("Choose a project first.");
            const resolved = resolveRepositoryCommands({ setupCommand: setup, testCommand: test });
            await client.updateRepository(project.id, screen.repoId, {
              setupCommand: resolved.setupCommand,
              testCommand: resolved.testCommand,
            });
            await load();
            go({ name: "repos" });
          }}
        />
      );
    }

    if (screen.name === "yamlAgents") {
      return (
        <Frame title="Agents file" hint="j/k move · Enter choose · Escape back" notice={notice} error={error}>
          <Text color="gray">
            Every named agent: the tool, the model, and the skill. Importing matches by name, so importing
            twice edits rather than duplicating.
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Row selected={index === 0} label="Export to a file" />
            <Row selected={index === 1} label="Import from a file" />
            <Row selected={index === 2} label="Back" />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "yamlPipeline") {
      return (
        <Frame
          title="Pipeline file"
          hint="j/k move · Enter choose · Escape back"
          notice={notice}
          error={error}
        >
          <Text color="gray">
            Your stages, agents, and commands as one YAML file. Import it into another project instead of
            rebuilding it.
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Row selected={index === 0} label="Export to a file" />
            <Row selected={index === 1} label="Import from a file" />
            <Row selected={index === 2} label="Back" />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "yamlPath") {
      const exporting = screen.kind.endsWith("export");
      const agents = screen.kind.startsWith("agents");
      return (
        <Frame
          title={exporting ? "Write the YAML where?" : "Read the YAML from where?"}
          hint="Enter to continue, Escape to go back"
          error={error}
        >
          <Box marginTop={1}>
            <Text>Path: </Text>
            <TextInput
              value={screen.value}
              onChange={(value) => setScreen({ ...screen, value })}
              onCancel={() => go({ name: agents ? "yamlAgents" : "yamlPipeline" })}
              onSubmit={(raw) => {
                const file = raw.trim();
                if (!file) return;
                if (exporting) {
                  void act(`Wrote ${file}`, async () => {
                    const yaml = agents
                      ? await client.exportAgents()
                      : await client.exportPipeline(project!.id);
                    await fs.promises.writeFile(file, yaml, "utf8");
                  }).then((ok) => {
                    if (ok) go({ name: agents ? "yamlAgents" : "yamlPipeline" });
                  });
                  return;
                }
                void act(`Imported ${file}`, async () => {
                  const yaml = await fs.promises.readFile(file, "utf8");
                  if (agents) await client.importAgents(yaml);
                  else await client.importPipeline(project!.id, yaml);
                }).then((ok) => {
                  if (ok) go({ name: agents ? "yamlAgents" : "yamlPipeline" });
                });
              }}
            />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "agents") {
      return (
        <Frame
          title="Agents"
          hint="j/k move · Enter open · e edit · d remove · Escape back"
          notice={notice}
          error={error}
        >
          <Text color="gray">Select an agent to edit its harness, model, prompt and advanced options.</Text>
          <Box flexDirection="column" marginTop={1}>
            {existingAgents.map((profile, i) => (
              <Row
                key={profile.id}
                selected={i === index}
                label={profile.name}
                // The skill is the difference between two agents on the
                // same tool and model, and it was set here but readable
                // nowhere: the row that hid it is the row that needs it.
                status={`${profile.cli} ${profile.model}${
                  profile.skill ? ` · prompt: ${skillPreview(profile.skill)}` : " · no prompt"
                }`}
              />
            ))}
            {existingAgents.length > 0 && <Text color="gray"> </Text>}
            {MODEL_GUIDANCE.map((tool, i) => {
              const missing = tools.find((t) => t.cli === tool.cli)?.installed === false;
              return (
                <Row
                  key={tool.cli}
                  selected={existingAgents.length + i === index}
                  label={`Add ${tool.label}`}
                  // Said on the row that offers it, so a tool this machine
                  // cannot start is visible before it is picked rather
                  // than when a queued run fails.
                  status={missing ? `${tool.defaultModel} · not installed` : tool.defaultModel}
                />
              );
            })}
            <Row
              selected={index === existingAgents.length + MODEL_GUIDANCE.length}
              label="Import or export agents"
            />
            <Row selected={index === existingAgents.length + MODEL_GUIDANCE.length + 1} label="Back" />
          </Box>
          {(() => {
            const at = index - existingAgents.length;
            const selected = at >= 0 && at < MODEL_GUIDANCE.length ? MODEL_GUIDANCE[at] : undefined;
            const missing = selected && tools.find((t) => t.cli === selected.cli)?.installed === false;
            if (!selected || !missing) return null;
            const entry = tools.find((t) => t.cli === selected.cli)!;
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text color="yellow">
                  {selected.label} is not installed where agents run. Install it first:
                </Text>
                <Text color="gray"> {entry.installCommand}</Text>
                <Text color="gray"> {entry.installUrl}</Text>
              </Box>
            );
          })()}
        </Frame>
      );
    }

    if (screen.name === "criteria") {
      const stage = stages.find((s) => s.id === screen.stageId);
      const current = criteriaOf(screen.stageId);
      // Requirements belong to automatic stages: a manual one consults
      // none of them, so offering the list here would be adding rows
      // that quietly do nothing.
      if (!isAutomatic(screen.stageId)) {
        return (
          <Frame
            title={`Requirements for ${stage?.name ?? "this stage"}`}
            hint="Enter or Escape to go back"
            notice={notice}
            error={error}
          >
            <Text color="gray">
              You decide on the card: Approve moves it on, Reject sends it back. No requirements apply.
            </Text>
            <Box marginTop={1}>
              <MouseButton
                label="Change advancement"
                onClick={() => go({ name: "stageGate", stageId: screen.stageId })}
              />
            </Box>
          </Frame>
        );
      }
      return (
        <Frame
          title={`Requirements for ${stage?.name ?? "this stage"}`}
          hint="j/k move · Enter add · d remove · Escape back"
          notice={notice}
          error={error}
        >
          <Text color="gray">
            Every requirement has to pass. With none, the stage advances as soon as its agent finishes.
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {current.map((criterion, i) => (
              <Row
                key={`${criterion.type}-${i}`}
                selected={i === index}
                label={describeCriterion(criterion, profiles)}
                status="on this stage"
              />
            ))}
            {current.length > 0 && <Text color="gray"> </Text>}
            {CRITERION_KINDS.map((kind, i) => (
              <Row key={kind.type} selected={current.length + i === index} label={`Add: ${kind.label}`} />
            ))}
            <Row selected={index === current.length + CRITERION_KINDS.length} label="Back" />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "judge") {
      const stage = stages.find((s) => s.id === screen.stageId);
      return (
        <Frame
          title={`Which agent rules on ${stage?.name ?? "this stage"}?`}
          hint="j/k move · Enter choose · Escape back"
          notice={notice}
          error={error}
        >
          <Text color="gray">
            A judge is a second agent that reads the work and says whether it is complete. It works best with
            its own skill saying what complete means here, on a different model from the agent doing the work.
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {profiles.map((profile, i) => (
              <Row
                key={profile.id}
                selected={i === index}
                label={profile.name}
                status={`${profile.cli} ${profile.model}`}
              />
            ))}
            <Row selected={index === profiles.length} label="Back" />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "criterionCmd") {
      return (
        <Frame title="Which command has to succeed?" hint="Enter to save, Escape to go back">
          <Text color="gray">Run inside the sandbox. It passes when the command exits 0.</Text>
          <Box marginTop={1}>
            <Text>Command: </Text>
            <TextInput
              value={screen.value}
              placeholder="pnpm test"
              onChange={(value) => setScreen({ ...screen, value })}
              onCancel={() => go({ name: "criteria", stageId: screen.stageId })}
              onSubmit={(raw) => {
                const cmd = raw.trim();
                if (!cmd) return;
                const next = [
                  ...criteriaOf(screen.stageId),
                  { type: "command" as const, cmd, timeoutSec: 600 },
                ];
                void act(`Added ${cmd}`, () =>
                  client.updateStage(screen.stageId, { gateCriteria: next as GateCriteria }),
                ).then((ok) => {
                  if (ok) go({ name: "criteria", stageId: screen.stageId });
                });
              }}
            />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "stages") {
      return (
        <Frame
          title="Pipeline"
          hint="j/k move · Enter edit stage · d remove · Escape back"
          notice={notice}
          error={error}
        >
          <Text color="gray">
            Select a stage to edit its agent, prompt, advancement and pull request settings.
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {stages.map((stage, i) => {
              const agent = profiles.find((p) => p.id === stage.defaultAgentProfileId);
              return (
                <Row
                  key={stage.id}
                  selected={i === index}
                  label={`${stage.position + 1}. ${stage.name}`}
                  status={`${agent ? `${agent.cli} ${agent.model}` : "no agent"} · ${
                    stage.gateType === "auto" ? "advances on its requirements" : "waits for your approval"
                  }${stage.createPr ? " · opens a PR" : ""}`}
                />
              );
            })}
            <Row selected={index === stages.length} label="Add stage" />
            <Row selected={index === stages.length + 1} label="Import or export pipeline" />
            <Row selected={index === stages.length + 2} label="Back" />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "assign") {
      const stage = stages.find((s) => s.id === screen.stageId);
      return (
        <Frame
          title={`Which agent runs ${stage?.name ?? "this stage"}?`}
          hint="Enter to choose · Escape back"
        >
          <Box flexDirection="column" marginTop={1}>
            {profiles.map((profile, i) => (
              <Row
                key={profile.id}
                selected={i === index}
                label={profile.name}
                status={`${profile.cli} ${profile.model}`}
              />
            ))}
            <Row selected={index === profiles.length} label="No agent (start runs by hand)" />
          </Box>
        </Frame>
      );
    }

    if (screen.name === "keys") {
      return (
        <Frame
          title="Model provider keys"
          hint={
            canManageCredentials
              ? "j/k move · Enter choose · d remove · Escape back"
              : "j/k move · Escape back"
          }
          notice={notice}
          error={error}
        >
          <Text color="gray">
            Keys for the providers your agents' models run on. Stored encrypted. Nothing reads a key back,
            only a masked tail.
          </Text>
          {!canManageCredentials && <Text color="gray">Only owners and admins can change credentials.</Text>}
          <Box flexDirection="column" marginTop={1}>
            {PROVIDER_CREDENTIALS.map((credential, i) => (
              <Row
                key={credential.name}
                selected={i === index}
                label={credential.label}
                status={hints[credential.name] ?? "not set"}
                statusColumn={Math.max(1, Math.min(24, columns - 18))}
                statusColor={hints[credential.name] ? "green" : "gray"}
              />
            ))}
            <Row selected={index === PROVIDER_CREDENTIALS.length} label="Back" />
          </Box>
        </Frame>
      );
    }

    return (
      <Frame title="Settings" hint="j/k move · Enter choose · q open the board" notice={notice} error={error}>
        <Text color="gray">Configure this project and the agents that work on it.</Text>
        <Box flexDirection="column" marginTop={1}>
          {hubRows.map((row, i) => (
            <Row key={row.label} selected={i === index} label={row.label} status={row.status} />
          ))}
        </Box>
        {busy && <Text color="yellow">Working...</Text>}
      </Frame>
    );
  }
}

function Frame({
  title,
  hint,
  notice,
  error,
  children,
}: {
  title: string;
  hint: string;
  notice?: string;
  error?: string;
  children: React.ReactNode;
}) {
  const controls = useContext(SetupMouse);
  const mouse = useMouseTarget({
    onScroll: (event) => {
      if (event.kind === "up" || event.kind === "down") controls?.move(event.kind === "up" ? -1 : 1);
    },
  });
  return (
    <Box ref={mouse} flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="magenta" wrap="truncate-end">
        {title}
      </Text>
      <SettingsRows>{children}</SettingsRows>
      {notice ? <Text color="yellow">{notice}</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      <Box marginTop={1}>
        <Text color="gray" wrap="truncate-end">
          {hint}
        </Text>
      </Box>
      {controls && !controls.typing && (
        <MouseActions>
          <MouseButton label="Back" onClick={controls.back} />
          {controls.actions.map((action) => (
            <MouseButton
              key={action.key}
              label={action.label}
              onClick={() => controls.key(action.key)}
              disabled={controls.busy}
              danger={action.key === "d"}
            />
          ))}
        </MouseActions>
      )}
    </Box>
  );
}

/** Window the existing setup lists around the highlighted row at any terminal size. */
export function SettingsRows({ children }: { children: React.ReactNode }) {
  const { rows } = useWindowSize();
  const controls = useContext(SetupMouse);
  const windowStart = useRef(0);
  const entries: React.ReactElement<{ selected?: boolean }>[] = [];
  function collect(nodes: React.ReactNode) {
    Children.forEach(nodes, (node) => {
      if (!isValidElement<{ children?: React.ReactNode; selected?: boolean }>(node)) return;
      if (node.type === Row) entries.push(node);
      else if (node.props.children) collect(node.props.children);
    });
  }
  collect(children);
  const height = Math.max(1, rows - 14);
  const selected = Math.max(
    0,
    entries.findIndex((entry) => entry.props.selected),
  );
  const start = Math.max(
    0,
    Math.min(
      selected < windowStart.current
        ? selected
        : selected >= windowStart.current + height
          ? selected - height + 1
          : windowStart.current,
      entries.length - height,
    ),
  );
  windowStart.current = start;
  const visible = new Set(entries.slice(start, start + height));
  function window(nodes: React.ReactNode): React.ReactNode {
    return Children.map(nodes, (node) => {
      if (!isValidElement<{ children?: React.ReactNode; selected?: boolean }>(node)) return node;
      if (node.type === Row)
        return visible.has(node)
          ? cloneElement(node as React.ReactElement<{ onClick?: () => void }>, {
              onClick: () => controls?.pick(entries.indexOf(node)),
            })
          : null;
      if (node.type === TextInput && controls?.typing)
        return cloneElement(node as React.ReactElement<{ showActions?: boolean }>, { showActions: true });
      return node.props.children ? cloneElement(node, {}, window(node.props.children)) : node;
    });
  }
  return (
    <>
      {window(children)}
      {entries.length > height && (
        <Text dimColor>
          {start + 1} to {Math.min(start + height, entries.length)} of {entries.length} · ↑/↓ scroll
        </Text>
      )}
    </>
  );
}

/** The hub line for the subscription row. */
function subscriptionStatus(
  m: MachineSettings | null,
  logins: { label: string; signedIn: boolean }[],
): string {
  const signedIn = logins.filter((row) => row.signedIn).map((row) => row.label);
  const who = signedIn.length ? `${signedIn.join(", ")} ready to share` : "no verified login; open to check";
  if (!m || m.mode !== "local") return who;
  return m.shareAgentAuth ? `sharing on, ${who}` : `sharing off, using API keys`;
}

/**
 * The hub line for the provider keys row. A count alone ("3 saved")
 * answers the wrong question: what someone wants to know before a run
 * is whether the provider their model needs is paid for.
 */
function providerKeyStatus(hints: Record<string, string>): string {
  const set = PROVIDER_KEYS.filter((provider) => hints[provider.name]);
  if (set.length === 0) return `none saved, ${PROVIDER_KEYS.length} providers to choose from`;
  const missing = PROVIDER_KEYS.length - set.length;
  return `${set.map((provider) => provider.label).join(", ")} set${missing ? ` · ${missing} not set` : ""}`;
}

/** How a tool is named to a person, falling back to its own id. */
function toolLabel(cli: string): string {
  return MODEL_GUIDANCE.find((tool) => tool.cli === cli)?.label ?? cli;
}

/**
 * Which coding tools are signed in on this machine.
 *
 * Asked here rather than of the server, because with a remote server
 * the server's answer describes the wrong computer: the runs happen
 * here. Directory presence is only a configuration hint, never proof
 * that credentials exist or have not expired.
 */
function localLogins(): { cli: string; label: string; signedIn: boolean; detail: string }[] {
  return MODEL_GUIDANCE.map((tool) => {
    const paths = getAdapter(tool.cli as AgentCli).configPaths ?? [];
    return {
      cli: tool.cli,
      label: tool.label,
      signedIn: false,
      detail: paths.some((relative) => fs.existsSync(path.join(os.homedir(), relative)))
        ? "Configuration found; sign-in unverified"
        : "Not configured",
    };
  });
}

/** A skill is long; the row has space to say it exists and hint at it. */
function skillPreview(skill: string | null | undefined): string {
  if (!skill) return "";
  const oneLine = skill.replaceAll(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}...` : oneLine;
}

export function Row({
  selected,
  label,
  status,
  onClick,
  statusColumn,
  statusColor = "gray",
}: {
  selected: boolean;
  label: string;
  status?: string;
  onClick?: () => void;
  statusColumn?: number;
  statusColor?: string;
}) {
  const ref = useMouseTarget({ onClick: () => onClick?.(), priority: 1 });
  if (statusColumn !== undefined) {
    // Reserve room for the masked tail even when the provider label is long.
    return (
      <Box ref={ref} height={1}>
        <Text {...(selected ? { color: "cyan" } : {})}>{selected ? "› " : "  "}</Text>
        <Box width={statusColumn} flexShrink={0} marginRight={2}>
          <Text wrap="truncate-end" {...(selected ? { color: "cyan" } : {})}>
            {terminalText(label)}
          </Text>
        </Box>
        <Box flexGrow={1} minWidth={0}>
          <Text wrap="truncate-end" color={statusColor}>
            {terminalText(status ?? "")}
          </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box ref={ref} height={1}>
      <Text wrap="truncate-end" {...(selected ? { color: "cyan" } : {})}>
        {selected ? "› " : "  "}
        {terminalText(label)}
        {status ? <Text dimColor> · {terminalText(status)}</Text> : null}
      </Text>
    </Box>
  );
}

/** The models a tool can run on one provider. */
function modelsFor(cli: AgentCli, providerId: string) {
  return providersForCli(cli).find((p) => p.id === providerId)?.models ?? [];
}

/** Says what is wrong with a path, or null when it can be used. */
function pathProblem(dir: string): string | null {
  if (!fs.existsSync(dir)) return `${dir} does not exist`;
  if (!fs.statSync(dir).isDirectory()) return `${dir} is not a directory`;
  if (!fs.existsSync(path.join(dir, ".git"))) return `${dir} is not a git repository`;
  return null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
