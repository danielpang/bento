import type { SwarmAgent } from "../swarm/client.js";

export function swarmAgentLabel(agent: SwarmAgent): string {
  return `${agent.name} · ${agent.cli} · ${agent.model}`;
}

export function SwarmAgentSelect({
  label,
  value,
  agents,
  onChange,
  fallback,
}: {
  label: string;
  value: string;
  agents: SwarmAgent[];
  onChange: (id: string) => void;
  fallback: string;
}) {
  const missing = value && !agents.some((agent) => agent.id === value);
  return (
    <label className="field">
      <span className="field-heading">{label}</span>
      <select className="input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{fallback}</option>
        {missing && <option value={value}>Selected agent is unavailable</option>}
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>{swarmAgentLabel(agent)}</option>
        ))}
      </select>
    </label>
  );
}
