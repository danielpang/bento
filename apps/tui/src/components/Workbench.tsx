import { ArtifactPreview } from "./ArtifactPreview.js";
import { accountSettings } from "./account-settings.js";
import { Conversation, type ConversationViewState } from "./Conversation.js";
import { artifactStages } from "./conversation-layout.js";
import { advancedSettings } from "./workbench-settings.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { BentoClient, Feature, Project, Stage, AgentProfile, RunArtifact } from "@bento/api-client";
import { describeCriterion } from "../criteria.js";
import { terminalText } from "../terminal.js";
import { Navigator, Reader, type Choice } from "./Navigator.js";
import { Form, type FormField, type FormValues, type FormOptions } from "./Form.js";
import { GitIdentity } from "./GitIdentity.js";

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
  | "mcp"
  | "team"
  | "account"
  | "billing"
  | "identity"
  | "reject"
  | "message";
type Page =
  | { kind: "identity" }
  | { kind: "preview"; artifact: RunArtifact }
  | { kind: "conversation"; compose?: boolean }
  | { kind: "list"; title: string; choices: Choice[] }
  | { kind: "read"; title: string; lines: string[] }
  | {
      kind: "fields";
      title: string;
      fields: FormField[];
      values: FormValues;
      options: FormOptions;
      submit: (values: FormValues) => void | Promise<void>;
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
  const [feature, setFeature] = useState(selectedFeature);
  const [page, setPage] = useState<Page | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const pending = useRef(false);
  const stack = useRef<Page[]>([]);
  const pageRef = useRef<Page | null>(null);
  const conversationView = useRef<ConversationViewState | undefined>(undefined);
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
    opts: {
      value?: string;
      hint?: string;
      mask?: boolean;
      multiline?: boolean;
      submitLabel?: string;
      fullDescription?: boolean;
    } = {},
  ) {
    fieldsForm(
      title,
      [
        {
          id: "value",
          label: title,
          value: opts.value ?? "",
          mask: opts.mask ?? false,
          multiline: opts.multiline ?? false,
        },
      ],
      (values) => submit(values.value ?? ""),
      {
        ...(opts.hint ? { description: opts.hint } : {}),
        ...(opts.submitLabel ? { submitLabel: opts.submitLabel } : {}),
        ...(opts.fullDescription ? { fullDescription: true } : {}),
      },
    );
  }
  function fieldsForm(
    title: string,
    fields: FormField[],
    submit: (values: FormValues) => void | Promise<void>,
    options: FormOptions = {},
  ) {
    show({
      kind: "fields",
      title,
      fields,
      values: Object.fromEntries(fields.map((field) => [field.id, field.value ?? ""])),
      submit,
      options,
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
      { hint: `${consequences} Type confirm, then Enter.`, submitLabel: "Confirm", fullDescription: true },
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
        fieldsForm(
          "Create project",
          [
            { id: "name", label: "Project name", required: true },
            { id: "source", label: "Repository path (optional)", placeholder: "Connect a repository later" },
          ],
          async ({ name = "", source = "" }) => {
            if (/^(https?:\/\/|git@|ssh:\/\/)/.test(source.trim()))
              throw new Error(
                "Use a checkout path on the server, or leave this blank to connect a repository later.",
              );
            const created = await client.createProject({
              name: name.trim(),
              ...(source.trim() ? { localPath: source.trim() } : {}),
            });
            onProject(created.id);
            onClose();
          },
          {
            submitLabel: "Create project",
            description: "Use a checkout on the server, or connect a repository later.",
          },
        ),
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
    fieldsForm(
      parentId ? "New related card" : "New card",
      [
        { id: "title", label: "Title", required: true },
        { id: "description", label: "Description (optional)", multiline: true },
      ],
      async ({ title = "", description = "" }) => {
        const created = await client.createFeature({
          projectId: project.id,
          title: title.trim(),
          description,
          ...(parentId ? { parentId } : {}),
        });
        // A refresh failure must not turn a successful creation into a second card on retry.
        await onChanged().catch(() => {});
        chooseFeature(created.id);
      },
      { submitLabel: "Create card", description: `Project: ${project.name}` },
    );
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
  function artifacts(stageSlug?: string, artifactId?: string) {
    if (!feature) return;
    void load(async () => {
      const items = await client.listArtifacts(feature.id);
      const artifactChoices = (selected: RunArtifact[]) =>
        selected.map((artifact) =>
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
                choice("preview", "Open in browser", () =>
                  read(artifact.path, [
                    "Open the artifact preview:",
                    new URL(`/api/artifacts/${artifact.id}/preview`, baseUrl).toString(),
                  ]),
                ),
              ]),
            `${artifact.stageName} · ${artifact.kind} · ${artifact.size} bytes`,
          ),
        );
      if (artifactId !== undefined) {
        const selected = artifactChoices(items).find((item) => item.id === artifactId);
        if (selected) selected.select();
        else read("Artifact unavailable", ["This artifact is no longer available."]);
        return;
      }
      const groups = artifactStages(items, stages);
      const openStage = (slug: string) => {
        const group = groups.find((group) => group.slug === slug);
        if (!group) {
          read("Stage artifacts", ["This stage is no longer available."]);
          return;
        }
        if (!group.artifacts.length) {
          read(`${group.name} · Artifacts`, [
            "No artifacts yet for this stage.",
            "Generated files will appear here after the agent produces them.",
          ]);
          return;
        }
        list(`${group.name} · ${group.artifacts.length} artifacts`, artifactChoices(group.artifacts));
      };
      if (stageSlug !== undefined) openStage(stageSlug);
      else
        list("Artifacts by stage", [
          choice("all", `All stages · ${items.length} files`, () =>
            items.length
              ? list("All artifacts", artifactChoices(items))
              : read("All artifacts", ["No artifacts have been generated for this card yet."]),
          ),
          ...groups.map((group) =>
            choice(
              group.slug,
              `${group.name} · ${group.artifacts.length} files`,
              () => openStage(group.slug),
              group.artifacts[0]?.path ?? "No artifacts yet",
            ),
          ),
        ]);
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
            () => {
              void load(async () => {
                const selected = await client.getFeature(s.featureId);
                setFeature(selected);
                onFeature(selected.id);
                conversationView.current = undefined;
                show({ kind: "conversation" });
              });
            },
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
        client.getCheckStatus(feature.id, true),
        client.getMergeStatus(feature.id, true),
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
  const settingsUI = { list, choice, read, form, fieldsForm, act, confirm, load, link };
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
      list("Integrations", [
        choice("github", "GitHub connection and pull request settings", settings.github),
        choice("linear", "Linear connection, mappings and issue import", settings.linear),
        ...(health.mode === "multi"
          ? [choice("slack", "Slack connection and default project", settings.slack)]
          : []),
      ]);
    });
  }
  function message() {
    if (feature) show({ kind: "conversation", compose: true });
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
      choice("new", "Create card", () => newCard(), "n"),
      choice("setup", "Settings", onSetup, ","),
      ...(project
        ? [
            choice("sessions", "Sessions", sessions, "v / e"),
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
      choice("help", "Keyboard help", () =>
        read("Keyboard shortcuts", [
          "Board",
          "↑/↓ or j/k: select a card",
          "←/→ or Tab/Shift+Tab: change Kanban stage",
          "g/G: first/last card in the Kanban stage",
          "v / e: open project sessions",
          "Mouse: click a card to select, double-click to open",
          "Wheel: move through cards under the pointer",
          "Horizontal wheel or Shift+wheel: change Kanban stage",
          "/: find a card across lanes",
          ": or Ctrl+P: command palette",
          "p: switch projects",
          ",: settings",
          "Enter: full conversation",
          "d: complete diff",
          "h: activity history",
          "n: new card with description",
          "s: start stage agent · x: stop · c: message",
          "a: approve · R: reject with reason · r: recheck",
          "b: send back or reopen · f: done · D: delete",
          "u: spend",
          "q: quit · Esc: close the current view",
          "",
          "Editor",
          "Mouse: click to place the cursor, wheel to move through multiline drafts",
          "Submit and Cancel buttons use the same validation as the keyboard.",
          "←/→: move cursor · Home/End or Ctrl+A/E: first/last",
          "Ctrl+W: delete word · Ctrl+U/K: clear before/after cursor",
          "Ctrl+J: newline in descriptions and messages",
          "Tab/Shift+Tab: switch fields and buttons",
          "Ctrl+S: save or create · Enter: next field or activate button · Esc: cancel",
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
      mcp: settings.mcp,
      team: accounts.team,
      account: accounts.account,
      billing: accounts.billing,
      identity: () => show({ kind: "identity" }),
    };
    open[initial]();
  }, []);
  return (
    <Box flexDirection="column">
      {busy ? (
        <Text color="cyan">Working…</Text>
      ) : page?.kind === "identity" ? (
        <GitIdentity client={client} onClose={back} />
      ) : page?.kind === "preview" ? (
        <ArtifactPreview
          client={client}
          artifact={page.artifact}
          onClose={back}
          webUrl={new URL(`/api/artifacts/${page.artifact.id}/preview`, baseUrl).toString()}
        />
      ) : page?.kind === "conversation" && feature ? (
        <Conversation
          client={client}
          feature={feature}
          stages={stages}
          profiles={profiles}
          onClose={back}
          onMessageSent={onChanged}
          allowAttachments={beta}
          initialCompose={page.compose ?? false}
          onArtifacts={artifacts}
          initialView={conversationView.current}
          onViewChange={(view) => {
            conversationView.current = view;
          }}
        />
      ) : page?.kind === "list" ? (
        <Navigator key={revision} title={page.title} choices={page.choices} onClose={back} />
      ) : page?.kind === "read" ? (
        <Reader key={revision} title={page.title} lines={page.lines} onClose={back} />
      ) : page?.kind === "fields" ? (
        <Form
          key={revision}
          title={page.title}
          fields={page.fields}
          initialValues={page.values}
          {...page.options}
          onValuesChange={(values) => {
            const next = { ...page, values };
            pageRef.current = next;
            setPage(next);
          }}
          onSubmit={page.submit}
          onCancel={back}
        />
      ) : (
        <Text dimColor>Loading…</Text>
      )}
      {error && <Text color="red">{terminalText(error)}</Text>}
    </Box>
  );
}
