import { useEffect, useState } from "react";
import type { BentoClient, McpOAuthConsent, Project } from "@bento/api-client";
import { useSession } from "../auth-client.js";
import { BrandLockup } from "./BrandLockup.js";
import { SignIn } from "./SignIn.js";
import { CenteredPanelSkeleton } from "./Skeleton.js";

/**
 * OAuth consent for connecting Claude, Cursor, or another MCP host to
 * Bento. The host opens /mcp, we 401 it into this page, and Allow
 * redirects it back with an authorization code.
 */
export function McpAuthorize({ client }: { client: BentoClient }) {
  const requestId = new URLSearchParams(window.location.search).get("request") ?? "";
  const { data: session, isPending } = useSession();
  const [mode, setMode] = useState<"local" | "multi" | "unknown">("unknown");
  const [consent, setConsent] = useState<McpOAuthConsent | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [scope, setScope] = useState<"organization" | "projects">("organization");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  const callbackURL = `/connect-mcp?request=${encodeURIComponent(requestId)}`;

  useEffect(() => {
    void client
      .health()
      .then((h) => setMode(h.mode === "multi" ? "multi" : "local"))
      .catch(() => setMode("local"));
  }, [client]);

  useEffect(() => {
    if (!requestId) {
      setMissing(true);
      return;
    }
    if (mode === "unknown") return;
    if (mode === "multi" && (isPending || !session)) return;
    let cancelled = false;
    void client
      .mcpOAuthConsent(requestId)
      .then((row) => {
        if (!cancelled) setConsent(row);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, requestId, mode, isPending, session]);

  useEffect(() => {
    if (!consent || projects !== null) return;
    void client
      .listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [client, consent, projects]);

  async function decide(allow: boolean) {
    if (!requestId) return;
    setBusy(true);
    setError("");
    try {
      const result = allow
        ? await client.approveMcpOAuthConsent({
            request: requestId,
            scope,
            ...(scope === "projects" ? { projectIds: [...picked] } : {}),
          })
        : await client.denyMcpOAuthConsent(requestId);
      window.location.assign(result.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish connecting.");
      setBusy(false);
    }
  }

  if (mode === "unknown" || (mode === "multi" && isPending)) return <CenteredPanelSkeleton />;
  if (mode === "multi" && !session) {
    return <SignIn callbackURL={callbackURL} note="Sign in to connect this app to Bento." />;
  }
  if (missing || !requestId) {
    return (
      <div className="center">
        <div className="card-panel">
          <div className="auth-head">
            <BrandLockup size="lg" />
            <h1>Connect to Bento</h1>
          </div>
          <p className="muted">This sign-in request is not valid. It may have expired, so start again from Claude or Cursor.</p>
        </div>
      </div>
    );
  }
  if (!consent) return <CenteredPanelSkeleton />;

  const ready = scope === "organization" || picked.size > 0;
  let redirectHost = consent.redirectUri;
  try {
    redirectHost = new URL(consent.redirectUri).host || consent.redirectUri;
  } catch {
    // Custom schemes have no host worth showing.
  }

  return (
    <div className="center">
      <div className="card-panel">
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>Connect {consent.clientName}</h1>
        </div>
        {error && <p className="error">{error}</p>}
        <p className="muted">
          {consent.clientName} wants to create feature cards in Bento and follow their progress. After you
          allow this, it stays connected until you disconnect it under Settings, MCP.
        </p>
        <p className="muted">Redirects back to {redirectHost}.</p>
        <fieldset className="mcp-choices">
          <legend className="muted">What it can reach</legend>
          <label className="mcp-choice">
            <input
              type="radio"
              name="mcp-oauth-scope"
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
              name="mcp-oauth-scope"
              checked={scope === "projects"}
              disabled={busy}
              onChange={() => setScope("projects")}
            />
            <span>
              <strong>Selected projects</strong>
              <span className="muted"> Only the projects picked below.</span>
            </span>
          </label>
        </fieldset>
        {scope === "projects" && (
          <fieldset className="mcp-choices">
            <legend className="muted">Projects</legend>
            {projects === null && <p className="muted">Loading projects.</p>}
            {projects !== null && projects.length === 0 && <p className="muted">No projects yet. Create one first.</p>}
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
        <div className="actions actions-centered">
          <button className="btn btn-primary" disabled={busy || !ready} onClick={() => void decide(true)}>
            Allow
          </button>
          <button className="btn" disabled={busy} onClick={() => void decide(false)}>
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
