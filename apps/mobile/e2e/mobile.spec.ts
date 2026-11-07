import { test, expect } from '@playwright/test';

test('sign in, create a card, stream output, answer, approve, switch teams, expire session', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let team = 'team-a';
  let expired = false;
  let answered = false;
  let approved = false;
  let postedAnswer: unknown;
  let postedMessage: unknown;
  const card = { id: 'card-1', projectId: 'project-1', title: 'Ship mobile', description: 'Build the iOS app', status: 'gated', currentStageId: 'stage-1', branchName: 'mobile', prNumber: null };
  const run = { id: 'run-1', featureId: card.id, stageId: 'stage-1', agentProfileId: 'agent-1', status: 'running', queuedAt: '', startedAt: '', endedAt: null };
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  await page.route('https://app.usebento.ai/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path === '/api/auth/device/code') return json({ device_code: 'device', user_code: 'ABCD', verification_uri: '/device', expires_in: 60, interval: 1 });
    if (path === '/api/auth/device/token') return json({ access_token: 'test-token' });
    if (path === '/device') return route.fulfill({ body: 'Approved', headers });
    expect(request.headers().authorization).toBe('Bearer test-token');
    if (expired) return json({ error: 'Session expired' }, 401);
    if (path === '/api/auth/get-session') return json({ user: { id: 'person', name: 'Daniel' }, session: { id: 'session', activeOrganizationId: team } });
    if (path === '/api/auth/organization/list') return json([{ id: 'team-a', name: 'Bento team' }, { id: 'team-b', name: 'Other team' }]);
    if (path === '/api/auth/organization/set-active') { team = request.postDataJSON().organizationId; return json({}); }
    if (path === '/api/projects') return json(team === 'team-a' ? [{ id: 'project-1', name: 'Bento project' }] : []);
    if (path === '/api/projects/project-1/pipeline') return json({ id: 'pipeline', name: 'Pipeline', stages: [{ id: 'stage-1', name: 'Review' }] });
    if (path === '/api/projects/project-1/board/plain') return route.fulfill({ headers, body: 'feature|card-1|||running|||Ready for review' });
    if (path === '/api/board/project-1/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ': connected\n\n' });
    if (path === '/api/features' && request.method() === 'POST') { expect(request.postDataJSON().title).toBe('Ship mobile'); return json(card); }
    if (path === '/api/features') return json([card]);
    if (path === '/api/features/card-1') return json({ ...card, status: approved ? 'done' : card.status, runs: approved ? [] : [run], pullRequests: [] });
    if (path === '/api/features/card-1/conversation') return json({ blocks: [], pending: [] });
    if (path === '/api/features/card-1/message') { postedMessage = request.postDataJSON(); return json({ queued: true }); }
    if (path === '/api/features/card-1/approve') { approved = true; return json({ feature: { ...card, status: 'done' }, gateChecks: [] }); }
    if (path === '/api/runs/run-1/questions') return json(answered ? [] : [{ id: 'question-1', runId: 'run-1', createdAt: '', questions: [{ question: 'Which release?', multiSelect: false, options: [{ label: 'TestFlight', description: 'Start with beta testers' }, { label: 'App Store' }] }] }]);
    if (path === '/api/runs/run-1/questions/question-1/answer') { postedAnswer = request.postDataJSON(); answered = true; return json({ answered: true }); }
    if (path === '/api/runs/run-1/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: 'id: 1\nevent: run_event\ndata: {"type":"message","role":"assistant","text":"The iOS app is ready for review."}\n\n' });
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });
  await page.goto('/');
  await expect(page.getByText('Keep good work moving.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to Bento', exact: true }).click();
  await expect(page.getByText('Your projects', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open project' }).click();
  await page.getByRole('button', { name: '+ New card', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Ship mobile');
  await page.getByRole('textbox', { name: 'Instructions' }).fill('Build the iOS app');
  await page.getByRole('button', { name: 'Create card', exact: true }).click();
  await expect(page.getByText('Which release?')).toBeVisible();
  await expect(page.getByText('The iOS app is ready for review.')).toBeVisible();
  await page.getByRole('button', { name: 'TestFlight', exact: true }).click();
  await page.getByRole('button', { name: 'Send answers' }).click();
  await expect(page.getByText('Which release?')).toHaveCount(0);
  expect(postedAnswer).toEqual({ answers: [{ question: 'Which release?', selected: ['TestFlight'], other: '' }] });
  await page.getByRole('textbox', { name: 'Message your agent' }).fill('Include accessibility checks');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Message queued for your agent.')).toBeVisible();
  expect(postedMessage).toEqual({ text: 'Include accessibility checks' });
  await page.getByRole('button', { name: 'Approve stage' }).click();
  await expect(page.getByText('DONE', { exact: true })).toBeVisible();
  await page.goBack();
  await page.goBack();
  await page.getByRole('button', { name: 'Other team', exact: true }).click();
  await expect(page.getByText('No projects yet', { exact: true })).toBeVisible();
  await expect(page.getByText('Bento project', { exact: true })).toHaveCount(0);
  expired = true;
  await page.getByRole('button', { name: 'Refresh projects' }).click();
  await expect(page.getByText('Keep good work moving.')).toBeVisible();
  expect(errors).toEqual([]);
});
