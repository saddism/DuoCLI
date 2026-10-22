import assert from 'node:assert/strict';
import test from 'node:test';
import { trackChatSubmissions } from '../dist/main/native-chat/submission-tracking.js';

const user = (id, timestamp, text = '继续') => ({ id, timestamp, role: 'user', source: 'transcript', blocks: [{ type: 'text', text }] });
const entry = (createdAt, phase = 'entered') => ({ createdAt, phase, text: '继续' });

test('an identical later submission cannot claim a previous transcript turn', () => {
  const submissions = new Map([['first', entry(100)], ['second', entry(200)]]);
  const partial = trackChatSubmissions([user('old', 50), user('one', 120)], submissions);
  assert.deepEqual(partial.map(message => message.submissionId), [undefined, 'first']);
  const full = trackChatSubmissions([user('old', 50), user('one', 120), user('two', 220)], submissions);
  assert.deepEqual(full.map(message => message.submissionId), [undefined, 'first', 'second']);
});

test('unknown timestamps and writes awaiting Enter are not delivery acknowledgements', () => {
  const messages = [user('unknown', null), user('current', 150)];
  const pending = new Map([['one', entry(100, 'text')]]);
  assert.ok(trackChatSubmissions(messages, pending).every(message => !message.submissionId));
  pending.set('one', entry(100));
  assert.deepEqual(trackChatSubmissions(messages, pending).map(message => message.submissionId), [undefined, 'one']);
  assert.ok(messages.every(message => !message.submissionId));
});
