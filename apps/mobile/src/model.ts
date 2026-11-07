import type { AgentEvent } from '@bento/core';
import type { QuestionChoice, RunQuestion } from '@bento/api-client';

export function serverOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter an HTTPS server address without a path, password, or query.');
  }
  return url.origin;
}

export function verificationUrl(origin: string, value: string): string {
  const url = new URL(value, origin);
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('The server returned an unexpected sign-in address.');
  }
  return url.href;
}

export function answersReady(request: RunQuestion, answers: QuestionChoice[]): boolean {
  return request.questions.every((q, i) => {
    const answer = answers[i];
    return answer?.question === q.question &&
      (answer.selected.length > 0 || Boolean(answer.other?.trim())) &&
      (q.multiSelect || answer.selected.length + (answer.other?.trim() ? 1 : 0) <= 1) &&
      answer.selected.every(label => q.options.some(option => option.label === label));
  });
}

export function eventText(event: AgentEvent): string {
  switch (event.type) {
    case 'message': return event.text;
    case 'tool': return `${event.phase === 'start' ? 'Using' : 'Finished'} ${event.name}`;
    case 'result': return event.error || (event.interrupted ? 'Turn interrupted' : event.ok ? 'Turn complete' : 'Run failed');
    case 'init': return event.model ? `Connected to ${event.model}` : 'Agent connected';
  }
}

export function mergeEvent<T>(events: { seq: number; event: T }[], seq: number, event: T) {
  if (events.some(item => item.seq === seq)) return events;
  return [...events, { seq, event }].sort((a, b) => a.seq - b.seq);
}
