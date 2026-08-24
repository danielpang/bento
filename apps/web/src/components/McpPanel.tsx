import { useCallback, useEffect, useState } from "react";
import type { BentoClient, McpServerStatus, McpStatus } from "@bento/api-client";
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

  const personal = status.servers.filter((s) => s.enabled && s.userCredential !== null);

  return (
    <>
      {personal.length > 0 && (
        <section className="section settings-card">
          <h3 className="settings-title">Your connections</h3>
          <p className="muted">
            These servers ask each person to sign in with their own account. Runs you start use
            your connections; a server you have not connected simply is not available to them.
          </p>
          {personal.map((server) => (
            <div className="criterion" key={server.id}>
              <div className="criterion-cmd">
                <strong>{server.name}</strong>
                <p className={server.userCredential?.connected ? "muted" : "error"}>
                  {server.userCredential?.connected ? "Connected." : "Not connected."}
                </p>
              </div>
              <div className="actions">
                {server.userCredential?.connected ? (
                  <>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => void connectTo(client, act, server.id)}
                    >
                      Reconnect
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => void act(() => client.disconnectMcpUserCredential(server.id))}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void connectTo(client, act, server.id)}
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="section settings-card">
        <h3 className="settings-title">Team servers</h3>
        <p className="muted">
          Servers defined here are available to every agent this team runs, on every harness.
          Agents connect through Bento with a token that lives only as long as the run: stored
          keys and sign-ins stay on the server, encrypted.
        </p>
        {status.servers.length === 0 && <p className="muted">No MCP servers yet.</p>}
        {status.servers.map((server) => (
          <McpServerCard
            key={server.id}
            server={server}
            canManage={status.canManage}
            busy={busy}
            act={act}
            client={client}
          />
        ))}
      </section>
      {status.canManage && <AddServerCard client={client} busy={busy} act={act} />}
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
  const perMember = server.authType === "oauth" && server.credentialScope === "user";
  return <span className="chip chip-soft">{perMember ? "each member" : "team"}</span>;
}

function McpServerCard({
  server,
  canManage,
  busy,
  act,
  client,
}: {
  server: McpServerStatus;
  canManage: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  client: BentoClient;
}) {
  const toast = useToast();
  const [removing, setRemoving] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");

  const perMember = server.authType === "oauth" && server.credentialScope === "user";
  const missing =
    (server.authType === "api_key" && !server.orgCredential) ||
    (server.authType === "oauth" && !perMember && !server.orgCredential?.connected);
  const statusLine = perMember
    ? "Each member signs in with their own account, under Your connections above."
    : server.authType === "none"
      ? "No sign in needed."
      : server.authType === "api_key"
        ? server.orgCredential
          ? `Key stored for the team: ${server.orgCredential.hint}`
          : "No key stored yet, so agents do not get this server."
        : server.orgCredential?.connected
          ? "Connected once for the whole team."
          : "Not connected yet. An owner or admin signs in once for the team.";

  return (
    <div className="criterion">
      <div className="criterion-cmd">
        <strong>{server.name}</strong> <ScopeChip server={server} />
        {!server.enabled && <span className="chip chip-empty">off</span>}
        <p className="muted">{server.url}</p>
        <p className={missing ? "error" : "muted"}>{statusLine}</p>
        {canManage && server.authType === "api_key" && (
          <SecretField
            value={keyDraft}
            onChange={setKeyDraft}
            label={`API key for ${server.name}`}
            placeholder={server.orgCredential ? "Replace the stored key" : "Paste the API key"}
            submitLabel={server.orgCredential ? "Replace" : "Save"}
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
        {canManage && server.authType === "oauth" && !perMember && (
          <div className="actions">
            <button
              className={server.orgCredential?.connected ? "btn" : "btn btn-primary"}
              disabled={busy}
              onClick={() => void connectTo(client, act, server.id)}
            >
              {server.orgCredential?.connected ? "Reconnect" : "Connect"}
            </button>
            {server.orgCredential?.connected && (
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void act(() => client.disconnectMcpCredential(server.id))}
              >
                Disconnect
              </button>
            )}
          </div>
        )}
      </div>
      {canManage && (
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
  {
    id: "api_key",
    label: "The team shares an API key",
    help: "You paste it once, it is stored encrypted, and every agent on the team uses it.",
    authType: "api_key" as const,
    credentialScope: "org" as const,
  },
  {
    id: "oauth_org",
    label: "Sign in once for the whole team",
    help: "An owner or admin connects an account and every agent on the team uses it.",
    authType: "oauth" as const,
    credentialScope: "org" as const,
  },
  {
    id: "oauth_user",
    label: "Each member signs in",
    help: "Everyone connects their own account, and a run uses whoever started it.",
    authType: "oauth" as const,
    credentialScope: "user" as const,
  },
  {
    id: "none",
    label: "No sign in",
    help: "The server is open and needs no credential.",
    authType: "none" as const,
    credentialScope: "org" as const,
  },
];

function AddServerCard({
  client,
  busy,
  act,
}: {
  client: BentoClient;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [choice, setChoice] = useState("api_key");
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

  const picked = CONNECT_CHOICES.find((c) => c.id === choice) ?? CONNECT_CHOICES[0]!;
  const ready = name.trim() && slug.trim() && url.trim();

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Add a server</h3>
      <p className="muted">
        A name, the server's URL, and who connects. That is the whole setup; agents pick the
        server up on their next run.
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
              ...(apiKeyHeader.trim() && apiKeyHeader !== "Authorization"
                ? { apiKeyHeader: apiKeyHeader.trim() }
                : {}),
            });
            setName("");
            setSlug("");
            setSlugTouched(false);
            setUrl("");
            setChoice("api_key");
            setTransport("http");
            setApiKeyHeader("Authorization");
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
          <legend className="muted">Who connects</legend>
          {CONNECT_CHOICES.map((c) => (
            <label key={c.id} className="mcp-choice">
              <input
                type="radio"
                name="mcp-connect"
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
