import type {
  BentoClient,
  Project,
  McpServerStatus,
  McpServerPatch,
  McpServerInput,
} from "@bento/api-client";
import type { Choice } from "./Navigator.js";

export interface SettingsUI {
  list: (title: string, choices: Choice[]) => void;
  choice: (id: string, label: string, select: () => void, detail?: string) => Choice;
  read: (title: string, lines: string[]) => void;
  form: (
    title: string,
    submit: (value: string) => void,
    opts?: { value?: string; hint?: string; mask?: boolean; multiline?: boolean },
  ) => void;
  act: (title: string, work: () => Promise<unknown>) => void;
  confirm: (title: string, consequences: string, work: () => Promise<unknown>) => void;
  load: (work: () => Promise<void>) => Promise<void>;
  link: (title: string, path: string) => void;
}

/** Complements setup's guided tool/model and gate-criteria editors. */
export function advancedSettings(
  client: BentoClient,
  project: Project | undefined,
  beta: boolean,
  ui: SettingsUI,
) {
  const { list, choice, read, form, act, confirm, load, link } = ui;
  function agents() {
    void load(async () => {
      const profiles = await client.listProfiles();
      list(
        "Agent instructions",
        profiles.map((profile) =>
          choice(
            profile.id,
            profile.name,
            () =>
              list(profile.name, [
                choice("skill", "Edit operating instructions", () =>
                  form(
                    "Agent instructions",
                    (skill) =>
                      act("Instructions saved", () =>
                        client.updateProfile(profile.id, { skill: skill || null }),
                      ),
                    {
                      value: profile.skill ?? "",
                      multiline: true,
                      hint: "Enter save · Ctrl+J newline · Esc back",
                    },
                  ),
                ),
                choice("args", "Edit extra CLI arguments", () =>
                  form(
                    "Extra arguments as a JSON array",
                    (text) =>
                      act("Arguments saved", async () => {
                        const args: unknown = JSON.parse(text);
                        if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
                          throw new Error('Enter an array of strings, for example ["--verbose"].');
                        return client.updateProfile(profile.id, { extraArgs: args });
                      }),
                    { value: JSON.stringify(profile.extraArgs ?? []) },
                  ),
                ),
              ]),
            `${profile.cli} · ${profile.model}`,
          ),
        ),
      );
    });
  }
  function pipeline() {
    if (!project) return;
    void load(async () => {
      const pipeline = await client.getPipeline(project.id);
      list(
        "Stage instructions and order",
        pipeline.stages.map((stage, at) =>
          choice(stage.id, `${at + 1}. ${stage.name}`, () =>
            list(stage.name, [
              choice("description", "Edit stage instructions", () =>
                form(
                  "Stage instructions",
                  (description) =>
                    act("Stage instructions saved", () => client.updateStage(stage.id, { description })),
                  {
                    value: stage.description,
                    multiline: true,
                    hint: "Enter save · Ctrl+J newline · Esc back",
                  },
                ),
              ),
              ...([-1, 1] as const).flatMap((delta) => {
                const to = at + delta;
                if (to < 0 || to >= pipeline.stages.length) return [];
                return [
                  choice(String(delta), delta < 0 ? "Move stage earlier" : "Move stage later", () =>
                    act("Stage order saved", async () => {
                      const fresh = await client.getPipeline(project.id);
                      const ids = fresh.stages.map((s) => s.id);
                      const from = ids.indexOf(stage.id);
                      const target = from + delta;
                      if (from < 0 || target < 0 || target >= ids.length)
                        throw new Error("The pipeline changed. Open stage settings again.");
                      [ids[from], ids[target]] = [ids[target]!, ids[from]!];
                      return client.reorderStages(fresh.id, ids);
                    }),
                  ),
                ];
              }),
            ]),
          ),
        ),
      );
    });
  }
  function github() {
    void load(async () => {
      const [status, settings] = await Promise.all([client.githubStatus(), client.githubSettings()]);
      list(
        `GitHub · ${status.installation?.accountLogin ?? (status.canPublish ? "token connected" : "not connected")}`,
        [
          choice("state", "Publishing status", () =>
            read("GitHub", [
              `Can publish: ${status.canPublish ? "yes" : "no"}`,
              `Identity linked: ${status.identityLinked ? "yes" : "no"}`,
            ]),
          ),
          ...(status.canManage
            ? [
                choice("install", "Install GitHub App", () => {
                  void load(async () =>
                    read("Continue in your browser", [(await client.startGitHubInstall()).url]),
                  );
                }),
                choice("existing", "Connect an existing installation", () => {
                  void load(async () =>
                    list(
                      "GitHub installations",
                      (await client.listGitHubInstallations()).map((install) =>
                        choice(install.installationId, install.accountLogin ?? install.installationId, () =>
                          act("GitHub connected", () =>
                            client.connectGitHubInstallation(install.installationId),
                          ),
                        ),
                      ),
                    ),
                  );
                }),
                choice(
                  "notes",
                  `${settings.includeStageNotesInPr ? "Exclude" : "Include"} stage notes in pull requests`,
                  () =>
                    act("Pull request settings saved", () =>
                      client.setGitHubSettings({ includeStageNotesInPr: !settings.includeStageNotesInPr }),
                    ),
                ),
                ...(status.connected
                  ? [
                      choice("disconnect", "Disconnect GitHub", () =>
                        confirm("Disconnect GitHub", "Publishing through this connection will stop.", () =>
                          client.disconnectGitHub(),
                        ),
                      ),
                    ]
                  : []),
              ]
            : []),
          choice("identity", "GitHub identity settings in browser", () =>
            link("GitHub identity", "/settings?tab=github"),
          ),
        ],
      );
    });
  }
  function linear() {
    void load(async () => {
      const status = await client.linearStatus();
      const projects = await client.listProjects();
      const current = projects.find((p) => p.id === project?.id);
      list(`Linear · ${status.connected ? "connected" : "not connected"}`, [
        ...(status.canManage
          ? [
              choice("key", "Connect or replace API key", () =>
                form(
                  "Linear API key",
                  (value) => act("Linear connected", () => client.connectLinear(value.trim())),
                  { mask: true },
                ),
              ),
              ...(status.connected
                ? [
                    choice("disconnect", "Disconnect Linear", () =>
                      confirm("Disconnect Linear", "Removes this team's Linear connection.", () =>
                        client.disconnectLinear(),
                      ),
                    ),
                  ]
                : []),
            ]
          : []),
        ...(status.connected
          ? [
              choice("sync", "Sync now", () => act("Sync requested", () => client.syncLinearNow())),
              ...(status.canManage
                ? [
                    choice("default", "Default project for incoming issues", () =>
                      list("Default project", [
                        choice("none", "None", () =>
                          act("Default project saved", () =>
                            client.setLinearSettings({ defaultProjectId: null }),
                          ),
                        ),
                        ...projects.map((p) =>
                          choice(p.id, p.name, () =>
                            act("Default project saved", () =>
                              client.setLinearSettings({ defaultProjectId: p.id }),
                            ),
                          ),
                        ),
                      ]),
                    ),
                    choice("map", "Map a Linear team to a project", () => {
                      void load(async () =>
                        list(
                          "Choose Linear team",
                          (await client.listLinearTeams()).map((team) =>
                            choice(team.id, `${team.key} ${team.name}`, () =>
                              list(
                                "Choose Bento project",
                                projects.map((p) =>
                                  choice(p.id, p.name, () =>
                                    act("Team mapping saved", () =>
                                      client.createLinearMapping({ linearTeamId: team.id, projectId: p.id }),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      );
                    }),
                    ...status.mappings.map((mapping) =>
                      choice(mapping.id, `Remove ${mapping.linearTeamKey} mapping`, () =>
                        confirm("Remove team mapping", "Incoming issues will use the default project.", () =>
                          client.deleteLinearMapping(mapping.id),
                        ),
                      ),
                    ),
                  ]
                : []),
              ...(current
                ? [
                    choice("import", "Import issues into this project", () => {
                      void load(async () =>
                        list(
                          "Choose Linear team",
                          (await client.listLinearTeams()).map((team) =>
                            choice(team.id, `${team.key} ${team.name}`, () => issues(team.id, current.id)),
                          ),
                        ),
                      );
                    }),
                    choice(
                      "outbound",
                      `${current.linearCreateIssues ? "Disable" : "Enable"} issue creation for new cards`,
                      () =>
                        act("Issue creation saved", () =>
                          client.setProjectLinearSettings(current.id, {
                            createIssues: !current.linearCreateIssues,
                          }),
                        ),
                    ),
                    choice("team", "Destination team for new issues", () => {
                      void load(async () =>
                        list("Destination team", [
                          choice("none", "Use project mapping", () =>
                            act("Destination saved", () =>
                              client.setProjectLinearSettings(current.id, { teamId: null }),
                            ),
                          ),
                          ...(await client.listLinearTeams()).map((team) =>
                            choice(team.id, `${team.key} ${team.name}`, () =>
                              act("Destination saved", () =>
                                client.setProjectLinearSettings(current.id, { teamId: team.id }),
                              ),
                            ),
                          ),
                        ]),
                      );
                    }),
                    ...(current.linearTeamId
                      ? [
                          choice("project", "Destination Linear project", () => {
                            void load(async () =>
                              list("Linear project", [
                                choice("none", "No Linear project", () =>
                                  act("Destination saved", () =>
                                    client.setProjectLinearSettings(current.id, { linearProjectId: null }),
                                  ),
                                ),
                                ...(await client.listLinearProjects(current.linearTeamId!)).map((p) =>
                                  choice(p.id, p.name, () =>
                                    act("Destination saved", () =>
                                      client.setProjectLinearSettings(current.id, { linearProjectId: p.id }),
                                    ),
                                  ),
                                ),
                              ]),
                            );
                          }),
                        ]
                      : []),
                  ]
                : []),
            ]
          : []),
      ]);
    });
  }
  function issues(teamId: string, projectId: string, after?: string) {
    void load(async () => {
      const result = await client.listLinearIssues(teamId, after);
      list("Import an issue", [
        ...result.issues.map((issue) =>
          choice(
            issue.id,
            `${issue.identifier} ${issue.title}`,
            () => act("Issue imported", () => client.importLinearIssues({ projectId, issueIds: [issue.id] })),
            issue.imported ? "Already imported" : issue.stateName,
          ),
        ),
        ...(result.hasNextPage && result.endCursor
          ? [choice("next", "Next page", () => issues(teamId, projectId, result.endCursor!))]
          : []),
      ]);
    });
  }
  function slack() {
    void load(async () => {
      const status = await client.slackStatus();
      const projects = await client.listProjects();
      list(`Slack · ${status.teamName ?? "not connected"}`, [
        ...(status.canManage
          ? [
              ...(status.configured
                ? [
                    choice("connect", "Connect Slack in browser", () => {
                      void load(async () =>
                        read("Continue in your browser", [(await client.startSlackInstall()).url]),
                      );
                    }),
                  ]
                : []),
              choice("default", "Default project", () =>
                list("Choose project", [
                  choice("none", "None", () =>
                    act("Slack settings saved", () => client.setSlackSettings({ defaultProjectId: null })),
                  ),
                  ...projects.map((p) =>
                    choice(p.id, p.name, () =>
                      act("Slack settings saved", () => client.setSlackSettings({ defaultProjectId: p.id })),
                    ),
                  ),
                ]),
              ),
              ...(status.connected
                ? [
                    choice("disconnect", "Disconnect Slack", () =>
                      confirm("Disconnect Slack", "The app will stop using this Slack connection.", () =>
                        client.disconnectSlack(),
                      ),
                    ),
                  ]
                : []),
            ]
          : []),
        choice("help", "Connection information", () =>
          read("Slack", [
            status.configured
              ? "Slack is configured on this deployment."
              : "Ask the server operator to configure the Slack app.",
            ...(status.eventsUrl ? [`Events: ${status.eventsUrl}`] : []),
            ...(status.interactivityUrl ? [`Interactivity: ${status.interactivityUrl}`] : []),
          ]),
        ),
      ]);
    });
  }
  function customMcp(canManage: boolean) {
    const draft: McpServerInput = { name: "", slug: "", url: "", personal: !canManage };
    function address() {
      form("MCP endpoint URL", (url) => {
        void load(async () => {
          const parsed = new URL(url.trim());
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
            throw new Error("Enter an HTTP or HTTPS URL without embedded credentials.");
          draft.url = parsed.toString();
          list(
            "Transport",
            (["http", "sse"] as const).map((transport) =>
              choice(transport, transport === "http" ? "Streamable HTTP" : "Server-sent events (SSE)", () => {
                draft.transport = transport;
                list(
                  "Authentication",
                  (["none", "api_key", "oauth"] as const).map((authType) =>
                    choice(
                      authType,
                      authType === "none"
                        ? "No authentication"
                        : authType === "api_key"
                          ? "API key"
                          : "OAuth",
                      () => {
                        draft.authType = authType;
                        const save = () =>
                          act("MCP server added. Open the server to connect or configure credentials.", () =>
                            client.createMcpServer(draft),
                          );
                        if (authType === "oauth" && !draft.personal)
                          list("Credential sharing", [
                            choice("user", "Each member connects their own account", () => {
                              draft.credentialScope = "user";
                              save();
                            }),
                            choice("org", "Share one account with the organization", () => {
                              draft.credentialScope = "org";
                              save();
                            }),
                          ]);
                        else save();
                      },
                    ),
                  ),
                );
              }),
            ),
          );
        });
      });
    }
    form("MCP server name", (name) => {
      if (!name.trim()) return;
      draft.name = name.trim();
      form(
        "Server slug",
        (slug) => {
          void load(async () => {
            if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
              throw new Error("Use lowercase letters, numbers and hyphens.");
            draft.slug = slug;
            if (canManage)
              list("Who can use this server?", [
                choice("org", "Organization", () => {
                  draft.personal = false;
                  address();
                }),
                choice("personal", "Only you", () => {
                  draft.personal = true;
                  address();
                }),
              ]);
            else address();
          });
        },
        {
          value: name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, ""),
        },
      );
    });
  }
  function mcpAuthentication(server: McpServerStatus) {
    const save = (patch: McpServerPatch) =>
      confirm(
        "Change MCP configuration",
        "Changing authentication or credential sharing disconnects existing credentials. Reconnect after saving.",
        () => client.updateMcpServer(server.id, patch),
      );
    list(`${server.name} · Configuration`, [
      choice(
        "transport",
        "Transport",
        () =>
          list(
            "Transport",
            (["http", "sse"] as const).map((transport) =>
              choice(transport, transport === "http" ? "Streamable HTTP" : "Server-sent events (SSE)", () =>
                act("Transport saved", () => client.updateMcpServer(server.id, { transport })),
              ),
            ),
          ),
        server.transport,
      ),
      choice(
        "auth",
        "Authentication method",
        () =>
          list(
            "Authentication",
            (["none", "api_key", "oauth"] as const).map((authType) =>
              choice(
                authType,
                authType === "none" ? "No authentication" : authType === "api_key" ? "API key" : "OAuth",
                () =>
                  save({
                    authType,
                    credentialScope: server.personal
                      ? "user"
                      : authType === "oauth"
                        ? server.credentialScope
                        : "org",
                  }),
              ),
            ),
          ),
        server.authType,
      ),
      ...(server.authType === "api_key"
        ? [
            choice(
              "header",
              "API key header",
              () =>
                form(
                  "HTTP header name",
                  (apiKeyHeader) =>
                    act("Header saved", () =>
                      client.updateMcpServer(server.id, { apiKeyHeader: apiKeyHeader.trim() }),
                    ),
                  { value: server.apiKeyHeader },
                ),
              server.apiKeyHeader,
            ),
          ]
        : []),
      ...(server.authType === "oauth"
        ? [
            ...(!server.personal
              ? [
                  choice(
                    "scope",
                    "Credential sharing",
                    () =>
                      list("Credential sharing", [
                        choice("user", "Each member connects their own account", () =>
                          save({ credentialScope: "user" }),
                        ),
                        choice("org", "Share one account with the organization", () =>
                          save({ credentialScope: "org" }),
                        ),
                      ]),
                    server.credentialScope,
                  ),
                ]
              : []),
            choice(
              "client",
              "Configure OAuth client",
              () =>
                form(
                  "OAuth client ID",
                  (clientId) => {
                    if (!clientId.trim()) return;
                    form(
                      "OAuth client secret",
                      (clientSecret) =>
                        form(
                          "OAuth scopes (space separated)",
                          (scopes) =>
                            confirm(
                              "Save OAuth client",
                              "Replace the client registration, secret and requested scopes. Reconnect your account after saving.",
                              () =>
                                client.updateMcpServer(server.id, {
                                  clientId: clientId.trim(),
                                  clientSecret: clientSecret || null,
                                  scopes: scopes.trim() || null,
                                }),
                            ),
                          { hint: "Enter save · Esc back. Empty uses provider defaults." },
                        ),
                      {
                        mask: true,
                        hint: "Enter continue · Esc back. Empty creates a public client without a secret.",
                      },
                    );
                  },
                  { hint: "Enter continue · Esc back. Existing client credentials are never read back." },
                ),
              server.oauthClientConfigured ? "Client registered" : "Automatic discovery",
            ),
            choice("automatic", "Use automatic OAuth registration", () =>
              confirm(
                "Reset OAuth client",
                "Remove the manually configured client, secret and scopes. The provider must support automatic registration.",
                () => client.updateMcpServer(server.id, { clientId: null, clientSecret: null, scopes: null }),
              ),
            ),
          ]
        : []),
    ]);
  }
  function mcp() {
    void load(async () => {
      const status = await client.mcpStatus();
      list("MCP servers", [
        choice("custom", "Add custom MCP server", () => customMcp(status.canManage)),
        choice("refresh", "Refresh connection status", mcp),
        choice("catalog", "Browse MCP catalog", () =>
          form("Search MCP catalog", (query) => {
            void load(async () => {
              const catalog = await client.mcpCatalog(query);
              if (!catalog.reachable) {
                read("MCP catalog unavailable", ["Try again later, or add a custom server from setup."]);
                return;
              }
              list(
                "MCP catalog",
                catalog.entries.map((entry) =>
                  choice(
                    entry.name,
                    entry.title,
                    () =>
                      act("MCP server added", () =>
                        client.createMcpServer({
                          name: entry.title,
                          slug: entry.slug,
                          url: entry.url,
                          transport: entry.transport,
                          personal: !catalog.canManage,
                        }),
                      ),
                    entry.added ? "Already added" : entry.description,
                  ),
                ),
              );
            });
          }),
        ),
        ...status.servers.map((server) =>
          choice(
            server.id,
            server.name,
            () =>
              list(server.name, [
                choice("state", "Connection details", () =>
                  read(server.name, [
                    server.url,
                    `${server.transport} · ${server.authType} · ${server.credentialScope}`,
                    server.enabled ? "Enabled" : "Disabled",
                    `Team credential: ${server.orgCredential?.connected ? server.orgCredential.hint : "not connected"}`,
                    `Your credential: ${server.userCredential?.connected ? "connected" : "not connected"}`,
                  ]),
                ),
                ...(server.personal && !server.mine && status.canManage
                  ? [
                      choice(
                        "govern",
                        server.enabled ? "Disable personal server" : "Enable personal server",
                        () =>
                          act("Server saved", () =>
                            client.updateMcpServer(server.id, { enabled: !server.enabled }),
                          ),
                      ),
                      choice("remove-personal", "Remove personal server", () =>
                        confirm(
                          "Remove personal server",
                          "The owner's agents will lose access to this server.",
                          () => client.deleteMcpServer(server.id),
                        ),
                      ),
                    ]
                  : []),
                ...((server.personal ? server.mine : status.canManage)
                  ? [
                      choice("authentication", "Authentication, transport and credential sharing", () =>
                        mcpAuthentication(server),
                      ),
                      choice("toggle", server.enabled ? "Disable server" : "Enable server", () =>
                        act("MCP server saved", () =>
                          client.updateMcpServer(server.id, { enabled: !server.enabled }),
                        ),
                      ),
                      choice("name", "Rename server", () =>
                        form(
                          "Server name",
                          (name) => act("Server saved", () => client.updateMcpServer(server.id, { name })),
                          { value: server.name },
                        ),
                      ),
                      choice("url", "Edit server URL", () =>
                        form(
                          "Server URL",
                          (url) => act("Server saved", () => client.updateMcpServer(server.id, { url })),
                          { value: server.url },
                        ),
                      ),
                      choice("remove", "Remove server", () =>
                        confirm(
                          "Remove MCP server",
                          "Agents will no longer be able to use this server.",
                          () => client.deleteMcpServer(server.id),
                        ),
                      ),
                    ]
                  : []),
                ...(server.authType === "api_key" && (server.personal ? server.mine : status.canManage)
                  ? [
                      choice("key", "Set API key", () =>
                        form(
                          "MCP API key",
                          (value) => act("MCP credential saved", () => client.setMcpApiKey(server.id, value)),
                          { mask: true },
                        ),
                      ),
                      choice("clear", "Disconnect API key", () =>
                        confirm("Disconnect key", "The server will need a new credential.", () =>
                          client.disconnectMcpCredential(server.id),
                        ),
                      ),
                    ]
                  : []),
                ...(server.authType === "oauth" &&
                (server.personal ? server.mine : server.credentialScope === "user" || status.canManage)
                  ? [
                      choice("oauth", "Connect your account in browser", () => {
                        void load(async () =>
                          read("Continue in your browser", [(await client.startMcpConnect(server.id)).url]),
                        );
                      }),
                      choice("disconnect", "Disconnect your account", () =>
                        confirm(
                          "Disconnect your account",
                          "Your agents lose access to this connection.",
                          () =>
                            server.personal || server.credentialScope === "user"
                              ? client.disconnectMcpUserCredential(server.id)
                              : client.disconnectMcpCredential(server.id),
                        ),
                      ),
                    ]
                  : []),
              ]),
            `${server.enabled ? "enabled" : "disabled"} · ${server.authType}`,
          ),
        ),
        ...(beta ? [choice("connections", "Agents connected to Bento", connections)] : []),
      ]);
    });
  }
  function connections() {
    void load(async () => {
      const result = await client.listMcpConnections();
      const projects = await client.listProjects();
      list("Agents connected to Bento", [
        choice("create", "Create an access token", () =>
          form("Connection name", (name) =>
            list("Connection scope", [
              choice("org", "All organization projects", () => createConnection(name, [])),
              ...projects.map((p) => choice(p.id, p.name, () => createConnection(name, [p.id]))),
            ]),
          ),
        ),
        ...result.connections.map((connection) =>
          choice(connection.id, connection.name, () =>
            list(connection.name, [
              choice("details", "Connection details", () =>
                read(connection.name, [
                  `Token: ${connection.tokenHint}`,
                  `Scope: ${connection.scope}`,
                  ...connection.projects.map((p) => p.name ?? "Removed project"),
                  `${connection.requestCount} requests`,
                  `Last used: ${connection.lastUsedAt ?? "never"}`,
                ]),
              ),
              ...(connection.mine || result.canManage
                ? [
                    choice("remove", "Revoke connection", () =>
                      confirm("Revoke connection", "The connected agent will lose access immediately.", () =>
                        client.deleteMcpConnection(connection.id),
                      ),
                    ),
                  ]
                : []),
            ]),
          ),
        ),
      ]);
    });
  }
  function createConnection(name: string, projectIds: string[]) {
    void load(async () => {
      const result = await client.createMcpConnection({
        name,
        scope: projectIds.length ? "projects" : "organization",
        ...(projectIds.length ? { projectIds } : {}),
      });
      read("Copy your access token", ["This token is shown only once. Keep it private.", result.token]);
    });
  }
  function identity() {
    void load(async () => {
      const machine = await client.getMachineSettings();
      form(
        "Git author name",
        (gitAuthorName) =>
          form(
            "Git author email",
            (gitAuthorEmail) =>
              act("Git identity saved", () => client.setGitIdentity({ gitAuthorName, gitAuthorEmail })),
            { value: machine.gitAuthorEmail ?? "" },
          ),
        { value: machine.gitAuthorName ?? "" },
      );
    });
  }
  return { agents, pipeline, github, linear, slack, mcp, identity };
}
