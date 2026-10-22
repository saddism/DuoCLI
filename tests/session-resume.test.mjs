import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResumeCommand,
  evaluateRestoreProgress,
  identifyCli,
  isResumeCommandCompatible,
  parseResumeOutput,
  parseResumeCommandLine,
  preassignSessionId,
  preassignPiSession,
  pickSession,
  pickCodexLockOwner,
} from '../dist/main/session-resume.js';

test('identifies all built-in CLI families', () => {
  const cases = [
    ['claude --dangerously-skip-permissions', 'claude'],
    ['codex --full-auto', 'codex'],
    ['devin --permission-mode bypass', 'devin'],
    ['kimi --auto', 'kimi'],
    ['gemini --yolo', 'gemini'],
    ['qwen --yolo', 'qwen'],
    ['pi', 'pi'],
    ['dsh tui', 'dsh'],
    ['qodercli --dangerously-skip-permissions', 'qoder'],
    ['qoder --dangerously-skip-permissions', 'qoder'],
    ['qoder chat --dangerously-skip-permissions', 'qoder'],
    ['qodercn --dangerously-skip-permissions', 'qodercn'],
    ['qoderclicn --dangerously-skip-permissions', 'qodercn'],
    ['opencode', 'opencode'],
    ['kiro-cli chat --trust-all-tools', 'kiro'],
    ['agent --force --approve-mcps', 'cursor'],
    ['agy --dangerously-skip-permissions', 'agy'],
    ['dsh-tui', 'dsh'],
    ['DSH_URL=http://127.0.0.1:58084 dsh-tui', 'dsh'],
    ['zcode', 'zcode'],
    ['/usr/local/bin/zcode', 'zcode'],
  ];
  for (const [command, expected] of cases) assert.equal(identifyCli(command), expected);
});

test('builds provider-specific resume commands', () => {
  const id = '01a0746d-d932-7343-a33a-1e9f637701ad';
  assert.equal(buildResumeCommand('claude --dangerously-skip-permissions', id), `claude --dangerously-skip-permissions --resume ${id}`);
  assert.equal(buildResumeCommand('codex -c approval="never"', id), `codex -c approval="never" resume ${id}`);
  assert.equal(buildResumeCommand('kimi --auto', 'session_abc'), 'kimi --auto -S session_abc');
  assert.equal(buildResumeCommand('kimi --session old-session --auto', 'session_abc'), 'kimi --auto -S session_abc');
  assert.equal(buildResumeCommand('opencode', 'ses_abc'), 'opencode -s ses_abc');
  assert.equal(buildResumeCommand('opencode --session=ses_old --verbose', 'ses_abc'), 'opencode --verbose -s ses_abc');
  assert.equal(buildResumeCommand('agent --force --approve-mcps', id), `agent --force --approve-mcps --resume=${id}`);
  assert.equal(buildResumeCommand('agy --dangerously-skip-permissions', id), `agy --dangerously-skip-permissions --conversation ${id}`);
  assert.equal(buildResumeCommand('dsh-tui', 'session-abc'), 'dsh-tui --resume session-abc');
  assert.equal(buildResumeCommand('zcode', id), '');
  assert.equal(buildResumeCommand('zcode --mode plan', 'sess_abc'), 'zcode --mode plan --resume sess_abc');
  assert.equal(buildResumeCommand('qwen --yolo', id), `qwen --yolo --resume ${id}`);
  assert.equal(buildResumeCommand('pi', id), `pi --session ${id}`);
  assert.equal(isResumeCommandCompatible('cursor-agent', `cursor-agent --resume=${id}`), true);
});

test('Pi allocates an explicit new session path and preserves user-selected session modes', () => {
  const result = preassignPiSession('pi --offline', 'new-id', '/tmp/project with spaces', '/tmp/pi-agent');
  assert.equal(result.capture.sessionId, '/tmp/pi-agent/sessions/--tmp-project with spaces--/duocli_new-id.jsonl');
  assert.equal(parseResumeCommandLine(result.command).sessionId, result.capture.sessionId);
  const quoted = preassignPiSession('pi --offline', 'id', "/tmp/parent's folder", '/tmp/pi-agent');
  assert.equal(parseResumeCommandLine(quoted.command).sessionId, quoted.capture.sessionId);
  assert.equal(buildResumeCommand(result.command, 'actual-id'), 'pi --offline --session actual-id');
  assert.equal(buildResumeCommand(quoted.command, 'actual-id'), 'pi --offline --session actual-id');
  for (const command of ['pi --continue', 'pi --resume', 'pi -r', 'pi --no-session', 'pi --session existing', 'pi --session-dir /tmp/custom']) {
    assert.deepEqual(preassignPiSession(command, 'id', '/tmp/cwd'), { command, capture: null });
  }
  assert.equal(preassignSessionId('qwen --yolo', 'id').capture.cli, 'qwen');
  assert.equal(parseResumeCommandLine('zcode --resume sess_abc').sessionId, 'sess_abc');
});

test('preassigns IDs only for CLIs that support it', () => {
  const id = '4724aff8-777b-426e-8849-0b8bde7eafd7';
  const claude = preassignSessionId('claude --dangerously-skip-permissions', id);
  assert.match(claude.command, /--session-id/);
  assert.equal(claude.capture?.sessionId, id);
  const codex = preassignSessionId('codex --full-auto', id);
  assert.equal(codex.command, 'codex --full-auto');
  assert.equal(codex.capture, null);
  const zcode = preassignSessionId('zcode', id);
  assert.equal(zcode.command, 'zcode');
  assert.equal(zcode.capture, null);
});

test('parses ANSI and line-wrapped close hints', () => {
  const id = 'f9c9e8b1-64bf-47c0-87af-d0bed98ae901';
  const result = parseResumeOutput(`To resume this session: qoderclicn --resume\n${id}`, 'qodercn --dangerously-skip-permissions');
  assert.equal(result?.sessionId, id);
  assert.equal(result?.resumeCommand, `qodercn --dangerously-skip-permissions --resume ${id}`);
  const intl = parseResumeOutput(`To resume this session: qodercli --resume\n${id}`, 'qodercli --dangerously-skip-permissions');
  assert.equal(intl?.cli, 'qoder');
  assert.equal(intl?.sessionId, id);
  assert.equal(intl?.resumeCommand, `qodercli --dangerously-skip-permissions --resume ${id}`);
  const kimi = parseResumeOutput('\x1b[2KTo resume this session: kimi -r session_abc', 'kimi --auto');
  assert.equal(kimi?.sessionId, 'session_abc');
  const opencode = parseResumeCommandLine('opencode --session ses_long_alias');
  assert.equal(opencode?.sessionId, 'ses_long_alias');
});

test('does not fall back to an invalid generic resume flag', () => {
  const id = '01a0746d-d932-7343-a33a-1e9f637701ad';
  assert.equal(buildResumeCommand('unknown-cli --safe', id), '');
  assert.equal(isResumeCommandCompatible('codex --full-auto', `codex --full-auto --resume '${id}'`), false);
  assert.equal(parseResumeCommandLine(`codex --full-auto resume '${id}'`)?.sessionId, id);
});

test('does not guess a newer or ambiguous registry session', () => {
  const cwd = '/tmp/duocli-resume-test';
  const createdAt = 1_700_000_000_000;
  const exact = { id: 'session-created-for-this-pty', cwd, createdAt: createdAt + 1_000 };
  const newer = { id: 'newer-session', cwd, createdAt: createdAt + 10_000 };
  assert.equal(pickSession([newer, exact], cwd, createdAt, item => item.id), exact.id);
  assert.equal(pickSession([exact, { id: 'concurrent-session', cwd, createdAt: createdAt + 2_000 }], cwd, createdAt, item => item.id), null);
  assert.equal(pickSession([
    { id: 'one', cwd, createdAt: createdAt + 1_000 },
    { id: 'two', cwd, createdAt: createdAt + 1_100 },
  ], cwd, createdAt, item => item.id), null);
  assert.equal(pickSession([{ id: 'without-time', cwd }], cwd, createdAt, item => item.id), null);
});

test('restore confirmation waits for a real error window and does not treat echo as success', () => {
  const echoed = { sentAt: 1_000, commandEchoed: true, output: 'uuid\r\n', returnedToShell: false };
  assert.equal(evaluateRestoreProgress(echoed, 1_300), 'pending');
  assert.equal(evaluateRestoreProgress(echoed, 3_600), 'success');
  assert.equal(evaluateRestoreProgress({
    sentAt: 1_000,
    commandEchoed: true,
    output: 'session not found',
    returnedToShell: false,
  }, 3_600), 'failure');
  assert.equal(evaluateRestoreProgress({
    sentAt: 1_000,
    commandEchoed: true,
    output: 'ok',
    returnedToShell: true,
  }, 3_600), 'failure');
});

test('binds a Codex thread only when its writer belongs to this PTY', () => {
  const owners = [
    { id: 'other-app', pid: 50 },
    { id: 'this-terminal', pid: 30 },
  ];
  const parents = new Map([[30, 20], [20, 10], [50, 1]]);
  assert.equal(pickCodexLockOwner(owners, 10, (pid) => parents.get(pid)), 'this-terminal');
  assert.equal(pickCodexLockOwner([
    { id: 'a', pid: 30 },
    { id: 'b', pid: 31 },
  ], 10, (pid) => new Map([[30, 10], [31, 10]]).get(pid)), null);
});

test('accepts machine-readable IDs from headless event streams', () => {
  const codex = parseResumeOutput('{"type":"thread.started","thread_id":"01a0746d-d932-7343-a33a-1e9f637701ad"}', 'codex --full-auto');
  assert.equal(codex?.sessionId, '01a0746d-d932-7343-a33a-1e9f637701ad');
  const opencode = parseResumeOutput('{"type":"session.created","sessionID":"ses_abc123"}', 'opencode');
  assert.equal(opencode?.resumeCommand, 'opencode -s ses_abc123');
  const agy = parseResumeOutput('{"conversation_id":"58382afa-0fbe-48d9-9f47-e84c68c8de04"}', 'agy --dangerously-skip-permissions');
  assert.equal(agy?.sessionId, '58382afa-0fbe-48d9-9f47-e84c68c8de04');
});

test('Codex resume hints reject ordinary TUI words and incomplete thread IDs', () => {
  for (const id of ['Worked', '--last', '01a0746d-d932', '01a0746d-d932-7343-a33a-1e9f637701ad-extra']) {
    assert.equal(parseResumeOutput(`codex resume\r\n${id}`, 'codex'), null, id);
    assert.equal(parseResumeCommandLine(`codex resume ${id}`), null, id);
    assert.equal(parseResumeOutput(JSON.stringify({ thread_id: id }), 'codex'), null, id);
  }
});
