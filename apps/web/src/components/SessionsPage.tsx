import { useCallback, useEffect, useState } from "react";
import type { AgentProfile, BentoClient, ProjectSession } from "@bento/api-client";
import { runTime, runWords } from "./AgentSession.js";
import { useToast } from "./Toasts.js";

/**
 * The sessions tab: every conversation in the active project, one row
 * per card, newest activity first, shaped like a messaging app's
 * conversation list. Lives inside the board's chrome; a row opens the
 * same page the drawer's expand button does, so the chat itself stays
 * one component.
 */
export function SessionsPage({
  client,
  projectId,
  profiles,
}: {
  client: BentoClient;
  projectId: string | null;
  profiles: AgentProfile[];
}) {
  const toast = useToast();
  const [sessions, setSessions] = useState<ProjectSession[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setSessions([]);
      return;
    }
    try {
      const list = await client.listSessions(projectId);
      setSessions(list.sessions);
      setLoadFailed(false);
    } catch (err) {
      toast.fail(err);
      setLoadFailed(true);
    }
  }, [client, projectId, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Run state changes arrive on the project's board stream. A
  // reconnect means missed events are gone, so resync either way.
  useEffect(() => {
    if (!projectId) return;
    let timer: number | null = null;
    const schedule = () => {
      timer ??= window.setTimeout(() => {
        timer = null;
        void refresh();
      }, 250);
    };
    const stop = client.streamBoard(projectId, schedule, schedule);
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [client, projectId, refresh]);

  if (loadFailed) {
    return (
      <div className="sessions-screen">
        <p className="error">Could not load sessions.</p>
        <p className="muted">Check that the server is reachable and that you are signed in, then reload.</p>
      </div>
    );
  }

  return (
    <div className="sessions-screen">
      {sessions === null && <div className="center" />}
      {sessions?.length === 0 && (
        <p className="muted">No sessions yet. Start an agent from the board to begin a conversation.</p>
      )}
      {sessions && sessions.length > 0 && (
        <div className="sessions-list">
          {sessions.map((session) => {
            const run = session.latestRun;
            const agent = profiles.find((p) => p.id === run.agentProfileId)?.name ?? "agent";
            return (
              <a
                key={session.featureId}
                className="session-card"
                href={`/session/${session.featureId}`}
                title="Open this conversation"
              >
                <span className="session-avatar" aria-hidden="true">
                  {initialsOf(agent)}
                </span>
                <span className="session-card-main">
                  <span className="session-card-top">
                    <span className="session-card-title">{session.title}</span>
                    <span className="session-card-time">{runTime(run.queuedAt)}</span>
                  </span>
                  <span className="session-card-sub">
                    <span
                      className="dot"
                      data-state={
                        run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : "running"
                      }
                    />
                    <span className="session-card-status">
                      {agent} {runWords(run.status)}
                    </span>
                    <span className="session-card-tail">
                      {session.runCount === 1 ? "1 run" : `${session.runCount} runs`}
                      {session.totalCostUsd !== null ? ` · $${session.totalCostUsd.toFixed(2)}` : ""}
                    </span>
                  </span>
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "Code Reviewer" wears CR, the way a chat list draws its contacts. */
function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((word) => word[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "A"
  );
}
