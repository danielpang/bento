import type { AgentEvent } from '@bento/core';
import type { Feature, Stage } from '@bento/api-client';

// The wording and rules below mirror the web console (Board.tsx,
// FeatureDrawer.tsx, AgentSession.tsx) so both clients say the same thing.

export type CardState = 'running' | 'succeeded' | 'failed' | 'gated' | 'done' | 'cancelled' | 'idle';

const RUN_ACTIVE = new Set(['queued', 'starting', 'running']);

export function isRunActive(status: string | undefined | null): boolean {
  return RUN_ACTIVE.has(status ?? '');
}

export function isFinished(feature: Pick<Feature, 'status'>): boolean {
  return feature.status === 'done' || feature.status === 'cancelled';
}

export function cardState(feature: Pick<Feature, 'status'>, runStatus: string | undefined): CardState {
  if (feature.status === 'done') return 'done';
  if (feature.status === 'cancelled') return 'cancelled';
  if (isRunActive(runStatus)) return 'running';
  if (feature.status === 'gated') return 'gated';
  if (runStatus === 'succeeded') return 'succeeded';
  if (runStatus === 'failed') return 'failed';
  return 'idle';
}

export function stateLabel(state: CardState): string {
  switch (state) {
    case 'running': return 'agent working';
    case 'succeeded': return 'agent finished';
    case 'failed': return 'agent failed';
    case 'gated': return 'pending approval';
    case 'done': return 'completed';
    case 'cancelled': return 'cancelled';
    default: return 'not started';
  }
}

export function stateTone(state: CardState): 'running' | 'succeeded' | 'failed' | 'gated' | 'idle' {
  switch (state) {
    case 'running': return 'running';
    case 'succeeded':
    case 'done': return 'succeeded';
    case 'failed': return 'failed';
    case 'gated': return 'gated';
    default: return 'idle';
  }
}

export function statusWords(status: string): string {
  switch (status) {
    case 'backlog': return 'in the backlog';
    case 'active': return 'in progress';
    case 'gated': return 'pending approval';
    case 'done': return 'completed';
    case 'cancelled': return 'cancelled';
    default: return status;
  }
}

export function statusTone(status: string): 'running' | 'succeeded' | 'gated' | 'idle' {
  switch (status) {
    case 'active': return 'running';
    case 'gated': return 'gated';
    case 'done': return 'succeeded';
    default: return 'idle';
  }
}

export function runWords(status: string): string {
  switch (status) {
    case 'queued': return 'waiting to start';
    case 'starting': return 'starting';
    case 'running': return 'working';
    case 'succeeded': return 'finished';
    case 'failed': return 'failed';
    case 'cancelled': return 'stopped';
    default: return status;
  }
}

export function runTone(status: string): 'running' | 'succeeded' | 'failed' | 'idle' {
  switch (status) {
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'cancelled': return 'idle';
    default: return 'running';
  }
}

/** Every search term has to land in the title or description, with or without punctuation. */
export function matchesQuery(feature: Pick<Feature, 'title' | 'description'>, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(term => /[a-z0-9]/.test(term));
  if (terms.length === 0) return true;
  const text = `${feature.title} ${feature.description ?? ''}`.toLowerCase();
  const squashed = text.replace(/[^a-z0-9]+/g, '');
  return terms.every(term => text.includes(term) || squashed.includes(term.replace(/[^a-z0-9]+/g, '')));
}

export type Lane = { key: string; name: string; ordinal: string; note: string | null; stage: Stage | null; cards: Feature[] };

/** Backlog, then each stage, then Completed: the board's lanes in order. */
export function boardLanes(features: Feature[], stages: Stage[], query: string): Lane[] {
  const shown = features.filter(feature => !feature.standalone && matchesQuery(feature, query));
  const ordinal = (n: number) => String(n).padStart(2, '0');
  return [
    { key: 'backlog', name: 'Backlog', ordinal: '00', note: 'Ready to enter the pipeline', stage: null, cards: shown.filter(f => !f.currentStageId && !isFinished(f)) },
    ...stages.map((stage, i) => ({ key: stage.id, name: stage.name, ordinal: ordinal(i + 1), note: null, stage, cards: shown.filter(f => f.currentStageId === stage.id && !isFinished(f)) })),
    { key: 'completed', name: 'Completed', ordinal: ordinal(stages.length + 1), note: 'Finished work', stage: null, cards: shown.filter(isFinished) },
  ];
}

export function runTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function artifactBaseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function kindExt(kind: string, path?: string): string {
  if (kind === 'markdown') return 'MD';
  if (kind === 'html') return 'HTML';
  if (kind === 'mermaid') return 'MMD';
  const ext = path?.split('.').pop();
  if (ext && ext !== path && ext.length <= 4) return ext.toUpperCase();
  return kind === 'image' ? 'IMG' : 'FILE';
}

export type ToolCall = { name: string; summary: string };
export type ChatItem =
  | { key: string; kind: 'message'; role: 'assistant' | 'user' | 'system'; speaker: string; text: string }
  | { key: string; kind: 'tools'; calls: ToolCall[] }
  | { key: string; kind: 'result'; ok: boolean; costUsd?: number; error?: string; interrupted?: boolean };

function toolSummary(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '';
  const input = detail as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0];
  }
  return '';
}

/** Folds a run's events into rows: consecutive tool calls become one row. */
export function toChatItems(events: AgentEvent[], agentName: string, keyPrefix: string): ChatItem[] {
  const items: ChatItem[] = [];
  let calls: ToolCall[] = [];
  let n = 0;
  const flush = () => {
    if (calls.length === 0) return;
    items.push({ key: `${keyPrefix}-tools-${n++}`, kind: 'tools', calls });
    calls = [];
  };
  for (const event of events) {
    if (event.type === 'tool') {
      if (event.phase === 'start') calls.push({ name: event.name, summary: toolSummary(event.detail) });
      continue;
    }
    if (event.type === 'init') continue;
    flush();
    if (event.type === 'message') {
      items.push({ key: `${keyPrefix}-${n++}`, kind: 'message', role: event.role, text: event.text, speaker: event.role === 'assistant' ? agentName : event.role === 'user' ? 'you' : 'bento' });
      continue;
    }
    items.push({ key: `${keyPrefix}-${n++}`, kind: 'result', ok: event.ok, costUsd: event.costUsd, error: event.error, interrupted: event.interrupted });
  }
  flush();
  return items;
}

export function formatCost(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : null;
}

const LIVE_TOOLS: Record<string, 'steer' | 'queue' | undefined> = { pi: 'steer', 'claude-code': 'queue', codex: 'steer', opencode: 'queue' };
const LIVE_SINCE_RECORD = new Set(['codex', 'opencode']);

export function runLiveKind(cli: string, liveSession: boolean | null | undefined): 'steer' | 'queue' | undefined {
  if (liveSession === false) return undefined;
  if (liveSession === true) return LIVE_TOOLS[cli];
  return LIVE_SINCE_RECORD.has(cli) ? undefined : LIVE_TOOLS[cli];
}

/** The line under the composer, saying what a message will do right now. */
export function composerHint(runActive: boolean, liveKind: 'steer' | 'queue' | undefined, agentName: string | undefined, resumes: boolean): string {
  const agent = agentName ?? 'This agent';
  if (!runActive) {
    return resumes
      ? 'Nothing is running. Your message starts a new run on this card, continuing the same conversation.'
      : 'Nothing is running. Your message starts a new run on this card, with a compacted transcript of this conversation.';
  }
  if (liveKind === 'steer') return `${agent} holds a live session: your message steers it while it works.`;
  if (liveKind === 'queue') return `${agent} holds a live session: your message is read after the current step, in the same conversation.`;
  return resumes
    ? 'This tool takes messages between runs: yours is delivered the moment the current run ends.'
    : 'This tool takes messages between runs: yours is delivered the moment the current run ends, as a new run with a compacted transcript of this conversation.';
}

export function composerPlaceholder(runActive: boolean, liveKind: 'steer' | 'queue' | undefined): string {
  return !runActive || liveKind === 'steer' ? 'Send a message...' : 'Queue a message...';
}
