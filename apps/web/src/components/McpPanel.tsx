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

  return (
    <>
      <section className="section settings-card">
        <h3 className="settings-title">MCP servers</h3>
        <p className="muted">
          Servers defined here are available to every agent this organization runs, on every
          harness. Agents connect through Bento with a token that lives only as long as the
          run: stored keys stay on the server, encrypted.
        </p>
        {status.servers.length === 0 && (
          <p className="muted">No MCP servers yet.</p>
        )}
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

  const authLabel =
    server.authType === "none"
      ? "no auth"
      : server.authType === "api_key"
        ? "API key"
        : server.credentialScope === "user"
          ? "sign in, per member"
          : "sign in, org wide";

  return (
    <div className="criterion">
      <div className="criterion-cmd">
        <strong>{server.name}</strong>{" "}
        <span className="muted">
          {server.url} ({server.transport}, {authLabel})
          {!server.enabled && " , disabled"}
        </span>
        {server.authType === "api_key" && (
          <p className="muted">
            {server.orgCredential
              ? `Key stored: ${server.orgCredential.hint}`
              : "No key stored yet, so this server is not attached to runs."}
          </p>
        )}
        {server.authType === "oauth" && server.credentialScope === "org" && (
          <p className="muted">
            {server.orgCredential?.connected
              ? "Connected for the whole organization."
              : "Not connected. An owner or admin signs in once for the organization."}
          </p>
        )}
        {server.authType === "oauth" && server.credentialScope === "user" && (
          <p className={server.userCredential?.connected ? "muted" : "error"}>
            {server.userCredential?.connected
              ? "You have connected this server."
              : `You have not connected ${server.name}, so it is not available to your runs.`}
          </p>
        )}
        {server.authType === "oauth" && oauthCanConnect(server, canManage) && (
          <div className="actions">
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const { url } = await client.startMcpConnect(server.id);
                  window.location.assign(url);
                })
              }
            >
              {oauthConnected(server) ? "Reconnect" : "Connect"}
            </button>
            {oauthConnected(server) && (
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    server.credentialScope === "user"
                      ? client.disconnectMcpUserCredential(server.id)
                      : client.disconnectMcpCredential(server.id),
                  )
                }
              >
                Disconnect
              </button>
            )}
          </div>
        )}
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
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [authType, setAuthType] = useState<"none" | "api_key" | "oauth">("api_key");
  const [credentialScope, setCredentialScope] = useState<"org" | "user">("org");

  function deriveSlug(from: string): string {
    return from
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  const ready = name.trim() && slug.trim() && url.trim();

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Add a server</h3>
      <p className="muted">
        Remote MCP servers only: a URL the server can reach. The slug is the tool name agents
        see.
      </p>
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          void act(async () => {
            await client.createMcpServer({
              name: name.trim(),
              slug,
              url: url.trim(),
              transport,
              authType,
              ...(authType === "oauth" ? { credentialScope } : {}),
            });
            setName("");
            setSlug("");
            setSlugTouched(false);
            setUrl("");
          });
        }}
      >
        <input
          className="input"
          placeholder="Name"
          aria-label="Server name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(deriveSlug(e.target.value));
          }}
        />
        <input
          className="input"
          placeholder="slug"
          aria-label="Server slug"
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(deriveSlug(e.target.value));
          }}
        />
        <input
          className="input"
          placeholder="https://example.com/mcp"
          aria-label="Server URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <select
          className="input"
          aria-label="Transport"
          value={transport}
          onChange={(e) => setTransport(e.target.value as "http" | "sse")}
        >
          <option value="http">Streamable HTTP</option>
          <option value="sse">SSE</option>
        </select>
        <select
          className="input"
          aria-label="Authentication"
          value={authType}
          onChange={(e) => setAuthType(e.target.value as "none" | "api_key" | "oauth")}
        >
          <option value="api_key">API key</option>
          <option value="oauth">Sign in (OAuth)</option>
          <option value="none">No auth</option>
        </select>
        {authType === "oauth" && (
          <select
            className="input"
            aria-label="Who signs in"
            value={credentialScope}
            onChange={(e) => setCredentialScope(e.target.value as "org" | "user")}
          >
            <option value="org">One sign in for the organization</option>
            <option value="user">Each member signs in</option>
          </select>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
          Add server
        </button>
      </form>
    </section>
  );
}

/** True when this OAuth server already has the credential it needs. */
function oauthConnected(server: McpServerStatus): boolean {
  return server.credentialScope === "user"
    ? Boolean(server.userCredential?.connected)
    : Boolean(server.orgCredential?.connected);
}

/** Whether the viewer may start a connect: any member for a per-user server, admins for org. */
function oauthCanConnect(server: McpServerStatus, canManage: boolean): boolean {
  return server.credentialScope === "user" || canManage;
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
