import { ArtifactPreview } from "./ArtifactPreview.js";
import { accountSettings } from "./account-settings.js";
import { Conversation } from "./Conversation.js";
import { advancedSettings } from "./workbench-settings.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { BentoClient, Feature, Project, Stage, AgentProfile, RunArtifact } from "@bento/api-client";
import { describeCriterion } from "../criteria.js";
import { terminalText } from "../terminal.js";
import { Navigator, Reader, type Choice } from "./Navigator.js";
import { TextInput } from "./TextInput.js";

export type WorkbenchPage =
  | "commands"
  | "projects"
  | "conversation"
  | "changes"
  | "artifacts"
  | "runs"
  | "move"
  | "agents"
  | "new"
  | "sessions"
  | "spend"
  | "search"
  | "integrations"
  | "reject"
  | "message";
type Page =
  | { kind: "preview"; artifact: RunArtifact }
  | { kind: "conversation" }
  | { kind: "list"; title: string; choices: Choice[] }
  | { kind: "read"; title: string; lines: string[] }
  | {
      kind: "form";
      title: string;
      hint: string;
      value: string;
      mask?: boolean;
      multiline?: boolean;
      submit: (value: string) => void;
    };

/** Navigable command surface. Async work is scoped to its mounted project/card. */
export function Workbench({
  client,
  baseUrl,
  initial,
  project,
  projects,
  feature: selectedFeature,
  features,
  stages,
  profiles,
  beta,
  onProject,
  onFeature,
  onSetup,
  onAction,
  onClose,
  onChanged,
  onSessionChanged,
}: {
  client: BentoClient;
  baseUrl: string;
  initial: WorkbenchPage;
  project: Project | undefined;
  projects: Project[];
  feature: Feature | undefined;
  features: Feature[];
  stages: Stage[];
  profiles: AgentProfile[];
  beta: boolean;
  onProject: (id: string) => void;
  onFeature: (id: string) => void;
  onSetup: () => void;
  onAction: (key: string, featureId?: string) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onSessionChanged?: (signedOut?: boolean) => Promise<void>;
}) {
  const [feature] = useState(selectedFeature);
  const [page, setPage] = useState<Page | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const pending = useRef(false);
  const stack = useRef<Page[]>([]);
  const pageRef = useRef<Page | null>(null);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  function show(next: Page, push = true) {
    if (!alive.current) return;
    if (push && pageRef.current) stack.current.push(pageRef.current);
    pageRef.current = next;
    setPage(next);
    setRevision((r) => r + 1);
    setError("");
  }
  function back() {
    if (pending.current) return;
    const previous = stack.current.pop();
    if (previous) show(previous, false);
    else onClose();
  }
  function read(title: string, lines: string[]) {
    show({ kind: "read", title, lines });
  }
  function list(title: string, choices: Choice[]) {
    show({ kind: "list", title, choices });
  }
  function form(
    title: string,
    submit: (value: string) => void,
    opts: { value?: string; hint?: string; mask?: boolean; multiline?: boolean } = {},
  ) {
    show({
      kind: "form",
      title,
      hint: opts.hint ?? "Enter save · Esc back · Ctrl+U clear",
      value: opts.value ?? "",
      ...(opts.mask ? { mask: true } : {}),
      ...(opts.multiline ? { multiline: true } : {}),
      submit,
    });
  }
  async function load(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function act(title: string, work: () => Promise<unknown>) {
    void load(async () => {
      const origin = pageRef.current;
      await work();
      let refreshError = "";
      try {
        await onChanged();
      } catch {
        refreshError =
          "The action succeeded, but the board could not refresh. It will retry when you return.";
      }
      if (alive.current) {
        stack.current = [];
        if (pageRef.current !== origin) return;
        pageRef.current = null;
        read(title, ["Saved successfully.", ...(refreshError ? [refreshError] : [])]);
      }
    });
  }
  function confirm(title: string, consequences: string, work: () => Promise<unknown>) {
    form(
      title,
      (value) => {
        if (value !== "confirm") {
          setError("Type confirm to continue, or Escape to keep it.");
          return;
        }
        act(title, work);
      },
      { hint: `${consequences} Type confirm, then Enter.` },
    );
  }
  const choice = (id: string, label: string, select: () => void, detail?: string): Choice => ({
    id,
    label,
    select,
    ...(detail ? { detail } : {}),
  });
  function link(title: string, path: string) {
    read(title, [
      "Continue in the web console:",
      new URL(path, baseUrl).toString(),
      "",
      "Sign in in your browser if requested. Your terminal token stays in the terminal.",
    ]);
  }
  function chooseFeature(id: string) {
    onFeature(id);
    onClose();
  }
  function projectsPage() {
    list("Projects", [
      ...projects.map((p) =>
        choice(
          p.id,
          `${p.id === project?.id ? "● " : ""}${p.name}`,
          () => {
            onProject(p.id);
            onClose();
          },
          p.localPath ?? p.repoUrl ?? "",
        ),
      ),
      choice("new", "Create project", () =>
        form("Project name", (name) => {
          if (!name.trim()) {
            setError("Enter a project name.");
            return;
          }
          form(
            "Repository path or clone URL",
            (source) => {
              if (!source.trim()) {
                setError("Enter a repository path or URL.");
                return;
              }
              void load(async () => {
                const repo = /^(https?:\/\/|git@|ssh:\/\/)/.test(source.trim())
                  ? { repoUrl: source.trim() }
                  : { localPath: source.trim() };
                const created = await client.createProject({ name: name.trim(), repositories: [repo] });
                onProject(created.id);
                onClose();
              });
            },
            { hint: "Use a checkout on the server, or a clone URL. Enter create · Esc back" },
          );
        }),
      ),
      ...(project
        ? [
            choice("rename", "Rename current project", () =>
              form(
                "Project name",
                (name) => {
                  if (!name.trim()) {
                    setError("Enter a name.");
                    return;
                  }
                  act("Project renamed", () => client.updateProject(project.id, { name: name.trim() }));
                },
                { value: project.name },
              ),
            ),
            choice(
              "auto",
              `${project.autoStartPipeline ? "Disable" : "Enable"} automatic pipeline start`,
              () =>
                act("Pipeline start updated", () =>
                  client.updateProject(project.id, { autoStartPipeline: !project.autoStartPipeline }),
                ),
            ),
            choice("delete", "Delete current project", () =>
              confirm(
                `Delete ${project.name}`,
                "Deletes the project, cards, run history and sandboxes. Branches and pull requests remain.",
                () => client.deleteProject(project.id),
              ),
            ),
          ]
        : []),
    ]);
  }
  function newCard(parentId?: string) {
    if (!project) {
      projectsPage();
      return;
    }
    form(parentId ? "New related card: title" : "New card: title", (title) => {
      if (!title.trim()) {
        setError("Enter a title.");
        return;
      }
      form(
        "Card description (optional)",
        (description) => {
          void load(async () => {
            const created = await client.createFeature({
              projectId: project.id,
              title: title.trim(),
              description,
              ...(parentId ? { parentId } : {}),
            });
            await onChanged();
            chooseFeature(created.id);
          });
        },
        { multiline: true, hint: "Enter create · Ctrl+J newline · Esc back. Pasting never submits." },
      );
    });
  }
  function conversation() {
    if (feature) show({ kind: "conversation" });
  }
  function changes() {
    if (!feature) return;
    void load(async () => {
      const result = await client.getChanges(feature.id);
      read(
        `${feature.title} · Changes`,
        result.repositories.flatMap((repo) => [
          `${repo.name} · ${repo.branch}`,
          ...repo.files.map((f) => `+${f.additions} -${f.deletions} ${f.path}`),
          "",
          repo.diff,
          ...(repo.truncated
            ? ["The server truncated this diff. Inspect the branch for the complete change."]
            : []),
          ...repo.artifacts.flatMap((a) => ["", a.path, a.content]),
        ]),
      );
    });
  }
  function artifacts() {
    if (!feature) return;
    void load(async () => {
      const items = await client.listArtifacts(feature.id);
      list(
        "Artifacts",
        items.map((artifact) =>
          choice(
            artifact.id,
            artifact.path,
            () =>
              list(artifact.path, [
                ...(["image", "html", "mermaid"].includes(artifact.kind)
                  ? [choice("visual", "Preview in terminal", () => show({ kind: "preview", artifact }))]
                  : []),
                ...(["markdown", "mermaid", "html"].includes(artifact.kind) ||
                artifact.mime.startsWith("text/")
                  ? [
                      choice("read", "Read source as text", () => {
                        void load(async () =>
                          read(artifact.path, [await client.getArtifactText(artifact.id)]),
                        );
                      }),
                    ]
                  : []),
                choice("download", "Save artifact to a file", () =>
                  form(
                    "Save artifact on this machine",
                    (destination) => {
                      if (!destination.trim()) {
                        setError("Enter a destination path.");
                        return;
                      }
                      void load(async () => {
                        const bytes = await client.getArtifactBytes(artifact.id);
                        const file = path.resolve(destination.trim());
                        await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
                        read("Artifact saved", [
                          file,
                          `${bytes.length} bytes. Existing files are never overwritten.`,
                        ]);
                      });
                    },
                    { hint: "Enter save · Esc back. Choose a new file path." },
                  ),
                ),
                choice("preview", "Preview in web console", () =>
                  link(artifact.path, `/artifact/${artifact.id}`),
                ),
              ]),
            `${artifact.stageName} · ${artifact.kind} · ${artifact.size} bytes`,
          ),
        ),
      );
    });
  }
  function runs() {
    if (!feature) return;
    void load(async () => {
      const detail = await client.getFeature(feature.id);
      list(
        "Run history",
        detail.runs.map((run, i) =>
          choice(
            run.id,
            `${profiles.find((p) => p.id === run.agentProfileId)?.name ?? "Agent"} · ${run.status} · ${new Date(run.queuedAt).toLocaleString()}`,
            () =>
              list("Run actions", [
                choice("transcript", "Read full transcript", () => {
                  void load(async () => {
                    const result = await client.getTranscript(run.id);
                    read("Run transcript", [...(run.error ? [run.error, ""] : []), ...result.lines]);
                  });
                }),
                ...(["queued", "starting", "running"].includes(run.status)
                  ? [
                      choice("stop", "Stop this run", () =>
                        act("Run stopped", () => client.cancelRun(run.id)),
                      ),
                    ]
                  : run.cliSessionId
                    ? [
                        choice("resume", "Resume with instructions", () =>
                          form(
                            "Instructions",
                            (prompt) => {
                              if (prompt.trim())
                                act("Run resumed", () => client.resumeRun(run.id, prompt.trim()));
                            },
                            { multiline: true },
                          ),
                        ),
                      ]
                    : []),
                ...(i === 0 && run.checkpointId && !["queued", "starting", "running"].includes(run.status)
                  ? [
                      choice("rollback", "Roll back to before this run", () =>
                        confirm(
                          "Roll back run",
                          "Restores the sandbox checkpoint and discards work after it.",
                          () => client.rollbackRun(run.id),
                        ),
                      ),
                    ]
                  : []),
              ]),
            run.costUsd == null ? "Cost not reported" : `$${Number(run.costUsd).toFixed(2)}`,
          ),
        ),
      );
    });
  }
  function move() {
    if (!feature) return;
    list("Move card", [
      choice("backlog", "Backlog", () => act("Moved to backlog", () => client.moveFeature(feature.id, null))),
      ...stages.map((stage) =>
        choice(stage.id, stage.name, () =>
          act(`Moved to ${stage.name}`, () => client.moveFeature(feature.id, stage.id)),
        ),
      ),
      choice("done", "Done", () => act("Card completed", () => client.finishFeature(feature.id))),
    ]);
  }
  function agents() {
    if (!feature) return;
    if (feature.status === "done" || feature.status === "cancelled") {
      read("Start agent", ["Reopen this card before starting an agent."]);
      return;
    }
    if (!feature.currentStageId) {
      read("Start agent", [
        "This card is in the backlog. Return to the board and press a to start its pipeline, or choose Move card to select a stage.",
      ]);
      return;
    }
    list(
      "Run with an agent",
      profiles.map((profile) =>
        choice(
          profile.id,
          profile.name,
          () => {
            form(
              `Instructions for ${profile.name} (optional)`,
              (prompt) =>
                act("Run started", () =>
                  client.startRun({
                    featureId: feature.id,
                    agentProfileId: profile.id,
                    ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
                  }),
                ),
              { multiline: true },
            );
          },
          `${profile.cli} · ${profile.model}`,
        ),
      ),
    );
  }
  function sessions() {
    if (!project) return;
    void load(async () => {
      const result = await client.listSessions(project.id);
      list(
        "Sessions",
        result.sessions.map((s) =>
          choice(
            s.featureId,
            s.title,
            () => chooseFeature(s.featureId),
            `${s.latestRun.status} · ${s.runCount} runs`,
          ),
        ),
      );
    });
  }
  function spend() {
    if (!project) return;
    void load(async () => {
      const usage = await client.getUsage(project.id);
      list(
        `Spend · $${usage.totalUsd.toFixed(2)}${usage.runsWithoutCost ? "+" : ""} · ${usage.runsWithoutCost} unmeasured runs`,
        [
          choice("summary", "Usage by stage and agent", () =>
            read("Usage", [
              "Costs are reported by the coding tools. Unmeasured runs are excluded from totals.",
              "",
              ...usage.byStage.map(
                (s) =>
                  `${stages.find((stage) => stage.id === s.stageId)?.name ?? "Removed stage"} · ${profiles.find((p) => p.id === s.agentProfileId)?.name ?? "Removed agent"}: $${s.costUsd.toFixed(2)} · ${s.runs} runs`,
              ),
            ]),
          ),
          choice("completions", "Completion history", () =>
            list(
              "Completion window",
              (["1d", "1w", "1m", "3m", "6m", "1y"] as const).map((range) =>
                choice(range, range, () => {
                  void load(async () => {
                    const data = await client.getCompletions(project.id, range);
                    const peak = Math.max(1, ...data.buckets.map((b) => b.completed));
                    read(
                      `Completions · ${data.total} done · ${range}`,
                      data.buckets.map(
                        (bucket) =>
                          `${new Date(bucket.start).toLocaleDateString()} ${data.bucketUnit === "hour" ? new Date(bucket.start).toLocaleTimeString([], { hour: "2-digit" }) : ""} ${"█".repeat(Math.round((bucket.completed / peak) * 25))} ${bucket.completed}`,
                      ),
                    );
                  });
                }),
              ),
            ),
          ),
          ...usage.byFeature.map((row) =>
            choice(
              row.featureId,
              row.title,
              () => chooseFeature(row.featureId),
              `${row.costUsd == null ? "Not reported" : `$${row.costUsd.toFixed(2)}${row.runsWithoutCost ? "+" : ""}`} · ${row.runs} runs`,
            ),
          ),
        ],
      );
    });
  }
  function pullRequests() {
    if (!feature) return;
    void load(async () => {
      const [detail, checks, merges, statuses] = await Promise.all([
        client.getFeature(feature.id),
        client.getCheckStatus(feature.id),
        client.getMergeStatus(feature.id),
        client.getPullRequestStatus(feature.id),
      ]);
      read(
        "Pull requests and checks",
        detail.pullRequestHistory.flatMap((pr) => [
          `${pr.name} #${pr.number} · ${pr.current ? "current" : "previous"} branch ${pr.branch}`,
          pr.url,
          `State: ${statuses.find((s) => s.url === pr.url)?.state ?? "unknown"} · CI: ${checks.find((s) => s.url === pr.url)?.state ?? "unknown"} · Merge: ${merges.find((s) => s.url === pr.url)?.state ?? "unknown"}`,
          "",
        ]),
      );
    });
  }
  const settingsUI = { list, choice, read, form, act, confirm, load, link };
  const settings = advancedSettings(client, project, beta, settingsUI);
  const accounts = accountSettings(
    client,
    settingsUI,
    onSessionChanged ??
      (async () => {
        await onChanged();
        onClose();
      }),
  );
  function integrations() {
    void load(async () => {
      const health = await client.health();
      list("Integrations and account", [
        choice("setup", "Repositories, agents, stages and provider keys", onSetup),
        choice("instructions", "Agent operating instructions and CLI arguments", settings.agents),
        ...(project ? [choice("stages", "Stage instructions and order", settings.pipeline)] : []),
        choice("github", "GitHub connection and pull request settings", settings.github),
        choice("linear", "Linear connection, mappings and issue import", settings.linear),
        choice("mcp", "MCP catalog, servers and connections", settings.mcp),
        ...(health.mode === "multi"
          ? [
              choice("slack", "Slack connection and default project", settings.slack),
              choice("team", "Team, organizations and invitations", accounts.team),
              choice("billing", "Billing, plans and usage", accounts.billing),
              choice("account", "Account and sign out", accounts.account),
            ]
          : [choice("identity", "Git commit author", settings.identity)]),
      ]);
    });
  }
  function message() {
    if (!feature) return;
    form(
      "Message the card's agent",
      (text) => {
        if (!text.trim()) {
          setError("Enter a message.");
          return;
        }
        void load(async () => {
          const result = await client.messageFeature(feature.id, text.trim());
          await onChanged().catch(() => {});
          stack.current = [];
          pageRef.current = null;
          read("Message sent", [
            result.queued
              ? "Queued. The agent reads it when this run ends."
              : result.live
                ? result.delivery === "steer"
                  ? "The running agent is changing course now."
                  : "The agent reads it after the current step."
                : "Continuing with your instructions.",
          ]);
        });
      },
      {
        multiline: true,
        hint: "Enter send · Ctrl+J newline · Esc back. The server steers, queues or resumes the agent.",
      },
    );
  }
  function commands() {
    list("Commands", [
      choice(
        "search",
        "Find a card",
        () =>
          list(
            "Find a card",
            features.map((f) =>
              choice(f.id, f.title, () => chooseFeature(f.id), `${f.status} ${f.description}`),
            ),
          ),
        "/",
      ),
      choice("projects", "Switch or manage projects", projectsPage, "p"),
      choice("board-view", "Toggle Kanban or list view", () => onAction("v", feature?.id), "v"),
      choice("new", "Create card", () => newCard(), "n"),
      choice("setup", "Settings: repositories, agents, stages and keys", onSetup, ","),
      choice("integrations", "Integrations and account", integrations),
      choice("instructions", "Edit agent operating instructions", settings.agents),
      ...(project
        ? [choice("stage-settings", "Edit stage instructions and reorder pipeline", settings.pipeline)]
        : []),
      ...(project
        ? [
            choice("sessions", "Sessions", sessions, "e"),
            choice("spend", "Spend and completions", spend, "u"),
          ]
        : []),
      ...(feature
        ? [
            choice("conversation", "Read full conversation and queued messages", conversation, "Enter"),
            choice("runs", "Run history, resume and rollback", runs),
            choice("changes", "Review full diff and stage write-ups", changes, "d"),
            choice("artifacts", "Browse artifacts", artifacts),
            choice("description", "Read card description", () =>
              read(feature.title, [
                feature.description || "No description.",
                "",
                `Branch: ${feature.branchName ?? "not created"}`,
              ]),
            ),
            choice("move", "Move card to a stage", move),
            choice("agents", "Start with a chosen agent and instructions", agents),
            choice("gate", "Gate requirements and results", () => {
              void load(async () => {
                const gate = await client.getGate(feature.id);
                read(
                  "Gate requirements",
                  gate.checks.flatMap((c) => [
                    `${c.status} · ${describeCriterion(c.criterion, profiles)}`,
                    c.detail?.message ?? "",
                  ]),
                );
              });
            }),
            choice("prs", "Pull requests, merge status and CI checks", pullRequests),
            choice("publish", "Publish branch and open pull requests", () => {
              void load(async () => {
                const result = await client.publishFeature(feature.id);
                await onChanged();
                read("Publish result", [
                  ...result.published.map((p) => `${p.name}: ${p.url}`),
                  ...result.failures.map((f) => `${f.name}: ${f.reason}`),
                  ...(result.rebaseRun ? ["A run is resolving conflicts before publishing."] : []),
                ]);
              });
            }),
            choice("link", "Link an existing pull request", () =>
              form("Pull request number", (value) => {
                const number = Number(value.replace(/^#/, ""));
                if (!Number.isSafeInteger(number) || number <= 0) {
                  setError("Enter a positive pull request number.");
                  return;
                }
                act("Pull request linked", () => client.linkPullRequest(feature.id, number));
              }),
            ),
            choice("ci", "Fix failing CI tests", () =>
              act("CI repair started", () => client.fixCiTests(feature.id)),
            ),
            choice("reject", "Reject with a reason", () =>
              form(
                "Reason for rework (optional)",
                (reason) => act("Card rejected", () => client.rejectFeature(feature.id, reason || undefined)),
                { multiline: true },
              ),
            ),
            ...(beta
              ? [
                  choice("related", "Related cards", () => {
                    void load(async () => {
                      const group = await client.relatedFeatures(feature.id);
                      list(
                        "Related cards",
                        group
                          ? [...(group.partOf ? [group.partOf] : []), group.parent, ...group.children].map(
                              (f) => choice(f.id, f.title, () => chooseFeature(f.id), f.status),
                            )
                          : [],
                      );
                    });
                  }),
                  choice("child", "Create a related card", () => newCard(feature.id)),
                ]
              : []),
            ...[
              ["s", "Start stage agent"],
              ["x", "Stop agent"],
              ["c", "Message agent"],
              ["a", "Approve or advance card"],
              ["r", "Recheck gate"],
              ["b", "Send back or reopen"],
              ["f", "Mark done"],
              ["m", "Resolve merge conflicts"],
              ["D", "Delete card"],
            ].map(([key, label]) => choice(key!, label!, () => onAction(key!, feature.id), key!)),
          ]
        : []),
      choice("changelog", "Read the changelog in browser", () => link("Changelog", "/changelog")),
      choice("web", "Open web console address", () => link("Web console", "/")),
      choice("help", "Keyboard help", () =>
        read("Keyboard shortcuts", [
          "Board",
          "↑/↓ or j/k: select a card",
          "←/→ or Tab/Shift+Tab: change Kanban stage",
          "g/G: first/last card in the Kanban stage",
          "v: toggle Kanban and list views",
          "Mouse: click a card to select, double-click to open",
          "Wheel: move through cards under the pointer",
          "Horizontal wheel or Shift+wheel: change Kanban stage",
          "/: find a card across lanes",
          ": or Ctrl+P: command palette",
          "p: switch projects",
          ",: setup and settings",
          "Enter: full conversation",
          "d: complete diff",
          "h: activity history",
          "n: new card with description",
          "s: start stage agent · x: stop · c: message",
          "a: approve · R: reject with reason · r: recheck",
          "b: send back or reopen · f: done · D: delete",
          "u: spend · e: sessions",
          "q: quit · Esc: close the current view",
          "",
          "Editor",
          "Mouse: click to place the cursor, wheel to move through multiline drafts",
          "Submit and Cancel buttons use the same validation as the keyboard.",
          "←/→: move cursor · Home/End or Ctrl+A/E: first/last",
          "Ctrl+W: delete word · Ctrl+U/K: clear before/after cursor",
          "Ctrl+J: newline in descriptions and messages",
          "Enter: submit · Esc: cancel",
          "Pasted text never submits a form.",
          "",
          "Reader",
          "j/k or ↑/↓: scroll · PgUp/PgDn: page",
          "g/G: first/last · /: find · n: next match",
          "Wheel: scroll · Follow: resume live output",
          "",
          "Menus and settings",
          "Click a row to open it. Wheel to move through longer lists.",
          "Use Back and the action buttons to navigate and edit settings.",
          "",
          "Artifact previews",
          "Wheel: pan · Zoom in/out: scale · Fit: reset · Back: close",
        ]),
      ),
    ]);
  }
  useEffect(() => {
    const open: Record<WorkbenchPage, () => void> = {
      commands,
      message,
      reject: () => {
        if (feature)
          form(
            "Reason for rework (optional)",
            (reason) => act("Card rejected", () => client.rejectFeature(feature.id, reason || undefined)),
            { multiline: true },
          );
      },
      projects: projectsPage,
      conversation,
      changes,
      artifacts,
      runs,
      move,
      agents,
      new: () => newCard(),
      sessions,
      spend,
      search: () =>
        list(
          "Find a card",
          features.map((f) =>
            choice(f.id, f.title, () => chooseFeature(f.id), `${f.status} ${f.description}`),
          ),
        ),
      integrations,
    };
    open[initial]();
  }, []);
  return (
    <Box flexDirection="column">
      {busy ? (
        <Text color="cyan">Working…</Text>
      ) : page?.kind === "preview" ? (
        <ArtifactPreview client={client} artifact={page.artifact} onClose={back} />
      ) : page?.kind === "conversation" && feature ? (
        <Conversation client={client} feature={feature} onClose={back} onMessage={message} />
      ) : page?.kind === "list" ? (
        <Navigator key={revision} title={page.title} choices={page.choices} onClose={back} />
      ) : page?.kind === "read" ? (
        <Reader key={revision} title={page.title} lines={page.lines} onClose={back} />
      ) : page?.kind === "form" ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold>{terminalText(page.title)}</Text>
          <Text dimColor>{terminalText(page.hint)}</Text>
          <TextInput
            key={revision}
            value={page.value}
            onChange={(value) => {
              const next = { ...page, value };
              pageRef.current = next;
              setPage(next);
            }}
            onSubmit={page.submit}
            onCancel={back}
            mask={page.mask ?? false}
            multiline={page.multiline ?? false}
            showActions
          />
        </Box>
      ) : (
        <Text dimColor>Loading…</Text>
      )}
      {error && <Text color="red">{terminalText(error)}</Text>}
    </Box>
  );
}
