import { useCallback, useEffect, useState } from "react";
import type { BentoClient, McpConnection, McpConnectionCreated, McpConnectionList, Project } from "@bento/api-client";
import { ConfirmDialog } from "./PromptDialog.js";
import { Modal } from "./Modal.js";
import { SettingsCardSkeleton } from "./Skeleton.js";
import { useToast } from "./Toasts.js";

/**
 * Inbound MCP connections: tokens outside agents present to Bento's own
 * MCP server to create cards and follow their progress. The section is
 * the mirror of the rest of the MCP tab, which is Bento consuming other
 * people's servers.
 *
 * The one design rule worth stating: the raw token exists in exactly
 * one render, the dialog after a create. Rows only ever show the masked
 * tail, because the server only keeps the hash.
 */
export function McpConnectionsSection({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [status, setStatus] = useState<McpConnectionList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<McpConnectionCreated | null>(null);

  const reload = useCallback(async () => {
    try {
      setStatus(await client.listMcpConnections());
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

  // 404 means the flag is off for this account or the server predates
  // the feature; either way the section has nothing to say.
  if (loadFailed || status === null) {
    return loadFailed ? null : <SettingsCardSkeleton rows={1} />;
  }

  const endpoint = `${window.location.origin}/api/mcp-server`;

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Connect an agent to Bento</h3>
      <p className="muted">
        Bento is itself an MCP server. An outside agent (Claude Code, Cursor, anything that speaks
        MCP) can connect with a token from here, create feature cards, and follow their progress.
        The token stays valid until you disconnect it; you do not need to sign in again on a
        schedule. Point the agent at <code>{endpoint}</code> with the token as a bearer
        Authorization header.
      </p>
      {status.connections.length === 0 && <p className="muted">No connections yet.</p>}
      {status.connections.map((connection) => (
        <ConnectionCard key={connection.id} connection={connection} busy={busy} act={act} client={client} />
      ))}
      <AddConnectionCard client={client} busy={busy} act={act} onCreated={setCreated} />
      {created && <TokenDialog created={created} endpoint={endpoint} onClose={() => setCreated(null)} />}
    </section>
  );
}

function ConnectionCard({
  connection,
  busy,
  act,
  client,
}: {
  connection: McpConnection;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  client: BentoClient;
}) {
  const [removing, setRemoving] = useState(false);
  const reach =
    connection.scope === "organization"
      ? "the whole team"
      : connection.projects.length === 0
        ? "no projects"
        : connection.projects.map((p) => p.name ?? "a removed project").join(", ");
  return (
    <div className="criterion">
      <div className="criterion-cmd">
        <strong>{connection.name}</strong>{" "}
        <span className="chip chip-soft">{connection.scope === "organization" ? "team" : "projects"}</span>
        <p className="muted">
          Token {connection.tokenHint || "stored"} · reaches {reach}
          {connection.ownerName ? ` · created by ${connection.ownerName}` : ""}
        </p>
        <p className="muted">
          {connection.lastUsedAt
            ? `Last used ${new Date(connection.lastUsedAt).toLocaleString()}, ${connection.requestCount} requests.`
            : "Never used yet."}
        </p>
      </div>
      <div className="actions">
        <button className="btn btn-ghost" disabled={busy} onClick={() => setRemoving(true)}>
          Disconnect
        </button>
      </div>
      {removing && (
        <ConfirmDialog
          title={`Disconnect ${connection.name}?`}
          description="The agent holding this token loses access immediately. This cannot be undone; a new connection mints a new token."
          confirmLabel="Disconnect"
          destructive
          onClose={() => setRemoving(false)}
          onConfirm={() => act(() => client.deleteMcpConnection(connection.id))}
        />
      )}
    </div>
  );
}

function AddConnectionCard({
  client,
  busy,
  act,
  onCreated,
}: {
  client: BentoClient;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  onCreated: (created: McpConnectionCreated) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"organization" | "projects">("organization");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open || projects !== null) return;
    void client
      .listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [open, projects, client]);

  if (!open) {
    return (
      <div className="actions" style={{ marginTop: 4 }}>
        <button className="btn" onClick={() => setOpen(true)}>
          New connection
        </button>
      </div>
    );
  }

  const ready = name.trim() && (scope === "organization" || picked.size > 0);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void act(async () => {
          const created = await client.createMcpConnection({
            name: name.trim(),
            scope,
            ...(scope === "projects" ? { projectIds: [...picked] } : {}),
          });
          setName("");
          setScope("organization");
          setPicked(new Set());
          setOpen(false);
          onCreated(created);
        });
      }}
    >
      <div className="actions">
        <input
          className="input"
          placeholder="Name, like Claude Code on my laptop"
          aria-label="Connection name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <fieldset className="mcp-choices">
        <legend className="muted">What the agent can reach</legend>
        <label className="mcp-choice">
          <input
            type="radio"
            name="mcp-connection-scope"
            checked={scope === "organization"}
            disabled={busy}
            onChange={() => setScope("organization")}
          />
          <span>
            <strong>The whole team</strong>
            <span className="muted"> Every project, including ones created later.</span>
          </span>
        </label>
        <label className="mcp-choice">
          <input
            type="radio"
            name="mcp-connection-scope"
            checked={scope === "projects"}
            disabled={busy}
            onChange={() => setScope("projects")}
          />
          <span>
            <strong>Selected projects</strong>
            <span className="muted"> Only the projects picked below, one or several.</span>
          </span>
        </label>
      </fieldset>
      {scope === "projects" && (
        <fieldset className="mcp-choices">
          <legend className="muted">Projects</legend>
          {projects === null && <p className="muted">Loading projects…</p>}
          {projects !== null && projects.length === 0 && (
            <p className="muted">No projects yet. Create one first.</p>
          )}
          {(projects ?? []).map((project) => (
            <label key={project.id} className="mcp-choice">
              <input
                type="checkbox"
                checked={picked.has(project.id)}
                disabled={busy}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(project.id);
                  else next.delete(project.id);
                  setPicked(next);
                }}
              />
              <span>{project.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
          Create connection
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The one render the raw token ever gets. */
function TokenDialog({
  created,
  endpoint,
  onClose,
}: {
  created: McpConnectionCreated;
  endpoint: string;
  onClose: () => void;
}) {
  const toast = useToast();
  return (
    <Modal
      title={`${created.name} is ready`}
      description="Copy the token now. It is stored hashed, so it cannot be shown again. It stays valid until you disconnect this connection; a lost token means disconnecting and creating a new one."
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void navigator.clipboard
                .writeText(created.token)
                .then(() => toast.note("Token copied."))
                .catch(() => toast.note("Could not copy; select the token and copy it by hand."));
            }}
          >
            Copy token
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p>
        <code style={{ wordBreak: "break-all", userSelect: "all" }}>{created.token}</code>
      </p>
      <p className="muted">
        Server URL: <code>{endpoint}</code>. Send the token as{" "}
        <code>Authorization: Bearer …</code>, for example:
      </p>
      <pre className="muted" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {`claude mcp add --transport http bento ${endpoint} --header "Authorization: Bearer ${created.token}"`}
      </pre>
    </Modal>
  );
}
