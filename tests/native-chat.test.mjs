import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeClaudeTranscriptLine } from '../dist/main/native-chat/transcript-line-decoders-claude.js';
import { decodeCodexTranscriptLine } from '../dist/main/native-chat/transcript-line-decoders-codex.js';
import { decodeGrokTranscriptLine } from '../dist/main/native-chat/transcript-line-decoders-grok.js';
import { decodeOmpTranscriptLine } from '../dist/main/native-chat/transcript-line-decoders-omp.js';
import { nativeChatAgentFromCli, resolveSessionFilePath } from '../dist/main/native-chat/session-file-resolver.js';
import { readNativeChatTranscript } from '../dist/main/native-chat/transcript-reader.js';
import { loadSessionChat } from '../dist/main/native-chat/index.js';

test('native chat maps Orca transcript agents and ignores other DuoCLI clis', () => {
  assert.equal(nativeChatAgentFromCli('claude'), 'claude');
  assert.equal(nativeChatAgentFromCli('codex'), 'codex');
  assert.equal(nativeChatAgentFromCli('grok'), 'grok');
  assert.equal(nativeChatAgentFromCli('omp'), 'omp');
  assert.equal(nativeChatAgentFromCli('pi'), 'pi');
  assert.equal(nativeChatAgentFromCli('gemini'), 'gemini');
  assert.equal(nativeChatAgentFromCli('dsh'), null);
});

test('claude JSONL user and assistant lines become chat messages', () => {
  const user = decodeClaudeTranscriptLine(JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-09-17T00:00:00.000Z',
    message: { content: [{ type: 'text', text: 'fix the login' }] },
  }), 'fallback');
  const assistant = decodeClaudeTranscriptLine(JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-09-17T00:00:01.000Z',
    message: { content: [{ type: 'text', text: 'I will inspect the route.' }] },
  }), 'fallback');
  assert.equal(user.role, 'user');
  assert.equal(user.blocks[0].text, 'fix the login');
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.blocks[0].text, 'I will inspect the route.');
});

test('grok and omp JSONL user turns decode', () => {
  const grok = decodeGrokTranscriptLine(JSON.stringify({
    type: 'user',
    id: 'g1',
    timestamp: '2026-09-17T00:00:00.000Z',
    content: [{ type: 'text', text: 'from grok' }],
  }), 'fallback');
  const omp = decodeOmpTranscriptLine(JSON.stringify({
    type: 'message',
    id: 'o1',
    timestamp: '2026-09-17T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'from omp' }] },
  }), 'fallback');
  assert.equal(grok.role, 'user');
  assert.equal(grok.blocks[0].text, 'from grok');
  assert.equal(omp.role, 'user');
  assert.equal(omp.blocks[0].text, 'from omp');
});

test('codex JSONL event_msg user_message decodes', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-09-17T00:00:00.000Z',
    payload: {
      id: 'c1',
      type: 'user_message',
      message: 'ship the patch',
    },
  });
  const message = decodeCodexTranscriptLine(line, 'fallback');
  assert.equal(message.role, 'user');
  assert.equal(message.blocks[0].text, 'ship the patch');
});

test('codex response_item decodes input/output text and correlates tool results', () => {
  const user = decodeCodexTranscriptLine(JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'from input block' }],
  } }), 'u');
  const assistant = decodeCodexTranscriptLine(JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'from output block' }],
  } }), 'a');
  const result = decodeCodexTranscriptLine(JSON.stringify({ type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'call-1', output: 'done',
  } }), 'r');
  assert.equal(user.blocks[0].text, 'from input block');
  assert.equal(assistant.blocks[0].text, 'from output block');
  assert.equal(result.blocks[0].callId, 'call-1');
});

test('transcript reader appends complete records and waits for a partial tail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-chat-incremental-'));
  const file = path.join(root, 'incremental.jsonl');
  const first = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'first' } });
  const second = JSON.stringify({ type: 'assistant', uuid: 'a1', message: { content: 'second' } });
  fs.writeFileSync(file, `${first}\n${second.slice(0, 20)}`);
  const initial = await readNativeChatTranscript('claude', 'ignored', { filePath: file });
  assert.equal(initial.messages.length, 1);
  fs.appendFileSync(file, `${second.slice(20)}\n`);
  const appended = await readNativeChatTranscript('claude', 'ignored', { filePath: file });
  assert.deepEqual(appended.messages.map(message => message.blocks[0].text), ['first', 'second']);
  assert.notEqual(appended.revision, initial.revision);
});

test('resolver uses the Claude cwd slug before walking other projects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-chat-slug-'));
  const cwd = '/Users/demo/app';
  const decoy = path.join(root, 'other-project');
  const project = path.join(root, '-Users-demo-app');
  fs.mkdirSync(decoy);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(decoy, 'abc.jsonl'), `${JSON.stringify({
    type: 'user',
    uuid: 'wrong',
    message: { content: 'decoy' },
  })}\n`);
  const file = path.join(project, 'abc.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'user',
    uuid: 'u1',
    message: { content: 'from slug' },
  })}\n`);
  const resolved = await resolveSessionFilePath('claude', 'abc', { claudeProjectsDir: root, cwd });
  assert.equal(resolved, file);
});

test('resolver finds a Claude transcript by session id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-chat-'));
  const project = path.join(root, 'my-project');
  fs.mkdirSync(project);
  const file = path.join(project, 'sess-123.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'user',
    uuid: 'u1',
    message: { content: 'hello from disk' },
  })}\n`);
  const resolved = await resolveSessionFilePath('claude', 'sess-123', { claudeProjectsDir: root });
  assert.equal(resolved, file);
  const read = await readNativeChatTranscript('claude', 'sess-123', { claudeProjectsDir: root });
  assert.equal('messages' in read, true);
  assert.equal(read.messages[0].blocks[0].text, 'hello from disk');
  const unsupported = await loadSessionChat('dsh', 'sess-123');
  assert.equal(unsupported.supported, false);
});
