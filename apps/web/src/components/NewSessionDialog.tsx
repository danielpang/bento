import { useMemo, useState } from "react";
import type { AgentProfile, BentoClient } from "@bento/api-client";
import { MODEL_GUIDANCE, modelStringFor, providersForCli, type AgentCli } from "@bento/core";
import { Modal } from "./Modal.js";
import { PREVIEW_TOOLS } from "./ui.js";

/** The coding agents a person can pick, from the same catalog as the agent editor. */
const HARNESSES = MODEL_GUIDANCE.filter((tool) => tool.cli !== "fake").map((tool) => ({
  value: tool.cli as AgentCli,
  label: tool.label,
  defaultModel: tool.defaultModel,
}));

/** The models a harness can run, grouped by provider, as the stored model string. */
function modelGroupsFor(cli: AgentCli): { provider: string; models: { value: string; label: string }[] }[] {
  return providersForCli(cli)
    .map((provider) => ({
      provider: provider.name,
      models: provider.models.map((model) => ({
        value: modelStringFor(cli, provider.id, model.id),
        label: `${model.name} (${model.id})`,
      })),
    }))
    .filter((group) => group.models.length > 0);
}

/**
 * The model a harness starts on: the one this person last ran on it
 * when there is one, else the tool's own default.
 */
function startingModel(cli: AgentCli, fallbackProfile?: AgentProfile): string {
  if (fallbackProfile?.cli === cli) return fallbackProfile.model;
  return HARNESSES.find((h) => h.value === cli)?.defaultModel ?? "";
}

/**
 * Starts a conversation with an agent, without a stage: pick the coding
 * agent and the model, say what you want. The server makes it a card in
 * the backlog and starts the agent on it; `onStarted` gets that card.
 */
export function NewSessionDialog({
  client,
  projectId,
  recentProfile,
  onClose,
  onStarted,
}: {
  client: BentoClient;
  projectId: string;
  /** The agent behind the newest session, so a second session starts where the last one did. */
  recentProfile?: AgentProfile;
  onClose: () => void;
  onStarted: (featureId: string) => void;
}) {
  const initialCli =
    recentProfile && HARNESSES.some((h) => h.value === recentProfile.cli)
      ? (recentProfile.cli as AgentCli)
      : (HARNESSES[0]?.value ?? "claude-code");
  const [cli, setCli] = useState<AgentCli>(initialCli);
  const [model, setModel] = useState(() => startingModel(initialCli, recentProfile));
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => modelGroupsFor(cli), [cli]);
  const listed = groups.some((group) => group.models.some((m) => m.value === model));

  const pickCli = (next: AgentCli) => {
    setCli(next);
    setModel(startingModel(next, recentProfile));
  };

  const canStart = !busy && Boolean(model.trim()) && Boolean(prompt.trim());

  const start = async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      const { featureId } = await client.startSession(projectId, { cli, model: model.trim(), prompt: prompt.trim() });
      onStarted(featureId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New session"
      description="Talk to an agent about this project without putting a card in a stage. The session waits in the backlog, and you can move it into a stage later."
      onClose={busy ? () => {} : onClose}
      actions={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canStart} onClick={() => void start()}>
            {busy ? "Starting…" : "Start session"}
          </button>
        </>
      }
    >
      <div className="new-session-runtime">
        <label className="field">
          <span className="label">Harness</span>
          <select
            className="select"
            value={cli}
            disabled={busy}
            onChange={(e) => pickCli(e.target.value as AgentCli)}
          >
            {HARNESSES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
                {PREVIEW_TOOLS[option.value] ? " (preview)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Model</span>
          {groups.length > 0 ? (
            <select className="select" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>
              {/* A model the catalog does not list (the last one used on
                  this harness, say) stays choosable rather than vanishing. */}
              {!listed && model && <option value={model}>{model}</option>}
              {groups.map((group) => (
                <optgroup key={group.provider} label={group.provider}>
                  {group.models.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          ) : (
            // A harness with no catalog entry takes whatever id its
            // provider understands.
            <input
              className="input"
              value={model}
              disabled={busy}
              spellCheck={false}
              onChange={(e) => setModel(e.target.value)}
            />
          )}
        </label>
      </div>
      <label className="field">
        <span className="label">Message</span>
        <textarea
          className="input"
          rows={5}
          autoFocus
          value={prompt}
          disabled={busy}
          placeholder="What should the agent look into or change?"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter stays a newline; submit is the chord the rest of the
            // console uses.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void start();
            }
          }}
        />
      </label>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
