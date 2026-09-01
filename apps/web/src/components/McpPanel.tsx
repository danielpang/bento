import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { BentoClient, McpCatalogEntry, McpServerStatus, McpStatus } from "@bento/api-client";
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
 *
 * Local mode shows only the first of those. There is one user and no
 * team there, so a registry described as shared with teammates reads as
 * a second, mysterious kind of server rather than as a distinction that
 * means anything.
 */
export function McpPanel({ client, mode }: { client: BentoClient; mode: "local" | "multi" }) {
  const toast = useToast();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The by-URL forms are opened from triggers that live in other cards.
  const [customOpen, setCustomOpen] = useState(false);
  const [teamCustomOpen, setTeamCustomOpen] = useState(false);

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
        <h3 className="settings-title">Existing connections</h3>
        <p className="muted">
          {mode === "local"
            ? "Servers your runs get, with the credentials you connect here. Every run you start uses them."
            : "Servers only your runs get, and the team servers that ask you to sign in with your own account. A run you start uses your connections; nothing here is shared with the team."}
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
      <ConnectionCatalog
        client={client}
        busy={busy}
        act={act}
        onAddCustom={() => setCustomOpen((was) => !was)}
        customOpen={customOpen}
        customForm={
          <AddServerCard
            client={client}
            busy={busy}
            act={act}
            personal
            bare
            open={customOpen}
            onOpenChange={setCustomOpen}
          />
        }
      />

      {mode === "multi" && (
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
        {status.canManage && (
          <div className="actions">
            <button className="btn btn-ghost" onClick={() => setTeamCustomOpen(true)}>
              Custom MCP
            </button>
          </div>
        )}
      </section>
      )}
      {mode === "multi" && status.canManage && (
        <AddServerCard
          client={client}
          busy={busy}
          act={act}
          open={teamCustomOpen}
          onOpenChange={setTeamCustomOpen}
        />
      )}
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

/**
 * A saved server's icon, from the same allow-listed route the catalog
 * uses. A server added by URL rather than from the catalog is not on
 * that list, so the request 404s and the monogram takes over, which is
 * the same fallback a catalog entry without an icon gets.
 */
function iconUrlFor(url: string): string | null {
  try {
    return `/api/mcp/catalog/icon/${encodeURIComponent(new URL(url).hostname.toLowerCase())}`;
  } catch {
    return null;
  }
}

/**
 * Connection health in the colour the rest of the console uses: green
 * when a run would get this server, red when it is on but waiting for
 * the one person who can connect it. A server switched off is grey
 * rather than red, because nothing is wrong with it.
 */
function connectionDot(args: {
  enabled: boolean;
  authType: "none" | "api_key" | "oauth";
  connected: boolean;
  needsMe: boolean;
}): "succeeded" | "failed" | "cancelled" | undefined {
  if (!args.enabled) return "cancelled";
  if (args.authType === "none" || args.connected) return "succeeded";
  if (args.needsMe) return "failed";
  return undefined;
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
  /**
   * Red only where this viewer has something to do on this row. A team
   * card for a per-member server is telling you where the sign in lives,
   * not reporting a fault: it turns red in Your servers, where the
   * member can act, and stays quiet here.
   */
  const needsMe =
    !connected &&
    server.authType !== "none" &&
    (iConnect || (mode === "team" && !perMember));
  const hint = server.personal ? server.userCredential?.hint ?? null : server.orgCredential?.hint ?? null;
  const dot = connectionDot({ enabled: server.enabled, authType: server.authType, connected, needsMe });

  const statusLine: string | null = (() => {
    if (mode === "governance") return `Personal server${server.ownerName ? ` from ${server.ownerName}` : ""}.`;
    if (server.authType === "none") return "No sign in needed.";
    if (mode === "team" && !iConnect) {
      // A team server, seen by someone who does not hold its credential.
      if (perMember) return "Each member signs in, under Existing connections above.";
      if (server.authType === "api_key")
        return server.orgCredential ? `Key stored for the team: ${server.orgCredential.hint}` : "No key stored yet.";
      return server.orgCredential?.connected
        ? "Connected once for the whole team."
        : "Not connected yet. An owner or admin signs in for the team.";
    }
    // My own to connect (a personal server, or a per-member team server).
    if (server.authType === "api_key")
      return connected ? `Your key is stored: ${hint}` : "No key stored, so your runs do not get this server.";
    return connected ? null : "Not connected";
  })();

  return (
    <div className="criterion">
      <div className="criterion-cmd">
        <span className="mcp-entry-head">
          {statusLine === null ? (
            <span className="dot" data-state={dot} role="img" aria-label="Connected" />
          ) : (
            <span className="dot" data-state={dot} aria-hidden="true" />
          )}
          <ServiceMark iconUrl={iconUrlFor(server.url)} title={server.name} />
          <strong>{server.name}</strong>
          <ScopeChip server={server} />
          {!server.enabled && <span className="chip chip-empty">off</span>}
        </span>
        <p className="muted">{server.url}</p>
        {statusLine !== null && <p className={needsMe ? "error" : "muted"}>{statusLine}</p>}
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
      </div>
      {/* One row, one place to look. Connecting is the viewer's own
          action; enable/disable and remove belong to the owner of a
          personal server or an admin of a team or teammate's. Remove
          deletes the stored credential too, so it is also the way to
          disconnect: two buttons for that was the thing nobody could
          tell apart. */}
      {(iConnect || canManage) && (
        <div className="actions">
          {iConnect && server.authType === "oauth" && (
            <button
              className={connected ? "btn" : "btn btn-primary"}
              disabled={busy}
              onClick={() => void connectTo(client, act, server.id)}
            >
              {connected ? "Reconnect" : "Connect"}
            </button>
          )}
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
          description="This disconnects it and deletes its stored credentials. Agents lose the server on their next run."
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
/** One "who connects" option, shared by the team and personal sets. */
interface ConnectChoice {
  id: string;
  label: string;
  help: string;
  authType: "none" | "api_key" | "oauth";
  credentialScope: "org" | "user";
}

const CONNECT_CHOICES: ConnectChoice[] = [
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

/**
 * Mirrors CATALOG_CATEGORIES on the server. Held here as an order, not
 * as truth: a pill only appears when the list in hand has an entry in
 * that category, so a name that disappears server side simply stops
 * being offered.
 */
const CATEGORIES = ["Analytics", "Dev tools", "Data", "Design", "Docs", "Project", "Payments"];

/** The choices for a personal server: always the member's own credential. */
const PERSONAL_CHOICES: ConnectChoice[] = [
  {
    id: "oauth_user",
    label: "Sign in",
    help: "Connect your own account; only your runs get this server.",
    authType: "oauth" as const,
    credentialScope: "user" as const,
  },
  {
    id: "api_key",
    label: "API key",
    help: "Stored encrypted for you, used only on your runs.",
    authType: "api_key" as const,
    credentialScope: "user" as const,
  },
  {
    id: "none",
    label: "No auth",
    help: "The server is open and needs no credential.",
    authType: "none" as const,
    credentialScope: "user" as const,
  },
];

/**
 * The browsable list of connections, from the public MCP registry.
 *
 * This leads the page: picking Notion from a list is the job, and
 * typing a URL is the fallback for a server no registry carries. An
 * entry fills in everything mechanical (name, URL, transport, tool
 * name), so the only decision left is who connects.
 */
function ConnectionCatalog({
  client,
  busy,
  act,
  onAddCustom,
  customOpen,
  customForm,
}: {
  client: BentoClient;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  onAddCustom: () => void;
  /** True while the by-URL form has taken the card over. */
  customOpen: boolean;
  customForm: ReactNode;
}) {
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null);
  const [reachable, setReachable] = useState(true);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  /** Null is "All": every entry, mapped or not. */
  const [category, setCategory] = useState<string | null>(null);

  const shown = (entries ?? []).filter((entry) => category === null || entry.category === category);

  const load = useCallback(async () => {
    try {
      const res = await client.mcpCatalog(search);
      setEntries(res.entries);
      setReachable(res.reachable);
    } catch {
      setEntries([]);
      setReachable(false);
    }
  }, [client, search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="section settings-card">
      <h3 className="settings-title">Add a connection</h3>
      {!customOpen && (
        <p className="muted">
          Servers published to the{" "}
          <a href="https://registry.modelcontextprotocol.io/" target="_blank" rel="noreferrer">
            public MCP registry
          </a>
          .
        </p>
      )}
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query.trim());
        }}
      >
        {!customOpen && (
          <>
            <input
              className="input"
              placeholder="Search connections, like Notion or Sentry"
              aria-label="Search connections"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="btn" type="submit" disabled={busy}>
              Search
            </button>
          </>
        )}
        {/* The answer to a search that found nothing, offered where the
            search happens rather than in a card further down. It takes
            the card over, because browsing and typing a URL are two
            answers to the same question and only one is in play. */}
        <button
          className="btn btn-ghost"
          type="button"
          onClick={onAddCustom}
          aria-expanded={customOpen}
        >
          {customOpen ? (
            <>
              <span aria-hidden="true">←</span> Browse the registry
            </>
          ) : (
            "Custom MCP"
          )}
        </button>
      </form>

      {!customOpen && (
        <div className="pill-row" role="group" aria-label="Filter by category">
          <button
            type="button"
            className="pill"
            data-on={category === null || undefined}
            aria-pressed={category === null}
            onClick={() => setCategory(null)}
          >
            All
          </button>
          {/* Only categories something in this list actually has: a pill
              that filters to nothing is a dead end, and a search can
              return entries from any of them or none. */}
          {CATEGORIES.filter((name) => (entries ?? []).some((entry) => entry.category === name)).map(
            (name) => (
              <button
                key={name}
                type="button"
                className="pill"
                data-on={category === name || undefined}
                aria-pressed={category === name}
                onClick={() => setCategory(category === name ? null : name)}
              >
                {name}
              </button>
            ),
          )}
        </div>
      )}

      {customOpen && customForm}

      {!customOpen && entries === null && <p className="muted">Loading connections.</p>}
      {!customOpen && entries !== null && !reachable && (
        <p className="muted">
          The connection registry could not be reached, so there is nothing to browse right now.
          You can still add a server by URL with Custom MCP.
        </p>
      )}
      {!customOpen && entries !== null && reachable && entries.length === 0 && (
        <p className="muted">No connections match that search.</p>
      )}

      {(customOpen ? [] : shown).map((entry) => (
        <div className="criterion" key={entry.name}>
          <div className="criterion-cmd">
            <span className="mcp-entry-head">
              <ServiceMark iconUrl={entry.iconUrl} title={entry.title} />
              <strong>{entry.title}</strong>
              {entry.featured && <span className="chip">featured</span>}
              <span className="chip chip-soft">{entry.publisher}</span>
              {entry.added && <span className="chip">added</span>}
            </span>
            {entry.description && <p className="muted">{entry.description}</p>}
          </div>
          <div className="actions">
            <button
              className={entry.added ? "btn btn-primary icon-button" : "btn btn-primary"}
              disabled={busy || entry.added}
              // An icon alone names nothing, and this one replaces the
              // only label the button had.
              {...(entry.added ? { title: `${entry.title} added`, "aria-label": `${entry.title} added` } : {})}
              onClick={() =>
                void act(async () => {
                  // No questions: a catalog server is yours, and Bento
                  // asks the server itself how it authenticates.
                  await client.createMcpServer({
                    name: entry.title.slice(0, 120),
                    slug: entry.slug,
                    url: entry.url,
                    transport: entry.transport,
                    personal: true,
                  });
                  await load();
                })
              }
            >
              {entry.added ? (
                <svg
                  className="check-mark"
                  viewBox="0 0 16 16"
                  width="14"
                  height="14"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M3.5 8.5l3 3 6-7.5" />
                </svg>
              ) : (
                "Add"
              )}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * The service's own mark, served from Bento's origin, falling back to a
 * monogram. A list of logos is scannable in a way a list of reverse-DNS
 * names is not, and the fallback keeps the row aligned when a service
 * publishes no icon.
 */
function ServiceMark({ iconUrl, title }: { iconUrl: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  const letter = (title.trim()[0] ?? "?").toUpperCase();
  if (!iconUrl || failed) {
    return (
      <span className="mcp-mark mcp-mark-letter" aria-hidden="true">
        {letter}
      </span>
    );
  }
  return (
    <img
      className="mcp-mark"
      src={iconUrl}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function AddServerCard({
  client,
  busy,
  act,
  personal = false,
  open,
  onOpenChange,
  bare = false,
}: {
  client: BentoClient;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  personal?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rendered inside another card, so it brings no section of its own. */
  bare?: boolean;
}) {
  const choices = personal ? PERSONAL_CHOICES : CONNECT_CHOICES;
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

  // The trigger belongs where the choice is made, next to the search
  // that failed to find the server. The parent owns it, so this is only
  // the form.
  if (!open) return null;

  const Wrapper = bare ? "div" : "section";
  return (
    <Wrapper className={bare ? undefined : "section settings-card"}>
      {!bare && (
        <h3 className="settings-title">{personal ? "Add your own server" : "Add a team server"}</h3>
      )}
      {!personal && (
        <p className="muted">
          A name, the server&apos;s URL, and who connects. That is the whole setup; agents pick the
          server up on their next run.
        </p>
      )}
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
            if (personal) onOpenChange(false);
          });
        }}
      >
        <div className="field-row">
          <label className="field">
            <span className="label">Name</span>
            <input
              className="input"
              placeholder="Notion, Sentry"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(deriveSlug(e.target.value));
              }}
            />
          </label>
          <label className="field">
            <span className="label">URL</span>
            <input
              className="input"
              placeholder="https://example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
        </div>
        <fieldset className="mcp-choices">
          <legend className="label">{personal ? "Auth" : "Who connects"}</legend>
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
                {!personal && <span className="muted"> {c.help}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <details className="mcp-advanced">
          <summary>Advanced</summary>
          <div className="field-row">
            <label className="field">
              <span className="label">Tool name</span>
              <input
                className="input"
                placeholder="the name agents see"
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(deriveSlug(e.target.value));
                }}
              />
            </label>
            <label className="field">
              <span className="label">Transport</span>
              <select
                className="input"
                value={transport}
                onChange={(e) => setTransport(e.target.value as "http" | "sse")}
              >
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE (older servers)</option>
              </select>
            </label>
            {picked.authType === "api_key" && (
              <label className="field">
                <span className="label">Header</span>
                <input
                  className="input"
                  placeholder="normally Authorization"
                  value={apiKeyHeader}
                  onChange={(e) => setApiKeyHeader(e.target.value)}
                />
              </label>
            )}
          </div>
        </details>
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
            Add server
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
        </div>
      </form>
    </Wrapper>
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
