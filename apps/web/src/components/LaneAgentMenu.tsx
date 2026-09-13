import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { AgentProfile } from "@bento/api-client";
import { ProviderMark } from "./ProviderMark.js";

const NONE = "none";

/**
 * The stage lane's agent pill. Clicking it switches which agent runs
 * the stage, or jumps to that agent's own settings, without leaving
 * the board.
 *
 * The menu behaviour is Radix's, same as the project switcher: a
 * native-looking label that is actually a button, with arrow keys and
 * typeahead, rather than a hand-rolled popover that only looked like
 * one.
 */
export function LaneAgentMenu({
  stage,
  agent,
  profiles,
  onAssign,
  onEditAgent,
  onNewAgent,
}: {
  stage: { id: string; name: string };
  agent: AgentProfile | undefined;
  profiles: AgentProfile[];
  onAssign: (profileId: string | null) => Promise<void>;
  onEditAgent: (profileId: string) => void;
  onNewAgent: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function assign(profileId: string | null) {
    setSaving(true);
    try {
      await onAssign(profileId);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        className={agent ? "lane-agent" : "lane-agent lane-agent-empty"}
        title={agent ? `${agent.cli} · ${agent.model}` : undefined}
        aria-label={
          agent
            ? `Change the agent for the ${stage.name} stage`
            : `Assign an agent to the ${stage.name} stage`
        }
        disabled={saving}
        data-saving={saving || undefined}
        aria-busy={saving || undefined}
      >
        {agent ? (
          <>
            <ProviderMark cli={agent.cli} model={agent.model} decorative />
            <span className="lane-agent-name">{agent.name}</span>
          </>
        ) : (
          "no agent assigned"
        )}
        {saving ? (
          <span className="lane-agent-spinner" aria-hidden="true" />
        ) : (
          <span className="picker-caret" aria-hidden="true" />
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="picker-menu lane-agent-menu" align="start" sideOffset={6} data-portal-layer="">
          <div className="picker-kicker lane-agent-kicker">Runs {stage.name}</div>
          {profiles.length === 0 ? (
            <p className="lane-agent-empty-note">No agents yet. Create one to run this stage.</p>
          ) : (
            <Menu.RadioGroup
              className="picker-group"
              value={agent?.id ?? NONE}
              onValueChange={(value) => void assign(value === NONE ? null : value)}
            >
              {profiles.map((profile) => (
                <Menu.RadioItem key={profile.id} value={profile.id} className="picker-item">
                  <span className="picker-tick" aria-hidden="true">
                    {profile.id === agent?.id ? "✓" : ""}
                  </span>
                  <ProviderMark cli={profile.cli} model={profile.model} decorative />
                  <span className="lane-agent-item-text">
                    <span className="picker-item-name">{profile.name}</span>
                    <span className="lane-agent-item-sub">
                      {profile.cli} · {profile.model}
                    </span>
                  </span>
                </Menu.RadioItem>
              ))}
              <Menu.RadioItem value={NONE} className="picker-item">
                <span className="picker-tick" aria-hidden="true">
                  {agent ? "" : "✓"}
                </span>
                <span className="picker-item-name">No agent (start runs by hand)</span>
              </Menu.RadioItem>
            </Menu.RadioGroup>
          )}
          <Menu.Separator className="picker-sep" />
          {agent && (
            <Menu.Item className="picker-item picker-item-action" onSelect={() => onEditAgent(agent.id)}>
              <span className="picker-tick" aria-hidden="true" />
              <span className="picker-item-name">Edit this agent's settings</span>
            </Menu.Item>
          )}
          <Menu.Item className="picker-item picker-item-action" onSelect={onNewAgent}>
            <span className="picker-tick" aria-hidden="true">
              +
            </span>
            <span className="picker-item-name">Add a new agent</span>
          </Menu.Item>
          {profiles.length > 0 && (
            <p className="lane-agent-footnote">
              Applies to the next run. A card already running keeps its agent.
            </p>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
