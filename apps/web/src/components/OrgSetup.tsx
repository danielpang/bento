import { useMemo, useState } from "react";
import type { BentoClient } from "@bento/api-client";
import {
  MODEL_GUIDANCE,
  agentsForStages,
  checkAgentPairing,
  defaultPipelineSeed,
  defaultSeedModel,
  uniqueStageSlug,
  type PipelineSeed,
  type PipelineSeedAgent,
  type PipelineSeedStage,
  type SetupAgentCli,
} from "@bento/core";
import { BrandLockup } from "./BrandLockup.js";

const TOOLS = MODEL_GUIDANCE.filter((tool) => tool.cli !== "fake").map((tool) => ({
  value: tool.cli as SetupAgentCli,
  label: tool.label,
}));

type Step = "choose" | "pipeline" | "agents";

/**
 * First-run walkthrough after a team is created.
 *
 * The board cannot run anything without a pipeline and an agent on each
 * stage. Naming the team used to dump people on an empty board and make
 * them invent both from scratch (or discover they had been seeded in
 * silence). This is the same choice, asked out loud: take Bento's
 * defaults, or change them before the first project exists.
 */
export function OrgSetup({ client, onDone }: { client: BentoClient; onDone: () => void }) {
  const catalog = useMemo(() => defaultPipelineSeed(), []);
  const [step, setStep] = useState<Step>("choose");
  const [stages, setStages] = useState<PipelineSeedStage[]>(catalog.stages);
  const [agents, setAgents] = useState<PipelineSeedAgent[]>(catalog.agents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newStageName, setNewStageName] = useState("");

  async function finish(input: { mode: "skip" } | { mode: "defaults" } | ({ mode: "custom" } & PipelineSeed)) {
    setBusy(true);
    setError("");
    try {
      await client.completeSetup(input);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function setStageList(next: PipelineSeedStage[]) {
    setStages(next);
    setAgents((current) => agentsForStages(next, current));
  }

  function patchStage(index: number, patch: Partial<PipelineSeedStage>) {
    setStageList(stages.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)));
  }

  function patchAgent(index: number, patch: Partial<PipelineSeedAgent>) {
    setAgents((current) => current.map((agent, i) => (i === index ? { ...agent, ...patch } : agent)));
  }

  function addStage() {
    const name = newStageName.trim();
    if (!name) return;
    const slug = uniqueStageSlug(name, stages.map((stage) => stage.slug));
    setNewStageName("");
    setStageList([
      ...stages,
      { name, slug, description: "", gateType: "manual" },
    ]);
  }

  const pairingError = agents
    .map((agent) => {
      const pairing = checkAgentPairing(agent.cli, agent.model.trim());
      return pairing.status === "impossible" ? `${agent.name}: ${pairing.detail}` : null;
    })
    .find(Boolean);

  return (
    <div className="center">
      <div className={`card-panel ${step === "choose" ? "card-panel-setup" : "card-panel-setup-wide"}`}>
        <div className="auth-head">
          <BrandLockup size="lg" />
          <h1>{step === "choose" ? "Set up this team" : step === "pipeline" ? "Pipeline" : "Agents"}</h1>
        </div>

        {step === "choose" && (
          <>
            <p className="muted">
              A board needs a pipeline and an agent on each stage. Start from Bento's defaults, which
              you can change later, or shape them now.
            </p>
            <ol className="onboard-preview">
              {catalog.stages.map((stage) => (
                <li key={stage.slug}>
                  <span className="onboard-preview-name">{stage.name}</span>
                  <span className="muted">{stage.description}</span>
                </li>
              ))}
            </ol>
            {error && <p className="error">{error}</p>}
            <div className="onboard-actions">
              <button
                className="btn btn-primary btn-block"
                disabled={busy}
                onClick={() => void finish({ mode: "defaults" })}
              >
                {busy ? "Saving..." : "Use Bento's defaults"}
              </button>
              <button className="btn btn-block" disabled={busy} onClick={() => setStep("pipeline")}>
                Customize pipeline and agents
              </button>
              <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => void finish({ mode: "skip" })}>
                Skip for now
              </button>
            </div>
            <p className="muted">
              Skipping still seeds the defaults on the first project you create. Every stage waits for
              you before a card moves on.
            </p>
          </>
        )}

        {step === "pipeline" && (
          <>
            <p className="muted">
              Cards move left to right through these stages. Every stage starts waiting for you.
              Switch one to automatic later, once you trust it.
            </p>
            <ul className="onboard-stages">
              {stages.map((stage, index) => (
                <li key={stage.slug} className="onboard-stage">
                  <div className="onboard-stage-row">
                    <input
                      className="input"
                      value={stage.name}
                      aria-label={`Name for stage ${index + 1}`}
                      onChange={(e) => patchStage(index, { name: e.target.value })}
                    />
                    <select
                      className="select"
                      value={stage.gateType}
                      aria-label={`How ${stage.name} advances`}
                      onChange={(e) => patchStage(index, { gateType: e.target.value as "manual" | "auto" })}
                    >
                      <option value="manual">Manual</option>
                      <option value="auto">Automatic</option>
                    </select>
                  </div>
                  <input
                    className="input"
                    value={stage.description}
                    placeholder="What this stage is for"
                    aria-label={`Description for ${stage.name}`}
                    onChange={(e) => patchStage(index, { description: e.target.value })}
                  />
                  <div className="onboard-stage-tools">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...stages];
                        const [moved] = next.splice(index, 1);
                        if (!moved) return;
                        next.splice(index - 1, 0, moved);
                        setStageList(next);
                      }}
                    >
                      Move up
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={index === stages.length - 1}
                      onClick={() => {
                        const next = [...stages];
                        const [moved] = next.splice(index, 1);
                        if (!moved) return;
                        next.splice(index + 1, 0, moved);
                        setStageList(next);
                      }}
                    >
                      Move down
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={stages.length <= 1}
                      onClick={() => setStageList(stages.filter((_, i) => i !== index))}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="onboard-add">
              <input
                className="input"
                value={newStageName}
                placeholder="Add a stage"
                aria-label="New stage name"
                onChange={(e) => setNewStageName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addStage();
                  }
                }}
              />
              <button type="button" className="btn" disabled={!newStageName.trim()} onClick={addStage}>
                Add
              </button>
            </div>
            <div className="onboard-nav">
              <button type="button" className="btn btn-ghost" onClick={() => setStep("choose")}>
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={stages.length === 0 || stages.some((stage) => !stage.name.trim())}
                onClick={() => setStep("agents")}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {step === "agents" && (
          <>
            <p className="muted">
              One agent per stage. They all start on Claude Code and the cheaper model, so nothing
              spends on a model nobody chose. Point them somewhere else whenever you like.
            </p>
            <ul className="onboard-agents">
              {agents.map((agent, index) => {
                const stage = stages.find((row) => row.slug === agent.stageSlug);
                return (
                  <li key={agent.stageSlug} className="onboard-agent">
                    <p className="onboard-agent-stage">{stage?.name ?? agent.stageSlug}</p>
                    <label className="field">
                      <span className="label">Name</span>
                      <input
                        className="input"
                        value={agent.name}
                        onChange={(e) => patchAgent(index, { name: e.target.value })}
                      />
                    </label>
                    <div className="onboard-agent-row">
                      <label className="field">
                        <span className="label">Tool</span>
                        <select
                          className="select"
                          value={agent.cli}
                          onChange={(e) => {
                            const cli = e.target.value as SetupAgentCli;
                            patchAgent(index, { cli, model: defaultSeedModel(cli) });
                          }}
                        >
                          {TOOLS.map((tool) => (
                            <option key={tool.value} value={tool.value}>
                              {tool.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span className="label">Model</span>
                        <input
                          className="input"
                          value={agent.model}
                          onChange={(e) => patchAgent(index, { model: e.target.value })}
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span className="label">Skill</span>
                      <textarea
                        className="input textarea-grow"
                        value={agent.skill}
                        rows={4}
                        onChange={(e) => patchAgent(index, { skill: e.target.value })}
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
            {(pairingError || error) && <p className="error">{pairingError ?? error}</p>}
            <div className="onboard-nav">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setStep("pipeline")}>
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || Boolean(pairingError) || agents.some((agent) => !agent.name.trim() || !agent.model.trim())}
                onClick={() =>
                  void finish({
                    mode: "custom",
                    stages: stages.map((stage) => ({ ...stage, name: stage.name.trim() })),
                    agents: agents.map((agent) => ({ ...agent, name: agent.name.trim(), model: agent.model.trim() })),
                  })
                }
              >
                {busy ? "Saving..." : "Save setup"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
