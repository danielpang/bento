import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answersReady, mergeEvent, serverOrigin, verificationUrl } from './model.js';

test('credentials can only be bound to an HTTPS origin', () => {
  assert.equal(serverOrigin(' https://app.usebento.ai/ '), 'https://app.usebento.ai');
  for (const input of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com?token=secret', 'https://example.com/#other', 'invalid']) {
    assert.throws(() => serverOrigin(input));
  }
});
test('only a development build may reach a server over plain HTTP', () => {
  assert.equal(serverOrigin('http://192.168.2.90:4410', { allowHttp: true }), 'http://192.168.2.90:4410');
  assert.throws(() => serverOrigin('http://192.168.2.90:4410'));
  assert.throws(() => serverOrigin('ftp://example.com', { allowHttp: true }));
  assert.throws(() => verificationUrl('http://192.168.2.90:4410', 'https://192.168.2.90:4410/device'));
});
test('device authorization cannot send a person to another origin', () => {
  const origin = 'https://app.usebento.ai';
  assert.equal(verificationUrl(origin, '/device?user_code=ABCD'), origin + '/device?user_code=ABCD');
  for (const url of ['https://evil.test/device', '//evil.test', 'javascript:alert(1)', 'https://user:pass@app.usebento.ai']) assert.throws(() => verificationUrl(origin, url));
});
test('question answers obey the server single-choice contract', () => {
  const request = { id: 'q', runId: 'r', createdAt: '', questions: [{ question: 'Deploy?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }] };
  const answer = { question: 'Deploy?', selected: ['Yes'] };
  assert.equal(answersReady(request, []), false);
  assert.equal(answersReady(request, [answer]), true);
  assert.equal(answersReady(request, [{ ...answer, other: 'Also do this' }]), false);
  assert.equal(answersReady(request, [{ ...answer, selected: [], other: 'Later' }]), true);
  assert.equal(answersReady(request, [{ ...answer, selected: ['Unknown'] }]), false);
  assert.equal(answersReady(request, [{ ...answer, selected: ['Yes', 'No'] }]), false);
  assert.equal(answersReady({ ...request, questions: [{ ...request.questions[0], multiSelect: true }] }, [{ ...answer, selected: ['Yes', 'No'] }]), true);
});
test('replayed stream events are deduplicated by sequence and ordered', () => {
  const events = [{ seq: 2, event: 'second' }];
  assert.equal(mergeEvent(events, 2, 'duplicate'), events);
  assert.deepEqual(mergeEvent(events, 1, 'first'), [{ seq: 1, event: 'first' }, { seq: 2, event: 'second' }]);
});
