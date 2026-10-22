import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_DSH_URL = 'http://127.0.0.1:3080';
const DEFAULT_DSH_PORT = 3080;
const STATE_FILE = path.join(os.tmpdir(), 'duocli-dsh-web.json');
const HARNESS_LOG_CANDIDATES = [
  path.join(os.homedir(), 'Library', 'Logs', 'DSH Desktop', 'harness.log'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'logs', 'harness.log'),
];

export interface DshHostLookup {
  preferredUrl?: string;
  probe?: (url: string) => boolean;
  candidates?: string[];
}

export interface DshLaunchResolution {
  command: string;
  dshUrl: string | null;
  dshToken: string | null;
  replacedStaleUrl: boolean;
}

export interface DshWebAnnouncement {
  url: string;
  token: string | null;
}

export interface DshTuiHost {
  url: string;
  token: string | null;
  cookie: string | null;
}

const INLINE_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s+/;

/** 去掉命令前的 `env` / `FOO=bar`，方便识别真正的二进制名。 */
export function stripLeadingEnvAssignments(command: string): string {
  let rest = command.trim().replace(/^env\s+/, '');
  while (INLINE_ASSIGNMENT.test(rest)) {
    rest = rest.replace(INLINE_ASSIGNMENT, '');
  }
  return rest.trim();
}

export function parseInlineEnvAssignments(command: string): { env: Record<string, string>; command: string } {
  const env: Record<string, string> = {};
  let rest = command.trim().replace(/^env\s+/, '');
  let match: RegExpExecArray | null;
  while ((match = INLINE_ASSIGNMENT.exec(rest))) {
    env[match[1]] = stripWrappingQuotes(match[2]);
    rest = rest.slice(match[0].length);
  }
  return { env, command: rest.trim() };
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function normalizeDshUrl(value: string | null | undefined): string | null {
  const raw = (value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** DSH host 的 API 指纹：活着的 host 可能是 200 会话列表，或带鉴权的 401。 */
export function isDshApiHostResponse(status: number, body: string): boolean {
  const text = String(body || '');
  if (status === 401 && /dsh web authentication|unauthorized/i.test(text)) return true;
  if (status === 200 && /"items"|session\.list|"sessionId"|server-response/i.test(text)) return true;
  return false;
}

/** dsh-tui 要的是 HTTP unary `/api/session.list`，DSH Desktop 的浏览器 host 过鉴权后会 404。 */
export function isDshTuiApiResponse(status: number, body: string): boolean {
  return status === 200 && /server-response|"items"/i.test(String(body || ''));
}

export function parseDshWebAnnouncements(text: string): DshWebAnnouncement[] {
  const found: DshWebAnnouncement[] = [];
  const pattern = /\bdsh web:\s*(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    try {
      const parsed = new URL(match[1]);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      found.push({
        url: parsed.origin,
        token: parsed.searchParams.get('token'),
      });
    } catch { /* ignore malformed printed URLs */ }
  }
  return found;
}

export function latestDshWebAnnouncement(text: string, liveUrl?: string | null): DshWebAnnouncement | null {
  const items = parseDshWebAnnouncements(text);
  if (!items.length) return null;
  const wanted = normalizeDshUrl(liveUrl);
  if (wanted) {
    const match = [...items].reverse().find(item => item.url === wanted);
    if (match) return match;
  }
  return items[items.length - 1];
}

function readHarnessLogText(): string {
  for (const file of HARNESS_LOG_CANDIDATES) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    } catch { /* continue */ }
  }
  return '';
}

export function listLocalDshListenUrls(lsofOutput: string): string[] {
  const urls = new Set<string>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (!/dsh/i.test(line)) continue;
    const match = line.match(/\s(?:127\.0\.0\.1|\*|\[::1\]):(\d+)\s+\(LISTEN\)/);
    if (match) urls.add(`http://127.0.0.1:${match[1]}`);
  }
  return [...urls];
}

function readLocalDshListenUrls(): string[] {
  try {
    const output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return listLocalDshListenUrls(output);
  } catch {
    return [];
  }
}

function defaultProbe(url: string): boolean {
  const base = normalizeDshUrl(url);
  if (!base) return false;
  try {
    const output = execFileSync('curl', [
      '-sS',
      '-m', '1',
      '-D', '-',
      '-X', 'POST',
      '-H', 'content-type: application/json',
      '--data', '{"type":"client-request","rpcId":"rpc-probe","method":"session.list","payload":{}}',
      `${base}/api/session.list`,
    ], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const statusMatch = /^HTTP\/\S+\s+(\d+)/m.exec(output);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    const body = output.replace(/^HTTP[\s\S]*?\r?\n\r?\n/, '');
    return isDshApiHostResponse(status, body);
  } catch {
    return false;
  }
}

/**
 * 挑选当前可用的 DSH host。
 * 用户写明的地址若仍通，就沿用；不通则换成本机正在听的 host，避免沿用上次启动留下的死端口。
 */
export function resolveDshUrl(lookup: DshHostLookup = {}): string | null {
  const probe = lookup.probe || defaultProbe;
  const preferred = normalizeDshUrl(lookup.preferredUrl);
  const discovered = (lookup.candidates || readLocalDshListenUrls())
    .map(normalizeDshUrl)
    .filter((url): url is string => !!url);
  const ordered = [
    preferred,
    DEFAULT_DSH_URL,
    ...discovered.filter(url => url !== preferred && url !== DEFAULT_DSH_URL),
  ].filter((url): url is string => !!url);
  const unique = [...new Set(ordered)];
  for (const url of unique) {
    if (probe(url)) return url;
  }
  return preferred;
}

export function resolveDshLaunch(command: string, lookup: DshHostLookup = {}): DshLaunchResolution {
  const parsed = parseInlineEnvAssignments(command);
  const inlineUrl = normalizeDshUrl(parsed.env.DSH_URL);
  const preferred = normalizeDshUrl(lookup.preferredUrl) || inlineUrl;
  const dshUrl = resolveDshUrl({ ...lookup, preferredUrl: preferred || undefined });
  const announced = latestDshWebAnnouncement(readHarnessLogText(), dshUrl);
  if (parsed.env.DSH_URL) delete parsed.env.DSH_URL;
  return {
    command: parsed.command,
    dshUrl,
    dshToken: announced?.url === dshUrl ? announced.token : null,
    replacedStaleUrl: !!inlineUrl && !!dshUrl && inlineUrl !== dshUrl,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 在 PTY 里跑启动器，避免主进程同步卡住去拉起 dsh web。 */
export function buildDshTuiLaunchCommand(command: string, execPath = process.execPath): string {
  const rest = stripLeadingEnvAssignments(command).replace(/^(dsh-tui|dsh)\b/, '').trim();
  const launcher = path.join(__dirname, 'dsh-tui-launch.js');
  const extra = rest ? ` ${rest}` : '';
  return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(execPath)} ${shellQuote(launcher)}${extra}`;
}

function resolveCommandBin(name: string): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', name),
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
    path.join('/usr/bin', name),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* continue */ }
  }
  try {
    const found = execFileSync('/usr/bin/which', [name], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function cookieFromSetCookie(header: string | null): string | null {
  if (!header) return null;
  const first = header.split(';')[0]?.trim();
  return first || null;
}

export async function exchangeDshCookie(url: string, token: string): Promise<string | null> {
  const base = normalizeDshUrl(url);
  if (!base || !token) return null;
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  if (cookies.length > 0) return cookieFromSetCookie(cookies[0]);
  return cookieFromSetCookie(response.headers.get('set-cookie'));
}

export async function probeDshTuiHost(url: string, token?: string | null): Promise<DshTuiHost | null> {
  const base = normalizeDshUrl(url);
  if (!base) return null;
  let cookie: string | null = null;
  if (token) cookie = await exchangeDshCookie(base, token);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  try {
    const response = await fetch(`${base}/api/session.list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-probe',
        method: 'session.list',
        payload: {},
      }),
    });
    const body = await response.text();
    if (!isDshTuiApiResponse(response.status, body)) return null;
    return { url: base, token: token || null, cookie };
  } catch {
    return null;
  }
}

interface SidecarState {
  url: string;
  token: string | null;
  pid?: number;
}

function readSidecarState(): SidecarState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SidecarState;
    return raw?.url ? raw : null;
  } catch {
    return null;
  }
}

function writeSidecarState(state: SidecarState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch { /* ignore */ }
}

function startDshWeb(port = DEFAULT_DSH_PORT): Promise<DshWebAnnouncement> {
  const bin = resolveCommandBin('dsh');
  if (!bin) return Promise.reject(new Error('dsh 未安装'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['web', '--port', String(port), '--no-open'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      clearTimeout(timer);
      if (error) reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      const announced = latestDshWebAnnouncement(output);
      if (!announced) return;
      writeSidecarState({ url: announced.url, token: announced.token, pid: child.pid });
      child.unref();
      finish();
      resolve(announced);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', error => finish(error));
    child.once('exit', code => {
      if (!latestDshWebAnnouncement(output)) {
        finish(new Error(`dsh web 退出 (${code ?? 'unknown'})`));
      }
    });
    const timer = setTimeout(() => finish(new Error('dsh web 启动超时')), 30000);
  });
}

export class DshProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshProtocolError';
  }
}

async function hostUsesSlashRemoteApi(url: string, cookie: string | null): Promise<boolean> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  try {
    const response = await fetch(`${url}/api/session/list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-probe',
        method: 'session/list',
        payload: { args: { _request: {} } },
      }),
    });
    const body = await response.text();
    return response.status === 200 && /server-response|arguments-invalid/.test(body);
  } catch {
    return false;
  }
}

/** 找一个 dsh-tui 0.2 还能说话的旧 HTTP host。当前 DSH Desktop / dsh web 已换成 slash Remote。 */
export async function ensureDshTuiHost(preferredUrl?: string | null): Promise<DshTuiHost | null> {
  const saved = readSidecarState();
  const announced = latestDshWebAnnouncement(readHarnessLogText());
  const candidates = [
    preferredUrl,
    saved?.url,
    DEFAULT_DSH_URL,
    announced?.url,
  ].map(normalizeDshUrl).filter((url): url is string => !!url);
  const unique = [...new Set(candidates)];
  let sawNewProtocol = false;
  for (const url of unique) {
    const token = (saved?.url === url ? saved.token : null)
      || (announced?.url === url ? announced.token : null);
    const host = await probeDshTuiHost(url, token);
    if (host) return host;
    let cookie: string | null = null;
    if (token) cookie = await exchangeDshCookie(url, token);
    if (await hostUsesSlashRemoteApi(url, cookie)) sawNewProtocol = true;
  }
  if (sawNewProtocol) {
    throw new DshProtocolError(
      '当前 DSH host 已换成 /api/session/list，dsh-tui 0.2 还在请求 /api/session.list，对不上。请直接用 DSH Desktop，或等 dsh-tui 升级。',
    );
  }
  return null;
}
