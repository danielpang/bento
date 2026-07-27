import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal.js";
import { ConfirmDialog } from "./PromptDialog.js";
import { criterionName, useDismissable } from "./ui.js";
import { useToast } from "./Toasts.js";
import type { AgentProfile, BentoClient, Feature, Stage } from "@bento/api-client";
import type { GateCriterion } from "@bento/core";
import { ProviderMark } from "./ProviderMark.js";

/**
 * The pipeline as a list of stage cards, each edited in its own modal.
 * Six full editors stacked in one scroll were hard to tell apart and
 * harder to reason about; a card summarizes, the modal decides. The
 * checkouts the pipeline works in have their own panel, because they
 * belong to the project rather than to any stage.
 */
export function StageConfig({
  client,
  projectId,
  pipelineId,
  stages,
  features,
  profiles,
  onClose,
  onChanged,
}: {
  client: BentoClient;
  /** Needed for the pipeline file, which belongs to the project. */
  projectId: string | null;
  pipelineId: string | null;
  stages: Stage[];
  /** Only for counting occupants, which is what makes removal safe to explain. */
  features: Feature[];
  profiles: AgentProfile[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const panel = useDismissable<HTMLElement>(onClose);
  const [busy, setBusy] = useState(false);
  /** The stage being edited, "new" for one being created, or null. */
  const [editing, setEditing] = useState<Stage | "new" | null>(null);
  const [removing, setRemoving] = useState<Stage | null>(null);
  /** Whether a pull request could actually be opened from here today. */
  const [canPublish, setCanPublish] = useState<boolean | null>(null);

  useEffect(() => {
    void client
      .githubStatus()
      .then((status) => setCanPublish(status.canPublish))
      .catch(() => setCanPublish(null));
  }, [client]);

  /**
   * The order being shown, which during a drag is the one being
   * proposed rather than the one the server holds. Kept in step with
   * the prop, so another client's change still lands here.
   */
  const [order, setOrder] = useState<Stage[]>(stages);
  const [dragging, setDragging] = useState<string | null>(null);
  /** The order to go back to if the card is dropped nowhere. */
  const baseline = useRef<Stage[]>(stages);
  /** Whether a drop landed, so dragend knows to revert rather than keep. */
  const dropped = useRef(false);
  useEffect(() => {
    // Not while dragging: replacing the list mid-gesture would pull the
    // card out from under the cursor.
    if (!dragging) setOrder(stages);
  }, [stages, dragging]);

  /** Applies a new order optimistically, and puts it back if it fails. */
  async function move(from: number, to: number) {
    if (to < 0 || to >= order.length || from === to || !pipelineId) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    const previous = order;
    setOrder(next);
    const ok = await act(() => client.reorderStages(pipelineId, next.map((stage) => stage.id)));
    if (!ok) setOrder(previous);
  }

  /**
   * The list rearranges as the card passes over it, so the gap the
   * stage will fall into is the gap it is already sitting in. A line
   * between two cards said where it would land; this shows it.
   */
  function previewAt(index: number) {
    setOrder((current) => {
      const from = current.findIndex((stage) => stage.id === dragging);
      if (from === -1 || from === index) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(index, 0, moved);
      return next;
    });
  }

  /** Keeps what the preview showed, or puts it back if nothing changed. */
  async function commitDrag() {
    dropped.current = true;
    setDragging(null);
    const before = baseline.current;
    const after = order;
    if (!pipelineId || after.every((stage, i) => stage.id === before[i]?.id)) return;
    const ok = await act(() => client.reorderStages(pipelineId, after.map((stage) => stage.id)));
    if (!ok) setOrder(before);
  }

  /** What the last import did, so it is not a button that seems inert. */
  const [imported, setImported] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  async function exportFile() {
    await act(async () => {
      if (!projectId) return;
      const yaml = await client.exportPipeline(projectId);
      // Downloaded rather than shown: the point of the file is to live
      // somewhere else, in a repository or another install.
      const url = URL.createObjectURL(new Blob([yaml], { type: "application/yaml" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "bento-pipeline.yaml";
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  async function importFile(file: File) {
    setImported("");
    const ok = await act(async () => {
      if (!projectId) return;
      const result = await client.importPipeline(projectId, await file.text());
      const parts = [`Imported ${result.stages} stages and ${result.agents} agents.`];
      if (result.removedStages.length > 0) parts.push(`Removed: ${result.removedStages.join(", ")}.`);
      if (result.skippedRepositories.length > 0) {
        parts.push(
          `No repository here is called ${result.skippedRepositories.join(" or ")}, so those commands were skipped.`,
        );
      }
      setImported(parts.join(" "));
    });
    if (!ok) setImported("");
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
      return true;
    } catch (err) {
      toast.fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="drawer" role="dialog" aria-label="Stage configuration" ref={panel}>
      <header className="drawer-head">
        <div className="drawer-title-row">
          <h2 className="drawer-title">Pipeline</h2>
          {/* Same reasoning as the Agents panel: the way to add one
              belongs where it can be seen, not below six stage cards
              and a file section. */}
          <button
            className="btn btn-primary"
            disabled={busy || !pipelineId}
            onClick={() => setEditing("new")}
          >
            Add stage
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted">
          Cards move left to right through these stages. Each stage decides which agent runs it and
          how a card leaves: waiting for you, or advancing when its requirements pass. Drag a stage
          by its handle to reorder them, or focus a handle and use the arrow keys.
        </p>
      </header>

      <div className="drawer-body">

        {order.map((stage, index) => {
          const assigned = profiles.find((p) => p.id === stage.defaultAgentProfileId);
          const criteria = Array.isArray(stage.gateCriteria) ? stage.gateCriteria : [];
          return (
            <div
              key={stage.id}
              className="stage-card"
              data-dragging={dragging === stage.id || undefined}
              onDragOver={(e) => {
                if (!dragging) return;
                // Without this the drop is refused and the card springs
                // back, which reads as the feature not working.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                previewAt(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                void commitDrag();
              }}
            >
              <div className="stage-card-head">
                {/* The handle is the only draggable part: a card that
                    drags from anywhere makes selecting its text
                    impossible, and it is focusable so the order can be
                    changed without a mouse. */}
                <button
                  type="button"
                  className="drag-handle"
                  draggable
                  aria-label={`Reorder ${stage.name}. Position ${index + 1} of ${order.length}. Use the arrow keys.`}
                  title="Drag to reorder, or focus and use the arrow keys"
                  disabled={busy}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox starts no drag at all without payload.
                    e.dataTransfer.setData("text/plain", stage.id);
                    /**
                     * The whole stage travels with the cursor, held at
                     * the point on the grip where it was picked up.
                     * Without this the browser drags a picture of the
                     * grip alone, so nothing appears to move.
                     */
                    const card = e.currentTarget.closest(".stage-card");
                    if (card instanceof HTMLElement) {
                      const box = card.getBoundingClientRect();
                      e.dataTransfer.setDragImage(card, e.clientX - box.left, e.clientY - box.top);
                    }
                    baseline.current = order;
                    dropped.current = false;
                    // After the browser has taken its snapshot, or the
                    // card that follows the cursor is the faded one.
                    const id = stage.id;
                    setTimeout(() => setDragging(id), 0);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    // Released over nothing: the preview was a proposal,
                    // not a change, so it goes back.
                    if (!dropped.current) setOrder(baseline.current);
                  }}
                  onKeyDown={(e) => {
                    const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
                    if (delta === 0) return;
                    e.preventDefault();
                    void move(index, index + delta);
                  }}
                >
                  <GripMark />
                </button>
                <span className="lane-ord">{String(index + 1).padStart(2, "0")}</span>
                <span className="stage-card-name">{stage.name}</span>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(stage)}>
                  Edit
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  aria-label={`Remove ${stage.name}`}
                  onClick={() => setRemoving(stage)}
                >
                  Remove
                </button>
              </div>
              <div className="stage-card-meta">
                {assigned ? (
                  <span className="chip">
                    <ProviderMark cli={assigned.cli} model={assigned.model} decorative />
                    {assigned.name}
                  </span>
                ) : (
                  <span className="chip chip-empty">no agent</span>
                )}
                <span className="muted">
                  {stage.gateType === "manual" ? "waits for your approval" : "advances on its requirements"}
                </span>
                {stage.gateType === "auto" && (
                  <span className="muted">
                    {criteria.length === 0
                      ? "when the agent finishes"
                      : `${criteria.length} requirement${criteria.length === 1 ? "" : "s"}`}
                  </span>
                )}
                {stage.createPr && <span className="muted">opens a pull request</span>}
              </div>
            </div>
          );
        })}

        {/* A pipeline is weeks of tuning, and until now it lived in one
            database. As a file it can go beside the code it describes,
            into another project, or into review with everything else. */}
        <section className="section">
          <span className="label">Pipeline file</span>
          <p className="muted">
            The stages, their requirements, the agents behind them, and each repository's commands,
            as one YAML file. Import it into another project instead of building it again.
          </p>
          <div className="actions">
            <button className="btn" disabled={busy || !projectId} onClick={() => void exportFile()}>
              Export YAML
            </button>
            <button className="btn" disabled={busy || !projectId} onClick={() => fileInput.current?.click()}>
              Import YAML
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml,application/yaml,text/yaml"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Cleared before the read, so choosing the same file
                // twice fires again: the second import is usually the
                // one after a fix.
                e.target.value = "";
                if (file) void importFile(file);
              }}
            />
          </div>
          {imported && <p className="muted">{imported}</p>}
        </section>

        {/* The count comes from the board rather than from the server's
            refusal: "cards must be moved first" as a warning is advice,
            while "2 cards are in it" is the answer to whether this will
            work at all. */}
        {removing && (
          <ConfirmDialog
            title={`Remove ${removing.name}?`}
            description={(() => {
              const occupants = features.filter((f) => f.currentStageId === removing.id).length;
              return occupants > 0
                ? `${occupants} card${occupants === 1 ? " is" : "s are"} in this stage. Move ${occupants === 1 ? "it" : "them"} to another stage first; removal will be refused until the stage is empty.`
                : "The lane disappears from the board. Cards that passed through it keep their history.";
            })()}
            confirmLabel="Remove stage"
            destructive
            onClose={() => setRemoving(null)}
            onConfirm={async () => {
              await act(() => client.deleteStage(removing.id));
            }}
          />
        )}

        {editing && (
          <StageEditor
            stage={editing === "new" ? null : editing}
            profiles={profiles}
            busy={busy}
            canPublish={canPublish}
            onClose={() => setEditing(null)}
            onSave={async (draft) => {
              const ok = await act(async () => {
                if (editing === "new") {
                  if (!pipelineId) return;
                  const created = await client.createStage(pipelineId, draft.name);
                  await client.updateStage(created.id, {
                    defaultAgentProfileId: draft.agentId,
                    gateType: draft.gateType,
                    gateCriteria: draft.criteria,
                    createPr: draft.createPr,
                  });
                } else {
                  await client.updateStage(editing.id, {
                    name: draft.name,
                    defaultAgentProfileId: draft.agentId,
                    gateType: draft.gateType,
                    gateCriteria: draft.criteria,
                    createPr: draft.createPr,
                  });
                }
              });
              if (ok) setEditing(null);
            }}
          />
        )}
      </div>
    </aside>
  );
}

/** Six dots: the one shape people already read as "drag me". */
function GripMark() {
  return (
    <svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="4" r="1.35" />
      <circle cx="7" cy="4" r="1.35" />
      <circle cx="3" cy="8" r="1.35" />
      <circle cx="7" cy="8" r="1.35" />
      <circle cx="3" cy="12" r="1.35" />
      <circle cx="7" cy="12" r="1.35" />
    </svg>
  );
}

interface StageDraft {
  name: string;
  agentId: string | null;
  gateType: "manual" | "auto";
  criteria: GateCriterion[];
  createPr: boolean;
}

/**
 * One stage's parameters in one dialog, saved together. Edits are a
 * draft until Save, so half-typed criteria never hit the server.
 */
function StageEditor({
  stage,
  profiles,
  busy,
  canPublish,
  onClose,
  onSave,
}: {
  stage: Stage | null;
  profiles: AgentProfile[];
  busy: boolean;
  /** Null while unknown; false means the setting cannot take effect yet. */
  canPublish: boolean | null;
  onClose: () => void;
  onSave: (draft: StageDraft) => void;
}) {
  const [draft, setDraft] = useState<StageDraft>(() => ({
    name: stage?.name ?? "",
    agentId: stage?.defaultAgentProfileId ?? null,
    gateType: (stage?.gateType as "manual" | "auto") ?? "manual",
    criteria: Array.isArray(stage?.gateCriteria) ? (stage.gateCriteria as GateCriterion[]) : [],
    createPr: stage?.createPr ?? false,
  }));
  const assigned = profiles.find((p) => p.id === draft.agentId);

  return (
    <Modal
      title={stage ? `Edit ${stage.name}` : "New stage"}
      description={
        stage
          ? "Changes apply when you save. Cards already in the stage keep going."
          : "The stage joins the end of the pipeline, waiting for your approval until you say otherwise."
      }
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !draft.name.trim()}
            onClick={() => onSave({ ...draft, name: draft.name.trim() })}
          >
            {stage ? "Save changes" : "Add stage"}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="label">Name</span>
        <input
          className="input"
          placeholder="Security review"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
      </label>

      <label className="field">
        <span className="label">Agent</span>
        <span className="field-with-mark">
          {assigned && <ProviderMark cli={assigned.cli} model={assigned.model} />}
          <select
            className="select"
            value={draft.agentId ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, agentId: e.target.value || null }))}
          >
            <option value="">No agent (start runs by hand)</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} ({profile.cli})
              </option>
            ))}
          </select>
        </span>
      </label>

      <label className="field">
        <span className="label">Advance</span>
        <select
          className="select"
          value={draft.gateType}
          onChange={(e) => setDraft((d) => ({ ...d, gateType: e.target.value as "manual" | "auto" }))}
        >
          <option value="manual">Only when I approve or reject</option>
          <option value="auto">Automatically, once its requirements pass</option>
        </select>
      </label>

      <div className="field">
        <span className="label">Pull request</span>
        <label className="gate-check">
          <input
            type="checkbox"
            checked={draft.createPr}
            onChange={(e) => setDraft((d) => ({ ...d, createPr: e.target.checked }))}
          />
          <span className="gate-check-text">
            Create a pull request when the agent finishes. The server pushes the card's branch and
            opens the pull request, or updates the one already open.
            {canPublish === false && " No GitHub connection is set up yet, so add a token under Settings, GitHub before this can run."}
          </span>
        </label>
      </div>

      {draft.gateType === "auto" ? (
        <CriteriaEditor
          criteria={draft.criteria}
          profiles={profiles}
          busy={busy}
          onChange={(criteria) => setDraft((d) => ({ ...d, criteria }))}
        />
      ) : (
        <p className="muted">
          You decide on the card: Approve moves it on, Reject sends it back. No requirements apply.
        </p>
      )}
    </Modal>
  );
}

function CriteriaEditor({
  criteria,
  profiles,
  busy,
  onChange,
}: {
  criteria: GateCriterion[];
  profiles: AgentProfile[];
  busy: boolean;
  onChange: (criteria: GateCriterion[]) => void;
}) {
  const [command, setCommand] = useState("");
  const [judgeId, setJudgeId] = useState("");

  const has = (type: string) => criteria.some((c) => c.type === type);

  function add(criterion: GateCriterion) {
    if (criterion.type !== "command" && has(criterion.type)) return;
    onChange([...criteria, criterion]);
  }

  function describe(criterion: GateCriterion): string {
    if (criterion.type === "command") {
      // The timeout is part of the deal and used to be invisible, so a
      // command killed at ten minutes looked like a command that failed.
      const minutes = Math.round(criterion.timeoutSec / 60);
      return `${criterionName("command")}: ${criterion.cmd} (gives up after ${minutes} minute${minutes === 1 ? "" : "s"})`;
    }
    if (criterion.type === "agent_judge") {
      const judge = profiles.find((p) => p.id === criterion.agentProfileId);
      return judge ? `${judge.name} verifies the work is complete` : criterionName("agent_judge");
    }
    return criterionName(criterion.type);
  }

  return (
    <div className="field">
      <span className="label">Requirements</span>
      <div className="criteria-list">
        {criteria.length === 0 && (
          <p className="muted">Nothing required yet: the stage advances as soon as its agent finishes.</p>
        )}
        {criteria.map((criterion, i) => (
          <div key={i} className="criterion">
            <span className="criterion-cmd">{describe(criterion)}</span>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => onChange(criteria.filter((_, index) => index !== i))}
              aria-label="Remove criterion"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="actions">
        <button
          className="btn"
          disabled={busy || has("run_succeeded")}
          title="Simple and automatic: passes when the stage's agent finishes without an error"
          onClick={() => add({ type: "run_succeeded" })}
        >
          The agent finished
        </button>
        <button
          className="btn"
          disabled={busy || has("pr_comments_resolved")}
          onClick={() => add({ type: "pr_comments_resolved" })}
        >
          Verify no unresolved review comments
        </button>
        <button className="btn" disabled={busy || has("checks_pass")} onClick={() => add({ type: "checks_pass" })}>
          GitHub checks pass
        </button>
      </div>
      <div className="actions">
        <select
          className="select"
          value={judgeId}
          onChange={(e) => setJudgeId(e.target.value)}
          aria-label="Judge agent"
        >
          <option value="">Choose a judge agent...</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} ({profile.cli})
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={busy || !judgeId || has("agent_judge")}
          onClick={() => {
            add({ type: "agent_judge", agentProfileId: judgeId });
            setJudgeId("");
          }}
        >
          Add judge
        </button>
      </div>
      <p className="muted">
        A judge is a second agent that reviews the work and rules on it. It works best with its own
        skill saying what complete means here, on a different model from the agent doing the work.
      </p>
      <div className="actions">
        <input
          className="input"
          placeholder="pnpm test"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          aria-label="Command to run"
        />
        {/* Disabled while empty: the placeholder used to become a real
            requirement, so a stray click added a "pnpm test" gate
            nobody typed and everybody later had to explain. */}
        <button
          className="btn"
          disabled={busy || !command.trim()}
          onClick={() => {
            add({ type: "command", cmd: command.trim(), timeoutSec: 600 });
            setCommand("");
          }}
        >
          Add command
        </button>
      </div>
    </div>
  );
}
