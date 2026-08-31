import { useCallback, useEffect, useState } from "react";
import type { BentoClient, McpServerStatus, McpStatus } from "@bento/api-client";
import { BetaOnly } from "../beta.js";
import { McpConnectionsSection } from "./McpConnections.js";
import { ConfirmDialog } from "./PromptDialog.js";
import { SecretField } from "./SecretField.js";
import { SettingsCardSkeleton } from "./Skeleton.js";
import { useToast } from "./Toasts.js";

/**
 * The MCP tab: the organization defines its MCP servers once, and every
 * agent Bento runs gets them. Keys are stored encrypted and never shown
 * again; agents themselves only ever see a run-scoped gateway token.
 *
 * Two audiences read this page, so it is split by what each has to do.
 * "Your connections" is the member's card: the per-member servers, each
 * with a connect button, because that is the one action a non-admin
 * ever takes here. "Team servers" is the registry itself, where a scope
 * chip on every row says whether the whole team shares one credential
 * or each member signs in; whether a server is per team or per member
 * was the thing people could not tell at a glance.
 */
export function McpPanel({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useMcpOutcome();

  const reload = useCallback(async () => {
    try {
      setStatus(await client.mcpStatus());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  if (loadFailed) {
    return (
      <section className="section settings-card">
        <h3 className="settings-title">MCP servers</h3>
        <p className="error">Could not reach the server, so this cannot list MCP servers.</p>
        <button className="btn" disabled={busy} onClick={() => void act(async () => {})}>
          Retry
        </button>
      </section>
    );
  }
  if (!status) return <SettingsCardSkeleton rows={2} />;

  // Your side: the servers whose credential is yours to manage. Your own
  // personal servers, plus per-member team servers you sign in to.
  const yours = status.servers.filter(
    (s) => (s.personal && s.mine) || (!s.personal && s.userCredential !== null),
  );
  // The team registry, and (for admins) teammates' personal servers,
  // which are governance rather than something to connect.
  const teamServers = status.servers.filter((s) => !s.personal);
  const othersPersonal = status.servers.filter((s) => s.personal && !s.mine);

  return (
    <>
      <section className="section settings-card">
        <h3 className="settings-title">Your servers and sign-ins</h3>
        <p className="muted">
          Servers only your runs get, and the team servers that ask you to sign in with your own
          account. A run you start uses your connections; nothing here is shared with the team.
        </p>
        {yours.length === 0 && <p className="muted">Nothing to connect yet.</p>}
        {yours.map((server) => (
          <McpServerCard
            key={server.id}
            server={server}
            mode="mine"
            canManage={status.canManage}
            busy={busy}
            act={act}
            client={client}
          />
        ))}
      </section>
      <AddServerCard client={client} busy={busy} act={act} personal />

      <section className="section settings-card">
        <h3 className="settings-title">Team servers</h3>
        <p className="muted">
          Servers defined here are available to every agent this team runs, on every harness.
          Agents connect through Bento with a token that lives only as long as the run: stored
          keys and sign-ins stay on the server, encrypted.
        </p>
        {teamServers.length === 0 && <p className="muted">No team servers yet.</p>}
        {teamServers.map((server) => (
          <McpServerCard
            key={server.id}
            server={server}
            mode="team"
            canManage={status.canManage}
            busy={busy}
            act={act}
            client={client}
          />
        ))}
        {status.canManage && othersPersonal.length > 0 && (
          <>
            <p className="muted" style={{ marginTop: 16 }}>
              Personal servers your teammates added. You can turn one off or remove it, but only
              its owner sees its credentials.
            </p>
            {othersPersonal.map((server) => (
              <McpServerCard
                key={server.id}
                server={server}
                mode="governance"
                canManage={status.canManage}
                busy={busy}
                act={act}
                client={client}
              />
            ))}
          </>
        )}
      </section>
      {status.canManage && <AddServerCard client={client} busy={busy} act={act} />}
      {/* The other direction: Bento as the MCP server outside agents
          connect to. Beta while the surface settles. */}
      <BetaOnly>
        <McpConnectionsSection client={client} />
      </BetaOnly>
    </>
  );
}

/** Starts an OAuth connect and leaves for the provider's page. */
async function connectTo(
  client: BentoClient,
  act: (fn: () => Promise<unknown>) => Promise<void>,
  serverId: string,
) {
  await act(async () => {
    const { url } = await client.startMcpConnect(serverId);
    window.location.assign(url);
  });
}

/** The scope in one glance: who a server's credential belongs to. */
function ScopeChip({ server }: { server: McpServerStatus }) {
  const label = server.personal ? "personal" : server.credentialScope === "user" ? "each member" : "team";
  return <span className="chip chip-soft">{label}</span>;
}

/**
 * One server row, in the voice of the section it sits in. "mine" is the
 * caller's own to connect and manage; "team" is a shared server admins
 * manage; "governance" is a teammate's personal server an admin can
 * only turn off or remove, never see the credentials of.
 */
function McpServerCard({
  server,
  mode,
  canManage,
  busy,
  act,
  client,
}: {
  server: McpServerStatus;
  mode: "mine" | "team" | "governance";
  canManage: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  client: BentoClient;
}) {
  const toast = useToast();
  const [removing, setRemoving] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  const perMember = server.authType === "oauth" && server.credentialScope === "user";
  // Whether I hold the credential controls for this row.
  const iConnect = mode === "mine";
  const cred = server.personal ? server.userCredential : perMember ? server.userCredential : server.orgCredential;
  const connected = Boolean(cred?.connected);
  const hint = server.personal ? server.userCredential?.hint ?? null : server.orgCredential?.hint ?? null;

  const statusLine = (() => {
    if (mode === "governance") return `Personal server${server.ownerName ? ` from ${server.ownerName}` : ""}.`;
    if (server.authType === "none") return "No sign in needed.";
    if (mode === "team" && !iConnect) {
      // A team server, seen by someone who does not hold its credential.
      if (perMember) return "Each member signs in, under Your servers and sign-ins above.";
      if (server.authType === "api_key")
        return server.orgCredential ? `Key stored for the team: ${server.orgCredential.hint}` : "No key stored yet.";
      return server.orgCredential?.connected
        ? "Connected once for the whole team."
        : "Not connected yet. An owner or admin signs in for the team.";
    }
    // My own to connect (a personal server, or a per-member team server).
    if (server.authType === "api_key")
      return connected ? `Your key is stored: ${hint}` : "No key stored, so your runs do not get this server.";
    return connected ? "Connected." : "Not connected, so your runs do not get this server.";
  })();

  const disconnect = () =>
    server.personal ? client.disconnectMcpUserCredential(server.id) : perMember
      ? client.disconnectMcpUserCredential(server.id)
      : client.disconnectMcpCredential(server.id);

  return (
    <div className="criterion">
      <div className="criterion-cmd">
        <strong>{server.name}</strong> <ScopeChip server={server} />
        {!server.enabled && <span className="chip chip-empty">off</span>}
        <p className="muted">{server.url}</p>
        <p className={!connected && mode !== "governance" && server.authType !== "none" ? "error" : "muted"}>
          {statusLine}
        </p>
        {iConnect && server.authType === "api_key" && (
          <SecretField
            value={keyDraft}
            onChange={setKeyDraft}
            label={`API key for ${server.name}`}
            placeholder={connected ? "Replace your stored key" : "Paste the API key"}
            submitLabel={connected ? "Replace" : "Save"}
            busy={busy}
            onSubmit={() =>
              void act(async () => {
                await client.setMcpApiKey(server.id, keyDraft);
                setKeyDraft("");
                toast.note("The key checked out against the server and is stored encrypted.");
              })
            }
          />
        )}
        {iConnect && server.authType === "oauth" && (
          <div className="actions">
            <button
              className={connected ? "btn" : "btn btn-primary"}
              disabled={busy}
              onClick={() => void connectTo(client, act, server.id)}
            >
              {connected ? "Reconnect" : "Connect"}
            </button>
            {connected && (
              <button className="btn btn-ghost" disabled={busy} onClick={() => void act(disconnect)}>
                Disconnect
              </button>
            )}
          </div>
        )}
      </div>
      {/* Who may enable/disable and remove: the owner of a personal
          server, or an admin of a team or teammate's server. */}
      {(iConnect || canManage) && (
        <div className="actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => void act(() => client.updateMcpServer(server.id, { enabled: !server.enabled }))}
          >
            {server.enabled ? "Disable" : "Enable"}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setRemoving(true)}>
            Remove
          </button>
        </div>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${server.name}?`}
          description="Agents lose this server on their next run, and its stored credentials are deleted."
          confirmLabel="Remove"
          destructive
          onClose={() => setRemoving(false)}
          onConfirm={() => act(() => client.deleteMcpServer(server.id))}
        />
      )}
    </div>
  );
}

/**
 * How a new server authenticates, in the words of the choice a person
 * is actually making. Each maps onto authType and credentialScope; the
 * spelling of those two columns is not something to make people learn.
 */
const CONNECT_CHOICES = [
  // Each member first: it is the default, and the common shape for the
  // SaaS connectors people reach for (Notion, Linear, Drive).
  {
    id: "oauth_user",
    label: "Each member signs in",
    help: "Everyone connects their own account, and a run uses whoever started it.",
    authType: "oauth" as const,
    credentialScope: "user" as const,
  },
  {
    id: "oauth_org",
    label: "Sign in once for the whole team",
    help: "An owner or admin connects an account and every agent on the team uses it.",
    authType: "oauth" as const,
    credentialScope: "org" as const,
  },
  {
    id: "api_key",
    label: "The team shares an API key",
    help: "You paste it once, it is stored encrypted, and every agent on the team uses it.",
    authType: "api_key" as const,
    credentialScope: "org" as const,
  },
  {
    id: "none",
    label: "No sign in",
    help: "The server is open and needs no credential.",
    authType: "none" as const,
    credentialScope: "org" as const,
  },
];

/** The choices for a personal server: always the member's own credential. */
const PERSONAL_CHOICES = [
  {
    id: "oauth_user",
    label: "You sign in",
    help: "Connect your own account; only your runs get this server.",
    authType: "oauth" as const,
    credentialScope: "user" as const,
  },
  {
    id: "api_key",
    label: "You paste an API key",
    help: "Stored encrypted for you, used only on your runs.",
    authType: "api_key" as const,
    credentialScope: "user" as const,
  },
  {
    id: "none",
    label: "No sign in",
    help: "The server is open and needs no credential.",
    authType: "none" as const,
    credentialScope: "user" as const,
  },
];

function AddServerCard({
  client,
  busy,
  act,
  personal = false,
}: {
  client: BentoClient;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  personal?: boolean;
}) {
  const choices = personal ? PERSONAL_CHOICES : CONNECT_CHOICES;
  const [open, setOpen] = useState(!personal);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [choice, setChoice] = useState(choices[0]!.id);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [apiKeyHeader, setApiKeyHeader] = useState("Authorization");

  function deriveSlug(from: string): string {
    return from
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  const picked = choices.find((c) => c.id === choice) ?? choices[0]!;
  const ready = name.trim() && slug.trim() && url.trim();

  // A personal add is offered as a quiet button until opened, so the
  // member's own section does not lead with a form.
  if (personal && !open) {
    return (
      <div className="actions" style={{ marginTop: -4, marginBottom: 12 }}>
        <button className="btn" onClick={() => setOpen(true)}>
          Add your own server
        </button>
      </div>
    );
  }

  return (
    <section className="section settings-card">
      <h3 className="settings-title">{personal ? "Add your own server" : "Add a team server"}</h3>
      <p className="muted">
        {personal
          ? "A server only your runs get. A name, the URL, and how you connect."
          : "A name, the server's URL, and who connects. That is the whole setup; agents pick the server up on their next run."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          void act(async () => {
            await client.createMcpServer({
              name: name.trim(),
              slug,
              url: url.trim(),
              transport,
              authType: picked.authType,
              credentialScope: picked.credentialScope,
              personal,
              ...(apiKeyHeader.trim() && apiKeyHeader !== "Authorization"
                ? { apiKeyHeader: apiKeyHeader.trim() }
                : {}),
            });
            setName("");
            setSlug("");
            setSlugTouched(false);
            setUrl("");
            setChoice(choices[0]!.id);
            setTransport("http");
            setApiKeyHeader("Authorization");
            if (personal) setOpen(false);
          });
        }}
      >
        <div className="actions">
          <input
            className="input"
            placeholder="Name, like Notion or Sentry"
            aria-label="Server name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(deriveSlug(e.target.value));
            }}
          />
          <input
            className="input"
            placeholder="https://example.com/mcp"
            aria-label="Server URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <fieldset className="mcp-choices">
          <legend className="muted">{personal ? "How you connect" : "Who connects"}</legend>
          {choices.map((c) => (
            <label key={c.id} className="mcp-choice">
              <input
                type="radio"
                name={personal ? "mcp-personal-connect" : "mcp-connect"}
                checked={choice === c.id}
                disabled={busy}
                onChange={() => setChoice(c.id)}
              />
              <span>
                <strong>{c.label}</strong>
                <span className="muted"> {c.help}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <details className="mcp-advanced">
          <summary>Advanced</summary>
          <div className="actions">
            <input
              className="input"
              placeholder="tool name (slug)"
              aria-label="Tool name agents see"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(deriveSlug(e.target.value));
              }}
            />
            <select
              className="input"
              aria-label="Transport"
              value={transport}
              onChange={(e) => setTransport(e.target.value as "http" | "sse")}
            >
              <option value="http">Streamable HTTP</option>
              <option value="sse">SSE (older servers)</option>
            </select>
            {picked.authType === "api_key" && (
              <input
                className="input"
                placeholder="Header, normally Authorization"
                aria-label="API key header"
                value={apiKeyHeader}
                onChange={(e) => setApiKeyHeader(e.target.value)}
              />
            )}
          </div>
        </details>
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
            Add server
          </button>
        </div>
      </form>
    </section>
  );
}

const OUTCOMES: Record<string, string> = {
  connected: "MCP server connected.",
  invalid: "That connection link had expired. Start it again.",
  organization: "You switched organizations part way through. Switch back and connect again.",
  denied: "You are not allowed to connect this server.",
  unconfigured: "This server has no signing key configured.",
  failed: "The sign in did not complete. Try again.",
};

function useMcpOutcome(): void {
  const toast = useToast();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("mcp");
    if (!result) return;
    const message = OUTCOMES[result];
    if (message) {
      if (result === "connected") toast.note(message);
      else toast.fail(message);
    }
    params.delete("mcp");
    const query = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [toast]);
}
