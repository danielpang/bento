import type { QuestionChoice, RunQuestion } from '@bento/api-client';

/** HTTPS only, except that a development build may also reach a local server over plain HTTP. */
export function serverOrigin(value: string, options: { allowHttp?: boolean } = {}): string {
  const url = new URL(value.trim());
  const httpAllowed = options.allowHttp && url.protocol === 'http:';
  if ((url.protocol !== 'https:' && !httpAllowed) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enter an HTTPS server address without a path, password, or query.');
  }
  return url.origin;
}

export function verificationUrl(origin: string, value: string): string {
  const url = new URL(value, origin);
  if (url.origin !== origin || url.protocol !== new URL(origin).protocol || url.username || url.password) {
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


export function mergeEvent<T>(events: { seq: number; event: T }[], seq: number, event: T) {
  if (events.some(item => item.seq === seq)) return events;
  return [...events, { seq, event }].sort((a, b) => a.seq - b.seq);
}
