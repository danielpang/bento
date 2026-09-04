import { useEffect, useState } from "react";
import { BetaOnly } from "../beta.js";
import { swarmApi } from "../swarm/client.js";
import { estimateLine, estimateSwarm, formatUsd, tierLabel, tierNote } from "../swarm/money.js";
import type { SwarmTemplate } from "../swarm/types.js";

/**
 * The swarm templates, listed inside the Agents panel.
 *
 * They belong here rather than in a panel of their own: an agent is a
 * coding tool paired with a model, and a template is the same
 * pairing said twice (one model to plan, one to work) plus the
 * ceilings a swarm runs under. Somebody looking for "which model does
 * what" opens this panel, and both answers are now in it.
 *
 * Read only for now. The dialog picks from these; editing them is its
 * own task, and a panel that pretends to save would be worse than one
 * that says where the list comes from.
 */
export function SwarmTemplatesPanel() {
  const [templates, setTemplates] = useState<SwarmTemplate[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void swarmApi
      .listTemplates()
      .then((rows) => {
        if (!cancelled) setTemplates(rows);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <BetaOnly>
      <section className="section settings-card">
        <h3 className="settings-title">Swarm templates</h3>
        <p className="muted">
          A template is the pair of models a swarm runs with, and the ceilings it runs under. The
          cost shape says which tier each tool reports its spend in, so an estimate can be split
          before anything is spent.
        </p>
        {templates === null && <p className="muted">Loading.</p>}
        {templates?.length === 0 && <p className="muted">None yet.</p>}
        {templates?.map((template) => (
          <div key={template.id} className="swarm-template-row">
            <span className="gate-check-text">
              <span className="gate-check-name">{template.name}</span>
              <br />
              {template.plannerModel} plans, {template.workerModel} works
            </span>
            <span className="swarm-template-tiers">
              {template.tools.map((tool) => (
                <span key={tool.name} className="chip" title={`${tool.name}. ${tierNote(tool.tier)}`}>
                  {tool.name} {tierLabel(tool.tier)}
                </span>
              ))}
            </span>
            <span className="muted swarm-template-estimate">
              {estimateLine(estimateSwarm(template), template.typicalLeaves)} Up to{" "}
              {template.maxWorkers} workers
              {template.maxBudgetUsd === null ? "" : `, ${formatUsd(template.maxBudgetUsd)} cap`}.
            </span>
          </div>
        ))}
      </section>
    </BetaOnly>
  );
}
