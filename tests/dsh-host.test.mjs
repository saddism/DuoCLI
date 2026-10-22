import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DSH_URL,
  buildDshTuiLaunchCommand,
  isDshApiHostResponse,
  isDshTuiApiResponse,
  listLocalDshListenUrls,
  parseDshWebAnnouncements,
  parseInlineEnvAssignments,
  resolveDshLaunch,
  resolveDshUrl,
  stripLeadingEnvAssignments,
} from '../dist/main/dsh-host.js';
import { buildResumeCommand, identifyCli, preassignSessionId } from '../dist/main/session-resume.js';
import { getDisplayName } from '../dist/main/pty-manager.js';
import { BUILTIN_PRESETS, extractCommandBin } from '../dist/main/cli-detect.js';

test('strips leading env assignments before the real binary', () => {
  assert.equal(
    stripLeadingEnvAssignments('DSH_URL=http://127.0.0.1:58084 dsh-tui'),
    'dsh-tui',
  );
  assert.equal(
    parseInlineEnvAssignments('DSH_URL=http://127.0.0.1:58084 dsh-tui').env.DSH_URL,
    'http://127.0.0.1:58084',
  );
  assert.equal(extractCommandBin('DSH_URL=http://127.0.0.1:58084 dsh-tui'), 'dsh-tui');
});

test('identifies dsh-tui even when a stale DSH_URL is inlined', () => {
  assert.equal(identifyCli('dsh-tui'), 'dsh');
  assert.equal(identifyCli('dst'), 'dsh');
  assert.equal(identifyCli('DSH_URL=http://127.0.0.1:58084 dsh-tui'), 'dsh');
  assert.equal(identifyCli('dsh --profile web'), 'dsh');
  assert.equal(getDisplayName('dsh-tui'), 'DSH');
  assert.deepEqual(
    BUILTIN_PRESETS.find(p => p.value === 'dsh-tui'),
    { value: 'dsh-tui', label: 'DSH' },
  );
});

test('builds dsh-tui resume commands without preassigning an id', () => {
  assert.equal(buildResumeCommand('dsh-tui', 'session-abc'), 'dsh-tui --resume session-abc');
  const preassigned = preassignSessionId('dsh-tui', 'session-abc');
  assert.equal(preassigned.command, 'dsh-tui');
  assert.equal(preassigned.capture, null);
});

test('replaces a dead DSH_URL with the live host', () => {
  const live = 'http://127.0.0.1:56685';
  const resolved = resolveDshLaunch('DSH_URL=http://127.0.0.1:58084 dsh-tui', {
    probe: url => url === live,
    candidates: [live, 'http://127.0.0.1:43127'],
  });
  assert.equal(resolved.command, 'dsh-tui');
  assert.equal(resolved.dshUrl, live);
  assert.equal(resolved.replacedStaleUrl, true);
});

test('keeps a reachable explicit DSH_URL', () => {
  const current = 'http://127.0.0.1:58084';
  const resolved = resolveDshLaunch(`DSH_URL=${current} dsh-tui`, {
    probe: url => url === current,
    candidates: ['http://127.0.0.1:56685'],
  });
  assert.equal(resolved.dshUrl, current);
  assert.equal(resolved.replacedStaleUrl, false);
});

test('falls back to the default port when it is the live host', () => {
  assert.equal(resolveDshUrl({
    probe: url => url === DEFAULT_DSH_URL,
    candidates: ['http://127.0.0.1:43127'],
  }), DEFAULT_DSH_URL);
});

test('recognizes DSH API hosts and ignores the desktop reconnect page', () => {
  assert.equal(isDshApiHostResponse(401, 'dsh web authentication required; reopen the URL printed by dsh web.\n'), true);
  assert.equal(isDshApiHostResponse(401, 'unauthorized'), true);
  assert.equal(isDshApiHostResponse(200, '{"items":[]}'), true);
  assert.equal(isDshApiHostResponse(200, '<title>重新连接 DSH</title>'), false);
  assert.equal(isDshTuiApiResponse(200, '{"type":"server-response","result":{"ok":true,"value":{"items":[]}}}'), true);
  assert.equal(isDshTuiApiResponse(404, 'not found'), false);
  assert.equal(isDshTuiApiResponse(401, 'unauthorized'), false);
});

test('parses dsh web announcements and wraps dsh-tui through the launcher', () => {
  const items = parseDshWebAnnouncements([
    'dsh web: http://127.0.0.1:58084',
    'dsh web: http://127.0.0.1:56685/?token=abc123',
  ].join('\n'));
  assert.equal(items[0].url, 'http://127.0.0.1:58084');
  assert.equal(items[1].token, 'abc123');
  const command = buildDshTuiLaunchCommand('dsh-tui --resume', '/tmp/Electron');
  assert.match(command, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(command, /dsh-tui-launch\.js --resume$/);
});

test('reads DSH listen URLs from lsof output', () => {
  const urls = listLocalDshListenUrls([
    'DSH De 18365 user 59u IPv4 0x1 TCP *:43127 (LISTEN)',
    'DSH De 18419 user 30u IPv4 0x2 TCP 127.0.0.1:56685 (LISTEN)',
    'Electron 70603 user 60u IPv4 0x3 TCP *:9800 (LISTEN)',
  ].join('\n'));
  assert.deepEqual(urls, ['http://127.0.0.1:43127', 'http://127.0.0.1:56685']);
});
