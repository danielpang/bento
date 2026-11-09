import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Feature, Stage } from '@bento/api-client';
import { ago, boardLanes, cardState, composerHint, initials, kindExt, matchesQuery, runLiveKind, stateLabel, toChatItems } from './board-model.js';

const feature = (patch: Partial<Feature>): Feature => ({ id: 'f', projectId: 'p', title: 'Card', description: '', status: 'active', currentStageId: null, branchName: null, prNumber: null, ...patch });
const stage = (id: string, position: number): Stage => ({ id, pipelineId: 'pl', position, name: `Stage ${id}`, slug: id, description: '', defaultAgentProfileId: null, gateType: 'manual', gateCriteria: {} as Stage['gateCriteria'], createPr: false });

test('a card reads as the web board reads it', () => {
  assert.equal(cardState(feature({ status: 'done' }), 'running'), 'done');
  assert.equal(cardState(feature({ status: 'gated' }), 'running'), 'running');
  assert.equal(cardState(feature({ status: 'gated' }), 'succeeded'), 'gated');
  assert.equal(cardState(feature({}), 'failed'), 'failed');
  assert.equal(cardState(feature({}), undefined), 'idle');
  assert.equal(stateLabel('gated'), 'pending approval');
  assert.equal(stateLabel('idle'), 'not started');
});

test('lanes hold backlog, each stage, and completed, leaving sessions off the board', () => {
  const cards = [
    feature({ id: 'a', currentStageId: null, status: 'backlog' }),
    feature({ id: 'b', currentStageId: 's1' }),
    feature({ id: 'c', currentStageId: 's1', status: 'done' }),
    feature({ id: 'd', currentStageId: null, status: 'backlog', standalone: true }),
  ];
  const lanes = boardLanes(cards, [stage('s1', 0), stage('s2', 1)], '');
  assert.deepEqual(lanes.map(lane => [lane.ordinal, lane.cards.map(card => card.id)]), [['00', ['a']], ['01', ['b']], ['02', []], ['03', ['c']]]);
});

test('search finds a ticket id however it was typed', () => {
  const card = { title: 'ENG-441 rate limits', description: '' };
  assert.equal(matchesQuery(card, 'eng441'), true);
  assert.equal(matchesQuery(card, 'eng 441'), true);
  assert.equal(matchesQuery(card, 'rate ENG-441'), true);
  assert.equal(matchesQuery(card, '-'), true);
  assert.equal(matchesQuery(card, 'auth'), false);
});

test('a run folds into bubbles, one row per burst of tools, and a result', () => {
  const items = toChatItems([
    { type: 'init', model: 'm' },
    { type: 'message', role: 'user', text: 'Do it' },
    { type: 'tool', name: 'Read', phase: 'start', detail: { file_path: 'a.ts' } },
    { type: 'tool', name: 'Read', phase: 'end' },
    { type: 'tool', name: 'Bash', phase: 'start', detail: { command: 'pnpm test\nmore' } },
    { type: 'message', role: 'assistant', text: 'Done' },
    { type: 'result', ok: true, costUsd: 0.42 },
  ], 'Engineer', 'r');
  assert.deepEqual(items.map(item => item.kind), ['message', 'tools', 'message', 'result']);
  assert.deepEqual(items[1].kind === 'tools' && items[1].calls, [{ name: 'Read', summary: 'a.ts' }, { name: 'Bash', summary: 'pnpm test' }]);
  assert.equal(items[0].kind === 'message' && items[0].speaker, 'you');
  assert.equal(items[2].kind === 'message' && items[2].speaker, 'Engineer');
});

test('the composer says what a message will do', () => {
  assert.match(composerHint(false, undefined, 'Engineer', true), /^Nothing is running/);
  assert.match(composerHint(true, runLiveKind('claude-code', true), 'Engineer', true), /^Engineer holds a live session: your message is read after the current step/);
  assert.match(composerHint(true, runLiveKind('codex', null), 'Engineer', true), /^This tool takes messages between runs/);
});

test('small labels', () => {
  assert.equal(initials('Staff Engineer'), 'SE');
  assert.equal(initials('reviewer'), 'RE');
  assert.equal(kindExt('markdown'), 'MD');
  assert.equal(kindExt('image', 'shot.png'), 'PNG');
  assert.equal(kindExt('file', 'Makefile'), 'FILE');
  const now = Date.parse('2026-11-08T12:00:00Z');
  assert.equal(ago('2026-11-08T11:57:00Z', now), '3m ago');
  assert.equal(ago('2026-11-08T09:00:00Z', now), '3h ago');
});
