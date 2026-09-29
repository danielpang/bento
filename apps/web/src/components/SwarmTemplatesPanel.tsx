import { lazy, Suspense, useEffect, useState } from "react";
import { BetaOnly } from "../beta.js";
import { MAX_SWARM_WORKERS } from "@bento/core";
import { swarmApi, type SwarmAgent, type TemplateInput } from "../swarm/client.js";
import { estimateLine, estimateSwarm, formatUsd, tierLabel, tierNote } from "../swarm/money.js";
import type { SwarmTemplate } from "../swarm/types.js";
import { visibleTemplateDescription } from "../swarm/template-description.js";
import { SwarmAgentSelect, swarmAgentLabel } from "./SwarmAgentSelect.js";

const ConfirmDialog = lazy(() => import("./PromptDialog.js").then((module) => ({ default: module.ConfirmDialog })));

type WorkerIsolation = SwarmTemplate["workerIsolation"];

/**
 * The swarm templates, listed inside the Agents panel.
 *
 * They belong here rather than in a panel of their own: an agent is a
 * coding tool paired with a model, and a template is the same
 * pairing said twice (one model to plan, one to work) plus the
 * ceilings a swarm runs under. Somebody looking for "which model does
 * what" opens this panel, and both answers are now in it.
 *
 * Editable, because a read only list was one half of a console that
 * could not be used at all: the New swarm dialog needs a template, and
 * the only thing that made one was creating a swarm.
 *
 * The planner and worker are explicit choices. Both are agent profiles
 * with a harness and model, shared with the board's stage assignments.
 *
 * The cost shape is drawn for a template that has one. Nothing on the
 * server records what a tool reports its spend in yet, so today this
 * is a list of names and ceilings, which is what is actually known.
 */
/**
 * Where a template's agents work, in words.
 *
 * Worth printing because it is the setting that decides what a swarm
 * costs the machine it runs on, and because it is the one a deployment
 * can refuse: a template that asks for checkouts on the server cannot
 * run where the sandboxes hold their own clones, and somebody reading
 * this panel is the person who would need to know why.
 */
export function isolationWords(isolation: SwarmTemplate["workerIsolation"]): string {
  return isolation === "worktree"
    ? "each in a worktree of the repository on the server"
    : "each on a machine of its own";
}

/**
 * What a template the person has not filled in yet starts as.
 *
 * No isolation, on purpose. The create route fills it from the
 * deployment, and a console that always stated one would make every
 * template here say worktrees, which a hosted install refuses when the
 * first swarm tries to provision rather than when Save is pressed.
 */
const BLANK: TemplateInput = {
  name: "",
  description: "",
  maxWorkers: 2,
  budgetUsd: null,
  timeLimitMin: null,
};

/** The longest name the route takes, said here so Save can refuse first. */
const MAX_NAME = 120;

export function SwarmTemplatesPanel({ knownAgents }: { knownAgents: SwarmAgent[] }) {
  const [templates, setTemplates] = useState<SwarmTemplate[] | null>(null);
  const [agents, setAgents] = useState<SwarmAgent[]>([]);
  const [draft, setDraft] = useState<TemplateInput | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<SwarmTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAgents(knownAgents);
  }, [knownAgents]);

  useEffect(() => {
    let cancelled = false;
    void swarmApi
      .listTemplates()
      .then(async (rows) => {
        if (!cancelled) setTemplates(rows);
        // Listing templates seeds the default swarm profiles on a fresh install.
        const profiles = await swarmApi.listAgents();
        if (!cancelled) setAgents(profiles);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * One place where a write is run, so every button reports the same
   * way. The list is replaced from what the server returned rather
   * than patched in place: a ceiling the server clamped is the number
   * a swarm will actually run under, and the panel showing the number
   * that was typed would be the console disagreeing with the rows.
   */
  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      setTemplates(await swarmApi.listTemplates());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const editingRow = templates?.find((row) => row.id === editing) ?? null;

  return (
    <BetaOnly>
      <section className="section settings-card">
        <h3 className="settings-title">Swarm templates</h3>
        <p className="muted">
          Choose the planner and worker agent profiles for new swarms. Each profile defines its
          harness and model. Profiles here can also be used on board stages.
        </p>
        {error && <p className="error">{error}</p>}
        {templates === null && <p className="muted">Loading.</p>}
        {templates?.length === 0 && <p className="muted">None yet.</p>}
        {templates?.map((template) => (
          <div key={template.id} className="swarm-template-row">
            <span className="gate-check-text">
              <span className="gate-check-name">{template.name}</span>
              <br />
              {visibleTemplateDescription(template.description) && <>{visibleTemplateDescription(template.description)}<br /></>}
              Planner: {agentSummary(agents, template.plannerProfileId)}
              <br />
              Worker: {agentSummary(agents, template.workerProfileId)}
            </span>
            <span className="swarm-template-tiers">
              {template.tools.map((tool) => (
                <span key={tool.name} className="chip" title={`${tool.name}. ${tierNote(tool.tier)}`}>
                  {tool.name} {tierLabel(tool.tier)}
                </span>
              ))}
            </span>
            <span className="actions">
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setEditing(template.id === editing ? null : template.id);
                }}
              >
                {template.id === editing ? "Close" : "Edit"}
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => setConfirmingDelete(template)}
              >
                Delete
              </button>
            </span>
            <span className="muted swarm-template-estimate">
              {/* An estimate needs a cost shape. Without one this says
                  what the template limits and claims no figure. */}
              {template.typicalLeaves > 0
                ? `${estimateLine(estimateSwarm(template), template.typicalLeaves)} `
                : ""}
              Up to {template.maxWorkers} workers, {isolationWords(template.workerIsolation)}
              {template.maxBudgetUsd === null ? "" : `, ${formatUsd(template.maxBudgetUsd)} cap`}.
            </span>
          </div>
        ))}

        {editingRow && (
          <TemplateForm
            key={editingRow.id}
            title={`Editing ${editingRow.name}`}
            value={{
              name: editingRow.name,
              description: visibleTemplateDescription(editingRow.description),
              maxWorkers: editingRow.maxWorkers,
              budgetUsd: editingRow.maxBudgetUsd,
              timeLimitMin: editingRow.timeLimitMin,
              workerIsolation: editingRow.workerIsolation,
              plannerProfileId: editingRow.plannerProfileId,
              workerProfileId: editingRow.workerProfileId,
            }}
            agents={agents}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={(input) =>
              void act(async () => {
                await swarmApi.updateTemplate(editingRow.id, input);
                setEditing(null);
              })
            }
          />
        )}

        {draft && (
          <TemplateForm
            title="New template"
            value={draft}
            agents={agents}
            busy={busy}
            onCancel={() => setDraft(null)}
            onSave={(input) =>
              void act(async () => {
                await swarmApi.createTemplate(input);
                setDraft(null);
              })
            }
          />
        )}

        {!draft && !editingRow && (
          <div className="actions">
            <button className="btn" disabled={busy} onClick={() => setDraft({
              ...BLANK,
              plannerProfileId: agents.find((agent) => agent.name === "Swarm Planner")?.id ?? agents[0]?.id ?? null,
              workerProfileId: agents.find((agent) => agent.name === "Swarm Worker")?.id ?? agents[0]?.id ?? null,
            })}>
              New template
            </button>
          </div>
        )}
        {confirmingDelete && (
          <Suspense fallback={null}><ConfirmDialog
            title={`Delete ${confirmingDelete.name}?`}
            description="Swarms already running will continue. This template will no longer be available for new swarms."
            confirmLabel="Delete template"
            destructive
            onClose={() => setConfirmingDelete(null)}
            onConfirm={async () => {
              await act(async () => {
                await swarmApi.deleteTemplate(confirmingDelete.id);
                if (editing === confirmingDelete.id) setEditing(null);
              });
            }}
          /></Suspense>
        )}
      </section>
    </BetaOnly>
  );
}

/**
 * The fields a template's ceilings are typed into.
 *
 * One component for creating and for editing, because they are the
 * same fields and a second copy is a second place for them to drift.
 * Numbers are held as text while they are being typed: a controlled
 * number input that coerces on every keystroke cannot be cleared, and
 * an empty budget is a real value here (no cap) rather than zero.
 */
function TemplateForm({
  title,
  value,
  agents,
  busy,
  onSave,
  onCancel,
}: {
  title: string;
  value: TemplateInput;
  agents: SwarmAgent[];
  busy: boolean;
  onSave: (input: TemplateInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(value.name);
  const [description, setDescription] = useState(value.description);
  const [plannerProfileId, setPlannerProfileId] = useState(value.plannerProfileId ?? "");
  const [workerProfileId, setWorkerProfileId] = useState(value.workerProfileId ?? "");
  const [workers, setWorkers] = useState(String(value.maxWorkers));
  const [budget, setBudget] = useState(value.budgetUsd === null ? "" : String(value.budgetUsd));
  const [minutes, setMinutes] = useState(value.timeLimitMin === null ? "" : String(value.timeLimitMin));
  const [isolation, setIsolation] = useState<WorkerIsolation | undefined>(value.workerIsolation);

  const workerCount = Number(workers);
  // The same ceilings the routes enforce, said here so a value that
  // would be refused is refused before the round trip, and with a
  // sentence rather than the route's raw validation error.
  const workersOk = Number.isInteger(workerCount) && workerCount >= 1 && workerCount <= MAX_SWARM_WORKERS;
  const budgetParsed = parseOptionalNumber(budget, { integer: false });
  const minutesParsed = parseOptionalNumber(minutes, { integer: true });
  const nameOk = name.trim() !== "" && name.trim().length <= MAX_NAME;
  const ready = nameOk && workersOk && budgetParsed.ok && minutesParsed.ok && !busy;

  return (
    <div className="swarm-template-form">
      <span className="label">{title}</span>
      <label className="field">
        <span className="field-heading">Name</span>
        <input className="input" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-heading">Description</span>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="field-row">
        <SwarmAgentSelect label="Planner agent" value={plannerProfileId} agents={agents} onChange={setPlannerProfileId} fallback="Use default planner" />
        <SwarmAgentSelect label="Worker agent" value={workerProfileId} agents={agents} onChange={setWorkerProfileId} fallback="Use default worker" />
      </div>
      <p className="muted">Use New agent to add a harness and model pairing, then assign it here.</p>
      <label className="field">
        <span className="field-heading">Workers</span>
        <input
          className="input"
          type="number"
          min={1}
          max={MAX_SWARM_WORKERS}
          value={workers}
          onChange={(e) => setWorkers(e.target.value)}
        />
        <span className="muted">
          {workersOk
            ? "How many workers a swarm on this template may run at once."
            : `Between 1 and ${MAX_SWARM_WORKERS}.`}
        </span>
      </label>
      <label className="field">
        <span className="field-heading">Budget</span>
        <input
          className="input"
          value={budget}
          placeholder="No cap"
          onChange={(e) => setBudget(e.target.value)}
        />
        <span className={budgetParsed.ok ? "muted" : "error"}>
          {budgetParsed.ok
            ? "Left empty, a swarm on this template runs with no spending cap."
            : "A number of dollars, or empty for no cap."}
        </span>
      </label>
      <label className="field">
        <span className="field-heading">Time limit</span>
        <input
          className="input"
          value={minutes}
          placeholder="No limit"
          onChange={(e) => setMinutes(e.target.value)}
        />
        <span className={minutesParsed.ok ? "muted" : "error"}>
          {minutesParsed.ok
            ? "In minutes. Left empty, a swarm runs until it is done or stopped."
            : "A whole number of minutes, or empty for no limit."}
        </span>
      </label>
      <label className="field">
        <span className="field-heading">Where workers work</span>
        <select
          className="input"
          value={isolation ?? ""}
          onChange={(e) =>
            setIsolation(e.target.value === "" ? undefined : (e.target.value as WorkerIsolation))
          }
        >
          <option value="">Use deployment default</option>
          <option value="worktree">In worktrees of the repository on the server</option>
          <option value="sandbox">On a machine each, holding its own clone</option>
        </select>
        <span className="muted">
          Leave this on default unless your workers need a specific environment.
        </span>
      </label>
      <div className="actions">
        <button className="btn btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!ready}
          onClick={() =>
            onSave({
              name: name.trim(),
              description: description.trim(),
              plannerProfileId: plannerProfileId || null,
              workerProfileId: workerProfileId || null,
              maxWorkers: workerCount,
              budgetUsd: budgetParsed.value,
              timeLimitMin: minutesParsed.value,
              // Absent rather than null when nothing was chosen, so the
              // create route's own answer is what gets written.
              ...(isolation ? { workerIsolation: isolation } : {}),
            })
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

function agentSummary(agents: SwarmAgent[], id?: string | null): string {
  if (!id) return "Default agent";
  const agent = agents.find((entry) => entry.id === id);
  return agent ? swarmAgentLabel(agent) : "Agent unavailable";
}

/**
 * A typed figure, or null for "no cap", or a refusal.
 *
 * Empty means null, which is no cap. Anything unreadable is a refusal
 * rather than null, because those two used to be the same answer: a
 * budget typed as "15O" or "$150" became a template with no spending
 * limit at all, reported as success, and the swarms started from it ran
 * uncapped. Zero is refused for the same reason it always was worth
 * refusing: a swarm that cannot start is nobody's intent.
 */
function parseOptionalNumber(
  text: string,
  { integer }: { integer: boolean },
): { ok: true; value: number | null } | { ok: false; value: null } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, value: null };
  if (integer && !Number.isInteger(value)) return { ok: false, value: null };
  return { ok: true, value };
}
