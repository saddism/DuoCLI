import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { readNativeChatTranscript } from '../dist/main/native-chat/transcript-reader.js';
import { resolveSessionFilePath } from '../dist/main/native-chat/session-file-resolver.js';
import { readProviderDatabase, cursorMessageRefs } from '../dist/main/native-chat/provider-databases.js';
import { loadSessionChat } from '../dist/main/native-chat/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duocli-provider-regression-'));
const textOf = m => m.blocks.filter(b => b.type === 'text').map(b => b.text).join('');
const writeLog = (name, rows) => {
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  return file;
};

test('Qwen parts keep thoughts separate, preserve tool linkage and follow the active branch', async () => {
  const filePath = writeLog('qwen', [
    { uuid: 'u', parentUuid: null, type: 'user', message: { role: 'user', parts: [{ text: 'read audit.txt' }] } },
    { uuid: 'old', parentUuid: 'u', type: 'assistant', message: { role: 'model', parts: [{ text: 'abandoned answer' }] } },
    { uuid: 'a', parentUuid: 'u', type: 'assistant', message: { role: 'model', parts: [{ text: 'considering', thought: true }, { functionCall: { id: 'call1', name: 'read_file', args: { path: 'audit.txt' } } }, { text: '42' }] } },
    { uuid: 't', parentUuid: 'a', type: 'user', message: { role: 'user', parts: [{ functionResponse: { id: 'call1', response: { text: '42' } } }] } },
  ]);
  const result = await readNativeChatTranscript('qwen', 'id', { filePath });
  assert.deepEqual(result.messages.map(m => m.role), ['user', 'reasoning', 'assistant', 'tool']);
  assert.equal(textOf(result.messages[1]), 'considering');
  assert.equal(result.messages[2].blocks[0].callId, 'call1');
  assert.equal(result.messages[3].blocks[0].callId, 'call1');
  assert.doesNotMatch(JSON.stringify(result.messages), /abandoned/);
});

for (const agent of ['qoder', 'qodercn', 'claude']) {
  test(`${agent} excludes abandoned and sidechain turns, including after an appended rewind`, async () => {
    const filePath = writeLog(agent, [
      { type: 'user', uuid: 'u', parentUuid: null, message: { content: 'question' } },
      { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { content: 'old answer' } },
    ]);
    assert.equal((await readNativeChatTranscript(agent, 'id', { filePath })).messages.length, 2);
    fs.appendFileSync(filePath, [
      { type: 'assistant', uuid: 'b', parentUuid: 'u', message: { content: 'new answer' } },
      { type: 'assistant', uuid: 's', parentUuid: 'b', isSidechain: true, message: { content: 'subagent answer' } },
      { type: 'active-leaf', leafUuid: 'b' },
    ].map(JSON.stringify).join('\n') + '\n');
    const read = await readNativeChatTranscript(agent, 'id', { filePath });
    assert.deepEqual(read.messages.map(textOf), ['question', 'new answer']);
    fs.appendFileSync(filePath, JSON.stringify({ type: 'active-leaf', leafUuid: 'a' }) + '\n');
    assert.deepEqual((await readNativeChatTranscript(agent, 'id', { filePath })).messages.map(textOf), ['question', 'old answer']);
  });
}

test('Pi sessions use the recorded parent path and keep tool call ids', async () => {
  const filePath = writeLog('pi', [
    { type: 'session', id: 'session' },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'question' }] } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] } },
    { type: 'message', id: 'b', parentId: 'u', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'audit.txt' } }] } },
    { type: 'message', id: 'r', parentId: 'b', message: { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: '42' }] } },
  ]);
  const result = await readNativeChatTranscript('pi', 'id', { filePath });
  assert.doesNotMatch(JSON.stringify(result.messages), /abandoned/);
  assert.equal(result.messages[1].blocks[0].callId, 'c');
  assert.equal(result.messages[2].blocks[0].callId, 'c');
});

for (const [agent, envKey] of [['pi', 'PI_CODING_AGENT_DIR'], ['kimi', 'KIMI_CODE_HOME']]) {
  test(`${agent} loads JSONL from its configured storage directory`, async () => {
    const home = path.join(root, `${agent}-custom-home`);
    const sessionId = `${agent}-custom-session`;
    const directory = path.join(home, 'sessions', sessionId);
    fs.mkdirSync(directory, { recursive: true });
    const records = agent === 'pi'
      ? [{ type: 'session', id: sessionId }, { type: 'message', id: 'answer', parentId: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'custom storage answer' }] } }]
      : [{ role: 'assistant', content: 'custom storage answer' }];
    const filename = agent === 'pi' ? `${sessionId}.jsonl` : 'context.jsonl';
    fs.writeFileSync(path.join(directory, filename), records.map(JSON.stringify).join('\n') + '\n');
    const snapshot = await loadSessionChat(agent, sessionId, root, { [envKey]: home });
    assert.equal(snapshot.ready, true, snapshot.error);
    assert.deepEqual(snapshot.messages.map(textOf), ['custom storage answer']);
  });
}

test('Kimi joins streamed chunks without losing spaces and waits for complete JSONL', async () => {
  const filePath = writeLog('kimi', [
    { type: 'turn.prompt', input: [{ type: 'text', text: 'question' }], origin: { kind: 'user' } },
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'question' }], origin: { kind: 'user' } } },
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'injected' }], origin: { kind: 'injection' } } },
    { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step' } },
    { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step', part: { type: 'think', think: 'reason' } } },
    { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step', part: { type: 'text', text: 'hello ' } } },
  ]);
  const before = await readNativeChatTranscript('kimi', 'id', { filePath });
  assert.deepEqual(before.messages.map(textOf), ['question', 'reason', 'hello ']);
  const tail = JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'step', part: { type: 'text', text: 'world' } } });
  fs.appendFileSync(filePath, tail);
  assert.equal(textOf((await readNativeChatTranscript('kimi', 'id', { filePath })).messages.at(-1)), 'hello ');
  fs.appendFileSync(filePath, '\n');
  const after = await readNativeChatTranscript('kimi', 'id', { filePath });
  assert.equal(after.messages.at(-1).id, before.messages.at(-1).id);
  assert.equal(textOf(after.messages.at(-1)), 'hello world');
});

test('Gemini reads legacy documents and modern JSONL updates using the full session id', async () => {
  const dir = path.join(root, 'gemini', 'project', 'chats'); fs.mkdirSync(dir, { recursive: true });
  const message = { id: 'a', type: 'gemini', content: [{ text: 'answer' }], toolCalls: [{ id: 'c', name: 'read_file', args: {}, status: 'error', result: [{ text: 'missing' }] }] };
  const doc = path.join(dir, 'session-old-abc.json');
  fs.writeFileSync(doc, JSON.stringify({ sessionId: 'abc-full', messages: [message] }));
  assert.equal(await resolveSessionFilePath('gemini', 'abc', { providerRoot: path.join(root, 'gemini') }), null);
  assert.equal(await resolveSessionFilePath('gemini', 'abc-full', { providerRoot: path.join(root, 'gemini') }), doc);
  const legacy = await readNativeChatTranscript('gemini', 'abc-full', { filePath: doc });
  assert.equal(legacy.messages[0].blocks.at(-1).isError, true);
  const filePath = writeLog('gemini-modern', [
    { sessionId: 'new-id', kind: 'main' },
    { $set: { messages: [{ id: 'context', type: 'user', content: [{ text: '<session_context>injected</session_context>' }] }] } },
    { id: 'u', type: 'user', content: [{ text: 'question' }] },
    message,
    { id: 'a', type: 'gemini', content: [{ text: 'updated answer' }] },
  ]);
  assert.deepEqual((await readNativeChatTranscript('gemini', 'new-id', { filePath })).messages.map(textOf), ['question', 'updated answer']);
});

test('Kiro extracts only Prompt and AssistantMessage records', async () => {
  const filePath = writeLog('kiro', [
    { version: 1, kind: 'Prompt', data: { message_id: 'u', content: [{ kind: 'text', data: 'question' }], meta: { timestamp: 1700000000 } } },
    { version: 1, kind: 'AssistantMessage', data: { message_id: 'a', content: [{ kind: 'text', data: 'answer' }] } },
    { version: 1, kind: 'Usage', data: { content: [{ kind: 'text', data: 'internal' }] } },
  ]);
  const r = await readNativeChatTranscript('kiro', 'id', { filePath });
  assert.deepEqual(r.messages.map(textOf), ['question', 'answer']);
  assert.equal(r.messages[0].timestamp, 1700000000000);
});

test('Kiro preserves tool-use, tool-result and reasoning content kinds', async () => {
  const filePath = writeLog('kiro-tools', [
    { kind: 'AssistantMessage', data: { message_id: 'a', content: [{ kind: 'thinking', data: { text: 'reason', signature: 'hidden' } }, { kind: 'toolUse', data: { toolUseId: 'c', name: 'fs_read', input: { path: 'audit.txt' } } }] } },
    { kind: 'ToolResults', data: { message_id: 't', content: [{ kind: 'toolResult', data: { toolUseId: 'c', status: 'error', content: [{ kind: 'text', data: 'missing' }] } }] } },
  ]);
  const r = await readNativeChatTranscript('kiro', 'id', { filePath });
  assert.deepEqual(r.messages.map(m => m.role), ['reasoning', 'assistant', 'tool']);
  assert.equal(r.messages[1].blocks[0].callId, 'c');
  assert.equal(r.messages[2].blocks[0].callId, 'c');
  assert.equal(r.messages[2].blocks[0].output, 'missing');
  assert.equal(r.messages[2].blocks[0].isError, true);
  assert.doesNotMatch(JSON.stringify(r.messages), /hidden/);
});

test('Claude mixed thinking and answer become separate rows without losing branch identity', async () => {
  const filePath = writeLog('claude-thinking', [{ type: 'assistant', uuid: 'a', parentUuid: null, message: { content: [{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: 'answer' }] } }]);
  const r = await readNativeChatTranscript('claude', 'id', { filePath });
  assert.deepEqual(r.messages.map(m => m.role), ['reasoning', 'assistant']);
  assert.deepEqual(r.messages.map(textOf), ['reason', 'answer']);
});

test('Antigravity strips request wrappers and keeps reasoning/tool output out of the answer', async () => {
  const filePath = writeLog('agy', [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'injected context <USER_REQUEST>question</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', thinking: 'reason', tool_calls: [{ name: 'read_file', args: { path: 'audit.txt' } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: '42' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'answer' },
  ]);
  const r = await readNativeChatTranscript('agy', 'id', { filePath });
  assert.deepEqual(r.messages.map(m => m.role), ['user', 'reasoning', 'assistant', 'tool', 'assistant']);
  assert.equal(textOf(r.messages[0]), 'question');
  assert.equal(r.messages[3].blocks[0].output, '42');
  assert.doesNotMatch(JSON.stringify(r.messages), /injected context/);
});

test('resolver refuses ambiguous ids and keeps Pi distinct from OMP storage', async () => {
  const dir = path.join(root, 'projects');
  for (const name of ['a', 'b']) { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'same.jsonl'), '{}\n'); }
  assert.equal(await resolveSessionFilePath('qwen', 'same', { providerRoot: dir }), null);
  const file = path.join(dir, 'a', 'timestamp_pi-id.jsonl'); fs.writeFileSync(file, '{}\n');
  assert.equal(await resolveSessionFilePath('pi', 'pi-id', { providerRoot: dir }), file);
  fs.writeFileSync(file, '{"type":"session","id":"real-pi-header-id"}\n');
  assert.equal(await resolveSessionFilePath('pi', 'real-pi-header-id', { providerRoot: dir }), file);
});

test('native chat reads the PTY-specific config root rather than the desktop process root', async () => {
  const config = path.join(root, 'custom-claude');
  const dir = path.join(config, 'projects', '-tmp-custom'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-id.jsonl'), JSON.stringify({ type: 'user', uuid: 'u', message: { content: 'custom root' } }) + '\n');
  const r = await loadSessionChat('claude', 'session-id', '/tmp/custom', { CLAUDE_CONFIG_DIR: config });
  assert.equal(r.ready, true);
  assert.equal(textOf(r.messages[0]), 'custom root');
  const unbound = await loadSessionChat('devin', null);
  assert.equal(unbound.unbound, true);
});

let sqlite = true;
try { execFileSync('sqlite3', ['--version'], { stdio: 'ignore' }); } catch { sqlite = false; }
const sqlString = s => `'${String(s).replace(/'/g, "''")}'`;
function database(name, schema, inserts) {
  const file = path.join(root, `${name}.db`);
  execFileSync('sqlite3', [file], { input: schema + '\n' + inserts.join('\n') });
  return file;
}

test('Cursor follows root order, omits orphan blobs and unwraps genuine user queries', { skip: !sqlite }, async () => {
  const refs = ['1', '2', '3', '4'].map(c => c.repeat(64));
  const blobs = [
    { role: 'user', content: '<user_info>internal environment</user_info>' },
    { role: 'user', content: [{ type: 'text', text: '<system_reminder>ask mode</system_reminder>\n<user_query>question</user_query>' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'reason' }, { type: 'tool-call', toolName: 'read', args: { path: 'audit.txt' }, toolCallId: 'c' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'read', result: '42', toolCallId: 'c' }] },
  ];
  const rootBytes = Buffer.concat(refs.map(ref => Buffer.concat([Buffer.from([10, 32]), Buffer.from(ref, 'hex')])));
  assert.deepEqual(cursorMessageRefs(rootBytes), refs);
  assert.throws(() => cursorMessageRefs(Buffer.from([10, 32, 1])), /Incomplete/);
  const meta = Buffer.from(JSON.stringify({ agentId: 'cursor-id', latestRootBlobId: 'root' })).toString('hex');
  const file = database('cursor', 'CREATE TABLE meta(key TEXT,value TEXT); CREATE TABLE blobs(id TEXT,data BLOB);', [
    `INSERT INTO meta VALUES('0',${sqlString(meta)});`,
    `INSERT INTO blobs VALUES('root',X'${rootBytes.toString('hex')}');`,
    ...blobs.map((blob, i) => `INSERT INTO blobs VALUES(${sqlString(refs[i])},X'${Buffer.from(JSON.stringify(blob)).toString('hex')}');`),
    `INSERT INTO blobs VALUES('orphan',${sqlString(JSON.stringify({ role: 'assistant', content: 'abandoned' }))});`,
  ]);
  const r = await readProviderDatabase('cursor', 'cursor-id', file);
  assert.deepEqual(r.messages.map(m => m.role), ['user', 'reasoning', 'assistant', 'tool']);
  assert.equal(textOf(r.messages[0]), 'question');
  assert.equal(r.messages.at(-1).blocks[0].callId, 'c');
  assert.doesNotMatch(JSON.stringify(r.messages), /internal environment|ask mode|abandoned/);
  await assert.rejects(readProviderDatabase('cursor', 'wrong-id', file), /identity mismatch/);
});

for (const agent of ['opencode', 'zcode']) {
  test(`${agent} reads only the selected session and retains failed tool results`, { skip: !sqlite }, async () => {
    const file = database(agent, 'CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);', [
      `INSERT INTO message VALUES('u','wanted',1,'{"role":"user"}'),('a','wanted',2,'{"role":"assistant"}'),('x','other',3,'{"role":"assistant"}');`,
      `INSERT INTO part VALUES('p1','u','wanted',1,'{"type":"text","text":"question"}'),('p2','a','wanted',2,${sqlString(JSON.stringify({ type: 'tool', tool: 'read', callID: 'c', state: { status: 'error', input: {}, error: 'missing' } }))}),('px','x','other',3,'{"type":"text","text":"foreign"}');`,
    ]);
    const r = await readProviderDatabase(agent, 'wanted', file);
    assert.equal(textOf(r.messages[0]), 'question');
    assert.equal(r.messages[1].blocks[0].state, 'failed');
    assert.equal(r.messages[1].blocks[1].isError, true);
    assert.doesNotMatch(JSON.stringify(r.messages), /foreign/);
  });
}

test('Devin follows main_chain_id and suppresses injected user context', { skip: !sqlite }, async () => {
  const row = (node, parent, role, text, user = false) => `INSERT INTO message_nodes VALUES(${node},'session',${node},${parent ?? 'NULL'},${sqlString(JSON.stringify({ role, content: text, metadata: { is_user_input: user } }))},1700000000000,'null');`;
  const file = database('devin', 'CREATE TABLE sessions(id TEXT,main_chain_id INTEGER); CREATE TABLE message_nodes(row_id INTEGER,session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER,metadata TEXT);', [
    "INSERT INTO sessions VALUES('session',4);", row(1, null, 'user', 'injected'), row(2, 1, 'user', 'question', true), row(3, 2, 'assistant', 'abandoned'), row(4, 2, 'assistant', 'answer'),
  ]);
  assert.deepEqual((await readProviderDatabase('devin', 'session', file)).messages.map(textOf), ['question', 'answer']);
});

test('ZCode follows explicit part sequence when timestamps and ids disagree', { skip: !sqlite }, async () => {
  const file = database('zcode-sequence', 'CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT,sequence INTEGER); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT,sequence INTEGER);', [
    `INSERT INTO message VALUES('a','s',1,'{"role":"assistant"}',1);`,
    `INSERT INTO part VALUES('p-a','a','s',1,'{"type":"text","text":"second"}',2),('p-z','a','s',1,'{"type":"text","text":"first"}',1);`,
  ]);
  assert.equal(textOf((await readProviderDatabase('zcode', 's', file)).messages[0]), 'firstsecond');
});

test('Codex combines completed and realtime items by stable id and notices WAL updates', { skip: !sqlite }, async () => {
  const file = database('codex', 'CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,item_json TEXT,created_at_ms INTEGER,rollout_ordinal INTEGER); CREATE TABLE thread_realtime_items(thread_id TEXT,item_id TEXT,item_json TEXT,created_at_ms INTEGER,rollout_ordinal INTEGER);', [
    `INSERT INTO thread_items VALUES('thread','u',${sqlString(JSON.stringify({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'question' }] }))},1700000000000,1);`,
    `INSERT INTO thread_realtime_items VALUES('thread','a',${sqlString(JSON.stringify({ type: 'agentMessage', id: 'a', text: 'partial' }))},1700000000001,2);`,
  ]);
  const before = await readProviderDatabase('codex', 'thread', file);
  const writer = spawn('sqlite3', [file], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const ready = new Promise((resolve, reject) => {
      writer.stdout.on('data', data => { if (data.toString().includes('READY')) resolve(); });
      writer.on('error', reject);
    });
    writer.stdin.write(`PRAGMA journal_mode=WAL; UPDATE thread_realtime_items SET item_json=${sqlString(JSON.stringify({ type: 'agentMessage', id: 'a', text: 'complete answer' }))} WHERE item_id='a'; SELECT 'READY';\n`);
    await ready;
    const after = await readProviderDatabase('codex', 'thread', file);
    assert.notEqual(after.revision, before.revision);
    assert.equal(after.messages.at(-1).id, before.messages.at(-1).id);
    assert.equal(textOf(after.messages.at(-1)), 'complete answer');
    assert.equal(after.messages.length, 2);
  } finally { writer.stdin.end(); }
});
