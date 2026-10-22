import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { stripLeadingEnvAssignments } from './dsh-host';

/** The CLI family is deliberately kept separate from the display/provider name. */
export type CliKind =
  | 'claude'
  | 'codex'
  | 'devin'
  | 'kimi'
  | 'gemini'
  | 'qwen'
  | 'pi'
  | 'qoder'
  | 'qodercn'
  | 'opencode'
  | 'kiro'
  | 'cursor'
  | 'agy'
  | 'dsh'
  | 'zcode'
  | 'unknown';

export interface ResumeCapture {
  cli: CliKind;
  sessionId: string;
  resumeCommand: string;
  source: 'preassigned' | 'output' | 'registry' | 'storage';
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID = `[A-Za-z0-9_:.~-]+`;
const SHELL_ARGUMENT = String.raw`(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+`;

function unquoteArgument(token: string): string {
  let value = '', quote = '';
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '\\' && quote !== "'" && i + 1 < token.length) value += token[++i];
    else if ((c === "'" || c === '"') && (!quote || quote === c)) quote = quote ? '' : c;
    else value += c;
  }
  return value;
}

export function identifyCli(presetCommand: string): CliKind {
  const first = (stripLeadingEnvAssignments(presetCommand).match(/^(?:[A-Za-z_][\w.-]*[\/])?([^\s]+)/)?.[1] || '');
  const bin = path.basename(first).toLowerCase();
  if (bin === 'claude') return 'claude';
  if (bin === 'codex') return 'codex';
  if (bin === 'devin') return 'devin';
  if (bin === 'kimi') return 'kimi';
  if (bin === 'gemini') return 'gemini';
  if (bin === 'qwen') return 'qwen';
  if (bin === 'pi') return 'pi';
  if (bin === 'qoder' || bin === 'qodercli') return 'qoder';
  if (bin === 'qodercn' || bin === 'qoderclicn') return 'qodercn';
  if (bin === 'opencode') return 'opencode';
  if (bin === 'kiro-cli' || bin === 'kiro') return 'kiro';
  if (bin === 'agent' || bin === 'cursor-agent') return 'cursor';
  if (bin === 'agy' || bin === 'antigravity') return 'agy';
  if (bin === 'dsh' || bin === 'dsh-tui' || bin === 'dst') return 'dsh';
  if (bin === 'zcode') return 'zcode';
  return 'unknown';
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasOption(command: string, names: string[]): boolean {
  return names.some(name => new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:=|\\s|$)`).test(command));
}

/**
 * Some CLIs expose a stable id before the first prompt. Supplying it at launch
 * is much safer than trying to infer “the newest” session when a PTY is killed.
 */
export function preassignSessionId(presetCommand: string, id: string): { command: string; capture: ResumeCapture | null } {
  const cli = identifyCli(presetCommand);
  if (!id || !['claude', 'gemini', 'qwen', 'qoder', 'qodercn'].includes(cli)) {
    return { command: presetCommand, capture: null };
  }
  const alreadyConfigured = cli === 'claude'
    ? hasOption(presetCommand, ['--resume', '--session-id', '--continue', '-c'])
    : cli === 'gemini'
      ? hasOption(presetCommand, ['--resume', '--session-id'])
      : hasOption(presetCommand, ['--resume', '--session-id', '--continue', '-c']);
  if (alreadyConfigured) return { command: presetCommand, capture: null };

  const option = '--session-id';
  const command = `${presetCommand} ${option} ${shellQuote(id)}`.trim();
  return {
    command,
    capture: { cli, sessionId: id, resumeCommand: buildResumeCommand(presetCommand, id), source: 'preassigned' },
  };
}

/** Pi accepts an explicit new JSONL path, not an arbitrary new UUID. The CLI
 * creates it itself; the path binds this PTY without selecting “latest in cwd”. */
export function preassignPiSession(presetCommand: string, id: string, cwd: string, agentDir?: string): { command: string; capture: ResumeCapture | null } {
  if (identifyCli(presetCommand) !== 'pi' || hasOption(presetCommand, ['--session', '--session-dir', '--continue', '-c', '--resume', '-r', '--fork', '--no-session'])) {
    return { command: presetCommand, capture: null };
  }
  const slug = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const file = path.join(agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions', slug, `duocli_${id}.jsonl`);
  const command = `${presetCommand} --session ${shellQuote(file)}`;
  return { command, capture: { cli: 'pi', sessionId: file, resumeCommand: command, source: 'preassigned' } };
}

function stripExistingResumeArgs(command: string): string {
  return command
    .replace(new RegExp(`\\s+(?:--resume|--resume-id|--conversation|--session-id|--session)(?:=|\\s+)${SHELL_ARGUMENT}`, 'gi'), '')
    .replace(new RegExp(`\\s+(?:-S|-s|-r)(?:=|\\s+)${SHELL_ARGUMENT}`, 'g'), '')
    .trim();
}

/** Build a provider-correct command. There is intentionally no generic fallback. */
export function buildResumeCommand(presetCommand: string, sessionId: string): string {
  const cli = identifyCli(presetCommand);
  const base = stripExistingResumeArgs(presetCommand);
  const id = shellQuote(sessionId);
  switch (cli) {
    case 'claude': return `${base} --resume ${id}`.trim();
    case 'codex': return `${base} resume ${id}`.trim();
    case 'devin': return `${base} -r ${id}`.trim();
    case 'kimi': return `${base} -S ${id}`.trim();
    case 'gemini': return `${base} --resume ${id}`.trim();
    case 'qwen': return `${base} --resume ${id}`.trim();
    case 'pi': return `${base} --session ${id}`.trim();
    case 'qoder': return `${base} --resume ${id}`.trim();
    case 'qodercn': return `${base} --resume ${id}`.trim();
    case 'opencode': return `${base} -s ${id}`.trim();
    case 'kiro': return `${base} --resume-id ${id}`.trim();
    case 'cursor': return `${base} --resume=${id}`.trim();
    case 'agy': return `${base} --conversation ${id}`.trim();
    case 'dsh': return `${base} --resume ${id}`.trim();
    case 'zcode': return sessionId.startsWith('sess_') ? `${base} --resume ${id}`.trim() : '';
    default: return '';
  }
}

export function isResumeCommandCompatible(presetCommand: string, command: string): boolean {
  const cli = identifyCli(presetCommand);
  const value = command.trim();
  if (!value) return false;
  switch (cli) {
    case 'claude': return /\bclaude\b[^\n]*--resume(?:=|\s)/i.test(value);
    case 'codex': return /\bcodex\b[^\n]*\sresume\s/i.test(value);
    case 'devin': return /\bdevin\b[^\n]*\s-r(?:=|\s)/i.test(value);
    case 'kimi': return /\bkimi\b[^\n]*(?:-S|--session)(?:=|\s)/i.test(value);
    case 'gemini': return /\bgemini\b[^\n]*--resume(?:=|\s)/i.test(value);
    case 'qwen': return /\bqwen\b[^\n]*--resume(?:=|\s)/i.test(value);
    case 'pi': return /\bpi\b[^\n]*--session(?:=|\s)/i.test(value);
    case 'qoder':
    case 'qodercn': return /--resume(?:=|\s)/i.test(value);
    case 'opencode': return /\bopencode\b[^\n]*(?:\s-s|\s--session)(?:=|\s)/i.test(value);
    case 'kiro': return /--resume-id(?:=|\s)/i.test(value);
    case 'cursor': return /\b(?:agent|cursor-agent)\b[^\n]*--resume(?:=|\s)/i.test(value);
    case 'agy': return /\bagy\b[^\n]*--conversation(?:=|\s)/i.test(value);
    case 'dsh': return /\bdsh(?:-tui)?\b[^\n]*(?:--session|--resume)(?:=|\s)/i.test(value);
    case 'zcode': return /\bzcode\b[^\n]*--resume(?:=|\s)/i.test(value);
    default: return false;
  }
}

function normalizeOutput(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // Qoder/Kiro wrap commands at the terminal width. Treat a newline as
    // whitespace for command matching, but retain it for JSON parsing.
    .replace(/\r?\n/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

function capture(cli: CliKind, sessionId: string, source: ResumeCapture['source'], presetCommand: string): ResumeCapture | null {
  if (!sessionId || cli === 'unknown') return null;
  const resumeCommand = buildResumeCommand(presetCommand, sessionId);
  if (!resumeCommand) return null;
  return { cli, sessionId, resumeCommand, source };
}

/** Parse a command that is already being launched in resume mode. */
export function parseResumeCommandLine(command: string): ResumeCapture | null {
  const cli = identifyCli(command);
  if (cli === 'pi') {
    const option = command.match(new RegExp(`(?:^|\\s)--session(?:=|\\s+)(${SHELL_ARGUMENT})`));
    const id = option ? unquoteArgument(option[1]) : null;
    if (id) return { cli, sessionId: id, resumeCommand: command.trim(), source: 'preassigned' };
  }
  const patterns: Partial<Record<CliKind, RegExp>> = {
    claude: /(?:^|\s)--resume(?:=|\s+)'?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'?\b/i,
    codex: new RegExp(`(?:^|\\s)resume\\s+'?(${UUID})(?![A-Za-z0-9_-])'?`, 'i'),
    devin: /(?:^|\s)-r(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
    kimi: /(?:^|\s)(?:-S|--session)(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
    gemini: /(?:^|\s)--resume(?:=|\s+)'?([A-Za-z0-9_.:-]+)'?/i,
    qwen: /(?:^|\s)--resume(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
    pi: /(?:^|\s)--session(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
    zcode: /(?:^|\s)--resume(?:=|\s+)'?(sess_[A-Za-z0-9_-]+)'?/i,
    qoder: /(?:^|\s)--resume(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
    qodercn: /(?:^|\s)--resume(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
    opencode: /(?:^|\s)(?:-s|--session)(?:=|\s+)'?(ses_[A-Za-z0-9_-]+)'?/i,
    kiro: /(?:^|\s)--resume-id(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
    cursor: /(?:^|\s)--resume(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
    agy: /(?:^|\s)--conversation(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
    dsh: /(?:^|\s)(?:--session|--resume)(?:=|\s+)'?([A-Za-z0-9_-]+)'?/i,
  };
  const match = patterns[cli]?.exec(command);
  if (!match) return null;
  const result = capture(cli, match[1], 'preassigned', command);
  if (result) result.resumeCommand = command.trim();
  return result;
}

// parseResumeOutput 在每个 PTY 数据块上都会跑一次（直到抓到 resume id），
// 所以这些表和正则必须是模块级常量，不能每次调用重新构造。
const RESUME_OUTPUT_PATTERNS: (readonly [CliKind, RegExp])[] = [
  ['claude', new RegExp(`\\bclaude\\s+--resume(?:=|\\s+)(${UUID})\\b`, 'i')],
  ['codex', new RegExp(`\\bcodex\\s+resume(?:=|\\s+)(${UUID})(?![A-Za-z0-9_-])`, 'i')],
  ['devin', /\bdevin\s+-r(?:=|\s+)([A-Za-z0-9_-]+)/i],
  ['kimi', /\bkimi\s+(?:-r|-S|--session)(?:=|\s+)([A-Za-z0-9_-]+)/i],
  ['gemini', new RegExp(`\\bgemini\\s+--resume(?:=|\\s+)(${SESSION_ID})`, 'i')],
  ['qwen', new RegExp(`\\bqwen\\s+--resume(?:=|\\s+)(${UUID})\\b`, 'i')],
  ['pi', new RegExp(`\\bpi\\s+--session(?:=|\\s+)(${UUID})\\b`, 'i')],
  ['zcode', /\bzcode\s+--resume(?:=|\s+)(sess_[A-Za-z0-9_-]+)/i],
  ['qoder', /\bqoder(?:cli)?\s+(?:chat\s+)?--resume(?:=|\s+)([A-Za-z0-9_-]+)/i],
  ['qodercn', /\bqoderc(?:n|licn)\s+--resume(?:=|\s+)([A-Za-z0-9_-]+)/i],
  ['opencode', /\bopencode\s+(?:-s|--session)(?:=|\s+)(ses_[A-Za-z0-9_-]+)/i],
  ['kiro', /\bkiro(?:-cli)?(?:\s+chat)?\s+--resume-id(?:=|\s+)([A-Za-z0-9_-]+)/i],
  ['cursor', /\bagent\s+--resume(?:=|\s+)([A-Za-z0-9_-]+)/i],
  ['agy', /\bagy\s+--conversation(?:=|\s+)([A-Za-z0-9_-]+)/i],
  ['dsh', /\bdsh(?:-tui)?\s+(?:tui\s+)?(?:--session|--resume)(?:=|\s+)([A-Za-z0-9_-]+)/i],
];

// JSON event formats emitted by the headless and streaming modes.
const RESUME_JSON_PATTERNS: (readonly [CliKind, RegExp])[] = [
  ['codex', new RegExp(`"thread_id"\\s*:\\s*"(${UUID})"`, 'i')],
  ['cursor', /"session_id"\s*:\s*"([^"]+)"/i],
  ['agy', /"conversation_id"\s*:\s*"([^"]+)"/i],
  ['opencode', /"sessionID"\s*:\s*"(ses_[^"]+)"/i],
  ['kimi', /"sessionId"\s*:\s*"(session_[^"]+)"/i],
];

// Codex's interactive TUI may only print “Session ID: …” on exit.
const CODEX_SESSION_ID_HINT = new RegExp(`Session\\s+ID:\\s*(${UUID})`, 'i');

/** Parse both human-facing close hints and machine-readable JSON events. */
export function parseResumeOutput(text: string, presetCommand: string): ResumeCapture | null {
  const cli = identifyCli(presetCommand);
  const normalized = normalizeOutput(text);
  // Prefer the command belonging to this preset. This prevents an embedded
  // shell message from another CLI from attaching to the wrong session.
  const ordered = cli === 'unknown'
    ? RESUME_OUTPUT_PATTERNS
    : RESUME_OUTPUT_PATTERNS.filter(([kind]) => kind === cli);
  for (const [kind, re] of ordered) {
    const match = normalized.match(re);
    if (match) return capture(kind, match[1], 'output', presetCommand);
  }

  const jsonCandidates = cli === 'unknown'
    ? RESUME_JSON_PATTERNS
    : RESUME_JSON_PATTERNS.filter(([kind]) => kind === cli);
  for (const [kind, re] of jsonCandidates) {
    const match = text.match(re);
    if (match) return capture(kind, match[1], 'output', presetCommand);
  }

  if (cli === 'codex') {
    const match = text.match(CODEX_SESSION_ID_HINT);
    if (match) return capture(cli, match[1], 'output', presetCommand);
  }
  return null;
}

function resolveExecutablePath(command: string): string {
  if (path.isAbsolute(command)) return command;
  try {
    const resolved = execFileSync(process.platform === 'win32' ? 'where' : '/usr/bin/which', [command], {
      encoding: 'utf8', timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\r?\n/)[0];
    if (resolved) return resolved;
  } catch { /* Dock-launched apps often have a reduced PATH */ }
  const home = os.homedir();
  const kimiHome = process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
  const candidates = [
    path.join(home, '.local', 'bin', command),
    path.join(home, '.npm-global', 'bin', command),
    path.join(home, '.opencode', 'bin', command),
    path.join(kimiHome, 'bin', command),
    path.join(home, '.qoder', 'bin', command),
    path.join(home, '.qoder-cn', 'entry', command),
    path.join('/opt/homebrew/bin', command),
    path.join('/usr/local/bin', command),
    path.join('/usr/bin', command),
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return command;
}

/** Cursor can allocate an empty chat without starting the interactive agent. */
export function createCursorSessionId(cwd: string): string | null {
  try {
    const output = execFileSync(resolveExecutablePath('agent'), ['create-chat'], {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = String(output).match(new RegExp(UUID));
    return match?.[0] || null;
  } catch {
    return null;
  }
}

function timestampOf(value: any): number {
  for (const key of ['createdAt', 'created_at', 'updatedAt', 'updated_at', 'created']) {
    const n = Number(value?.[key]);
    if (Number.isFinite(n)) return n < 10_000_000_000 ? n * 1000 : n;
    const parsed = Date.parse(String(value?.[key] || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizePath(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try { return path.resolve(value); } catch { return value; }
}

const SESSION_MATCH_BEFORE_MS = 5_000;
const SESSION_MATCH_AFTER_MS = 5_000;

/**
 * Pick only a session whose provider timestamp is close to this PTY's launch.
 * A registry's "latest in cwd" is not an association: another terminal can
 * create a newer session between launch and close. When multiple distinct
 * candidates are in the launch window, refuse to guess and let the caller
 * keep the session non-resumable instead of restoring the wrong conversation.
 */
export function pickSession(items: any[], cwd: string, createdAt: number, idOf: (item: any) => string): string | null {
  const target = normalizePath(cwd);
  const candidates = items
    .map(item => ({ item, id: idOf(item), time: timestampOf(item), dir: normalizePath(item?.cwd || item?.directory || item?.workDir || item?.workspace) }))
    .filter(x => x.id && x.time > 0 && x.dir === target);
  const recent = candidates
    .map(x => ({ ...x, distance: Math.abs(x.time - createdAt) }))
    .filter(x => x.time >= createdAt - SESSION_MATCH_BEFORE_MS && x.time <= createdAt + SESSION_MATCH_AFTER_MS)
    .sort((a, b) => a.distance - b.distance);
  if (!recent.length) return null;
  if (new Set(recent.map(item => item.id)).size !== 1) return null;
  return recent[0].id;
}

function isProcessDescendant(ownerPid: number, parentPid: number): boolean {
  if (!Number.isInteger(ownerPid) || ownerPid <= 1 || !Number.isInteger(parentPid) || parentPid <= 1) return false;
  if (ownerPid === parentPid) return true;
  try {
    let current = ownerPid;
    for (let depth = 0; depth < 8 && current > 1; depth++) {
      const next = Number(execFileSync(resolveExecutablePath('ps'), ['-o', 'ppid=', '-p', String(current)], {
        encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim());
      if (!next || next === current) return false;
      if (next === parentPid) return true;
      current = next;
    }
  } catch { /* process exited or ps is unavailable */ }
  return false;
}

function resolveFromKiroStorage(cwd: string, pid?: number): string | null {
  const dir = path.join(os.homedir(), '.kiro', 'sessions', 'cli');
  try {
    const items: any[] = [];
    const pidMatches = new Set<string>();
    const target = normalizePath(cwd);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const filePath = path.join(dir, name);
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const item = {
          ...value,
          session_id: value.session_id || value.sessionId || name.slice(0, -5),
        };
        items.push(item);
        if (pid) {
          const lockPath = filePath.slice(0, -'.json'.length) + '.lock';
          try {
            const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            const itemCwd = normalizePath(item.cwd || item.workDir || item.directory || item.workspace);
            if (isProcessDescendant(Number(lock?.pid), pid) && itemCwd === target) {
              pidMatches.add(String(item.session_id));
            }
          } catch { /* no lock or stale lock */ }
        }
      } catch { /* ignore a concurrently-written session file */ }
    }
    if (pidMatches.size === 1) return [...pidMatches][0];
    return null;
  } catch { return null; }
}

/** The live Codex writer lock belongs to this PTY only when exactly one owner is the shell or its child. */
export function pickCodexLockOwner(
  owners: ReadonlyArray<{ id: string; pid: number }>,
  ptyPid: number,
  parentOf: (pid: number) => number | undefined,
): string | null {
  if (!Number.isInteger(ptyPid) || ptyPid <= 1) return null;
  const matches = new Set<string>();
  for (const owner of owners) {
    if (!owner.id || !Number.isInteger(owner.pid) || owner.pid <= 1) continue;
    let current = owner.pid;
    for (let depth = 0; depth < 8 && current > 1; depth++) {
      if (current === ptyPid) {
        matches.add(owner.id);
        break;
      }
      const parent = parentOf(current);
      if (!parent || parent === current) break;
      current = parent;
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function readProcessParents(): Map<number, number> {
  try {
    const output = execFileSync(resolveExecutablePath('ps'), ['-axo', 'pid=,ppid='], {
      encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parents = new Map<number, number>();
    for (const line of output.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid > 0 && ppid > 0) parents.set(pid, ppid);
    }
    return parents;
  } catch {
    return new Map();
  }
}

function readCodexLockOwners(lockDir: string, pids: number[]): Array<{ id: string; pid: number }> {
  let output: string;
  try {
    // Inspect this process tree's open files, not every directory entry under
    // the lock cache. +D can time out on mounted filesystems before it emits
    // any owners, leaving real conversations permanently unbound.
    output = execFileSync(resolveExecutablePath('lsof'), ['-b', '-a', '-p', pids.join(','), '-F', 'pn'], {
      encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    // lsof can report valid owners and still exit 1 when an unrelated mounted
    // filesystem cannot be inspected. Retain those records; timeouts, signals
    // and other failures remain unusable. PTY ancestry still validates ownership.
    const failure = error as { status?: number; signal?: string | null; stdout?: unknown };
    if (failure.status !== 1 || failure.signal || typeof failure.stdout !== 'string') return [];
    output = failure.stdout;
  }
  const owners: Array<{ id: string; pid: number }> = [];
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && line.endsWith('.lock')) {
      const file = line.slice(1);
      if (path.resolve(path.dirname(file)) !== path.resolve(lockDir) || path.basename(file) === '.coordination.lock') continue;
      owners.push({ id: path.basename(file, '.lock'), pid });
    }
  }
  return owners;
}

function resolveFromCodex(_cwd: string, pid?: number, codexHome?: string): string | null {
  const lockDir = path.join(codexHome || path.join(os.homedir(), '.codex'), 'thread-writer-locks');
  // An interactive Codex TUI may replace its thread without printing a new id.
  // The writer lock owned by this PTY is the conversation currently on screen.
  if (!pid || !fs.existsSync(lockDir)) return null;
  const parents = readProcessParents();
  // Restrict lsof to this PTY tree. Scanning every open file on the machine
  // can time out on mounted volumes and leave an active chat unbound.
  const pids = [pid];
  for (const child of parents.keys()) {
    if (child !== pid && pickCodexLockOwner([{ id: 'candidate', pid: child }], pid, parent => parents.get(parent))) {
      pids.push(child);
    }
  }
  return pickCodexLockOwner(readCodexLockOwners(lockDir, pids), pid, (child) => parents.get(child));
}

/** Claude updates sessions/<pid>.json on /clear and /resume. Use that live
 * registration, never the newest transcript belonging to the same directory. */
function resolveFromClaude(cwd: string, createdAt: number, pid?: number, configDir?: string): string | null {
  if (!pid) return null;
  const parents = readProcessParents();
  const root = path.join(configDir || path.join(os.homedir(), '.claude'), 'sessions');
  const owners: Array<{ id: string; pid: number }> = [];
  for (const ownerPid of new Set([pid, ...parents.keys()])) {
    if (!pickCodexLockOwner([{ id: 'candidate', pid: ownerPid }], pid, child => parents.get(child))) continue;
    try {
      const file = path.join(root, `${ownerPid}.json`);
      if (!fs.lstatSync(file).isFile()) continue;
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.pid !== ownerPid || typeof record.sessionId !== 'string'
          || !new RegExp(`^${UUID}$`, 'i').test(record.sessionId)
          || normalizePath(record.cwd) !== normalizePath(cwd)
          || !Number.isFinite(record.startedAt) || record.startedAt < createdAt - SESSION_MATCH_BEFORE_MS
          || record.startedAt > Date.now() + SESSION_MATCH_AFTER_MS
          || (record.kind && record.kind !== 'interactive')) continue;
      owners.push({ id: record.sessionId, pid: ownerPid });
    } catch { /* registration can be rewritten or removed while reading */ }
  }
  return pickCodexLockOwner(owners, pid, child => parents.get(child));
}

/**
 * Resolve IDs that cannot be preassigned. This is called while the PTY is
 * still alive (before kill), so a close action cannot race the local registry.
 */
export function resolveSessionId(cli: CliKind, cwd: string, createdAt: number, presetCommand?: string, pid?: number, storageEnv: Record<string, string | undefined> = process.env): ResumeCapture | null {
  let id: string | null = null;
  switch (cli) {
    case 'claude': id = resolveFromClaude(cwd, createdAt, pid, storageEnv.CLAUDE_CONFIG_DIR); break;
    case 'kiro': {
      id = resolveFromKiroStorage(cwd, pid);
      break;
    }
    case 'devin':
    case 'kimi':
    case 'opencode':
      // These registries expose cwd/time but no process association. Do not
      // turn “latest in this directory” into a potentially wrong resume ID.
      break;
    // Antigravity's cache only stores one "last conversation" per cwd and
    // has no per-session timestamp or process association. Do not guess from
    // it; output/JSON capture remains the reliable source for this CLI.
    case 'agy': break;
    case 'codex': id = resolveFromCodex(cwd, pid, storageEnv.CODEX_HOME); break;
    default: break;
  }
  if (!id) return null;
  return capture(cli, id, 'registry', presetCommand || cli);
}

export function stripResumeOutput(text: string): string {
  return normalizeOutput(text);
}

export const RESTORE_FAILURE_PATTERN = /(session|conversation|thread).*(?:not found|does not exist|unknown|invalid|missing|expired)|(?:failed|unable|cannot|could not).*(?:resume|restore|load|open)|no such session|(?:command|option).*(?:not found|unknown|invalid)|not recognized as (?:an )?internal or external command|usage:\s|找不到会话|会话不存在|恢复失败|无法恢复|未找到会话/i;

export type RestoreProgress = 'pending' | 'success' | 'failure';

export function stripLaunchOutput(output: string): string {
  return output
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, ' ')
    .replace(/[\r\n]+/g, ' ');
}

/** Judge a restore launch. Echo plus any output is not success; wait for observeAfterEchoMs. */
export function evaluateRestoreProgress(
  launch: { sentAt: number | null; commandEchoed: boolean; output: string; returnedToShell: boolean } | null,
  now: number,
  observeAfterEchoMs = 2500,
): RestoreProgress {
  if (!launch) return 'pending';
  if (launch.returnedToShell || RESTORE_FAILURE_PATTERN.test(stripLaunchOutput(launch.output || ''))) return 'failure';
  if (launch.sentAt && launch.commandEchoed && now - launch.sentAt >= observeAfterEchoMs) return 'success';
  return 'pending';
}
