import type { AgentRun, FeatureChanges, GateState, RunArtifact } from "@bento/api-client";

/** Facts from the existing detail response. No inferred verdict or generated summary. */
export function ReviewHandoff({ run, agentName, changes, gate, artifacts, pending, failed, onChanges, onChat, onArtifact }: {
  run?: AgentRun;
  agentName?: string;
  changes: FeatureChanges | null;
  gate: GateState | null;
  artifacts: RunArtifact[];
  pending: boolean;
  failed: boolean;
  onChanges: () => void;
  onChat: () => void;
  onArtifact: (artifact: RunArtifact) => void;
}) {
  if (pending) return <p className="handoff-pending" role="status">Gathering the handoff…</p>;
  if (failed) return null; // The drawer's retry state owns load failures.
  const files = changes?.repositories.flatMap((repo) => repo.files) ?? [];
  const checks = gate?.checks.filter((check) => check.criterion.type !== "manual") ?? [];
  const passed = checks.filter((check) => check.status === "passed").length;
  const latestArtifacts = artifacts.filter((artifact) => artifact.runId === run?.id).slice(0, 2);
  return <div className="review-handoff">
    <p className="handoff-outcome">{!run ? "No agent run in this stage yet." : run.status === "succeeded" ? `${agentName ?? "The agent"} finished this stage.` : run.status === "failed" ? "The last run stopped with an error." : run.status === "cancelled" ? "The last run was stopped." : `${agentName ?? "The agent"} is working on this stage.`}</p>
    <div className="handoff-links">
      <button onClick={onChanges} className="handoff-link">
        <span>Changes across this card</span>
        <strong>{changes === null ? "Changes unavailable" : files.length === 0 ? "No committed changes available" : `${files.length} file${files.length === 1 ? "" : "s"} changed`} <span aria-hidden="true">↗</span></strong>
      </button>
      {run && <button onClick={onChat} className="handoff-link"><span>Agent notes</span><strong>Read the conversation <span aria-hidden="true">↗</span></strong></button>}
    </div>
    {checks.length > 0 ? <p className="handoff-checks"><span className="dot" data-state={checks.some((c) => c.status === "failed") ? "failed" : passed === checks.length ? "succeeded" : "gated"} />{passed} of {checks.length} {checks.length === 1 ? "requirement" : "requirements"} passed{checks.some((c) => c.status === "failed") ? ". Some need attention." : passed < checks.length ? ". Others are still pending." : "."}</p> : <p className="handoff-checks">No automated requirements recorded.</p>}
    {latestArtifacts.map((artifact) => <button key={artifact.id} className="handoff-artifact" onClick={() => onArtifact(artifact)}><span>{artifact.path.split("/").pop()}</span><span>View output ↗</span></button>)}
  </div>;
}
