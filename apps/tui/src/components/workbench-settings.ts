import type {
  BentoClient,
  Project,
  McpServerStatus,
  McpServerPatch,
  McpServerInput,
  McpCatalogEntry,
} from "@bento/api-client";
import type { Choice } from "./Navigator.js";
import type { FormField, FormValues, FormOptions } from "./Form.js";

export interface SettingsUI {
  fieldsForm: (
    title: string,
    fields: FormField[],
    submit: (values: FormValues) => void | Promise<void>,
    options?: FormOptions,
  ) => void;
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
  const { list, choice, read, form, fieldsForm, act, confirm, load, link } = ui;
  function github() {
    void load(async () => {
      const [status, settings, credentials] = await Promise.all([
        client.githubStatus(),
        client.githubSettings(),
        client.listSecrets(),
      ]);
      const token = credentials.secrets.find((secret) => secret.name === "GITHUB_TOKEN");
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
          ...(credentials.canManage
            ? [
                choice(
                  "token",
                  token ? `Replace personal access token (${token.hint})` : "Add personal access token",
                  () =>
                    form(
                      "GitHub personal access token",
                      (value) => {
                        if (value.trim())
                          act("GitHub token saved", () =>
                            client.createSecret({ name: "GITHUB_TOKEN", value: value.trim() }),
                          );
                      },
                      {
                        mask: true,
                        hint: "Optional alternative to a GitHub App connection. Enter save · Esc back",
                      },
                    ),
                ),
                ...(token
                  ? [
                      choice("remove-token", "Remove personal access token", () =>
                        confirm(
                          "Remove GitHub token",
                          "Publishing that relies on this token will stop.",
                          () => client.deleteSecret(token.id),
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
    fieldsForm(
      "Add MCP server",
      [
        { id: "name", label: "Server name", required: true },
        { id: "slug", label: "Slug (optional)", placeholder: "Generated from the name" },
        { id: "url", label: "Endpoint URL", required: true },
        ...(canManage
          ? [
              {
                id: "scope",
                label: "Who can use this server?",
                value: "personal",
                options: [
                  { value: "personal", label: "Only you" },
                  { value: "org", label: "Organization" },
                ],
              },
            ]
          : []),
        {
          id: "transport",
          label: "Transport",
          value: "http",
          options: [
            { value: "http", label: "Streamable HTTP" },
            { value: "sse", label: "Server-sent events (SSE)" },
          ],
        },
        {
          id: "authType",
          label: "Authentication",
          value: "none",
          options: [
            { value: "none", label: "No authentication" },
            { value: "api_key", label: "API key" },
            { value: "oauth", label: "OAuth" },
          ],
        },
        ...(canManage
          ? [
              {
                id: "credentialScope",
                label: "Organization OAuth credentials",
                when: (values: FormValues) => values.scope === "org" && values.authType === "oauth",
                value: "user",
                options: [
                  { value: "user", label: "Each member connects their own account" },
                  { value: "org", label: "Share one account with the organization" },
                ],
              },
            ]
          : []),
      ],
      ({
        name = "",
        slug = "",
        url = "",
        scope = "personal",
        transport = "http",
        authType = "none",
        credentialScope = "user",
      }) => {
        const parsed = new URL(url.trim());
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
          throw new Error("Enter an HTTP or HTTPS URL without embedded credentials.");
        const address =
          slug.trim() ||
          name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        if (!/^[a-z0-9][a-z0-9-]*$/.test(address))
          throw new Error("Use lowercase letters, numbers and hyphens for the slug.");
        const draft: McpServerInput = {
          name: name.trim(),
          slug: address,
          url: parsed.toString(),
          personal: !canManage || scope === "personal",
          transport: transport === "sse" ? "sse" : "http",
          authType: authType === "oauth" ? "oauth" : authType === "api_key" ? "api_key" : "none",
        };
        if (!draft.personal && authType === "oauth")
          draft.credentialScope = credentialScope === "org" ? "org" : "user";
        act("MCP server added. Open the server to connect or configure credentials.", () =>
          client.createMcpServer(draft),
        );
      },
      { submitLabel: "Add server" },
    );
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
                fieldsForm(
                  "Configure OAuth client",
                  [
                    { id: "clientId", label: "Client ID", required: true },
                    { id: "clientSecret", label: "Client secret (optional)", mask: true },
                    {
                      id: "scopes",
                      label: "Scopes (optional)",
                      placeholder: "Space separated; blank uses provider defaults",
                    },
                  ],
                  ({ clientId = "", clientSecret = "", scopes = "" }) =>
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
                  {
                    submitLabel: "Review changes",
                    description:
                      "Existing client credentials are never read back. Blank secret creates a public client.",
                  },
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
      const [status, catalog] = await Promise.all([
        client.mcpStatus(),
        client.mcpCatalog().catch(() => null),
      ]);
      const serverChoices = status.servers.map((server) =>
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
                    choice("details", "Edit server details", () =>
                      fieldsForm(
                        "MCP server details",
                        [
                          { id: "name", label: "Server name", value: server.name, required: true },
                          { id: "url", label: "Endpoint URL", value: server.url, required: true },
                        ],
                        ({ name = "", url = "" }) =>
                          act("Server saved", () =>
                            client.updateMcpServer(server.id, { name: name.trim(), url: url.trim() }),
                          ),
                      ),
                    ),
                    choice("remove", "Remove server", () =>
                      confirm("Remove MCP server", "Agents will no longer be able to use this server.", () =>
                        client.deleteMcpServer(server.id),
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
                      confirm("Disconnect your account", "Your agents lose access to this connection.", () =>
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
      );
      function catalogChoice(entry: McpCatalogEntry): Choice {
        const index = status.servers.findIndex(
          (server) => server.url.replace(/\/$/, "") === entry.url.replace(/\/$/, ""),
        );
        const added = entry.added || index >= 0;
        return choice(
          entry.name,
          `${added ? "" : "Add "}${entry.title} · ${added ? "Added" : entry.featured ? "Featured" : entry.publisher}`,
          () => {
            if (added) {
              if (index >= 0) serverChoices[index]!.select();
              else read(entry.title, ["This server is already configured."]);
              return;
            }
            act("MCP server added. Open the server to connect your account.", () =>
              client.createMcpServer({
                name: entry.title.slice(0, 120),
                slug: entry.slug,
                url: entry.url,
                transport: entry.transport,
                personal: true,
              }),
            );
          },
          [entry.category, entry.description].filter(Boolean).join(" · "),
        );
      }
      list("MCP servers", [
        ...serverChoices,
        ...(catalog?.entries ?? []).filter((entry) => entry.featured).map(catalogChoice),
        choice("catalog", "Browse MCP catalog", () =>
          form("Search MCP catalog", (query) => {
            void load(async () => {
              const result = await client.mcpCatalog(query);
              if (!result.reachable) {
                read("MCP catalog unavailable", ["Try again later, or add a custom server."]);
                return;
              }
              list("MCP catalog", result.entries.map(catalogChoice));
            });
          }),
        ),
        choice("custom", "Add custom MCP server", () => customMcp(status.canManage)),
        choice("refresh", "Refresh connection status", mcp),
        ...(!catalog?.reachable
          ? [
              choice("unavailable", "Featured servers unavailable", () =>
                read("MCP catalog unavailable", [
                  "Your configured servers still work. Refresh to try again, or add a custom server.",
                ]),
              ),
            ]
          : []),
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
          fieldsForm(
            "Create access token",
            [
              { id: "name", label: "Connection name", required: true },
              {
                id: "scope",
                label: "Project access",
                value: "all",
                options: [
                  { value: "all", label: "All organization projects" },
                  ...projects.map((project) => ({ value: project.id, label: project.name })),
                ],
              },
            ],
            ({ name = "", scope = "all" }) => createConnection(name.trim(), scope === "all" ? [] : [scope]),
            { submitLabel: "Create token" },
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
  return { github, linear, slack, mcp };
}
