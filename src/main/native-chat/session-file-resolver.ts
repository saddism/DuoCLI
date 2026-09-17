import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, extname, join } from 'path';
import type { NativeChatTranscriptAgent } from './types';

const MAX_WALK_FILES = 8000;
const MAX_WALK_DEPTH = 8;
const PATH_CACHE_MAX = 64;
const NEGATIVE_PATH_CACHE_MS = 2000;
const pathCache = new Map<string, { filePath: string | null; checkedAt: number }>();

export type ResolveSessionFileOptions = {
  claudeProjectsDir?: string;
  codexSessionsDirs?: string[];
  grokSessionsDir?: string;
  ompSessionsDir?: string;
  transcriptPath?: string;
  cwd?: string | null;
};

export function nativeChatAgentFromCli(cli: string | null | undefined): NativeChatTranscriptAgent | null {
  if (cli === 'claude') return 'claude';
  if (cli === 'codex') return 'codex';
  if (cli === 'grok') return 'grok';
  if (cli === 'omp' || cli === 'pi') return 'omp';
  return null;
}

export function isNativeChatSupportedCli(cli: string | null | undefined): boolean {
  return nativeChatAgentFromCli(cli) != null;
}

function claudeProjectsDirs(override?: string): string[] {
  if (override) return [override];
  const candidates = [
    join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'projects'),
    join(homedir(), '.claude', 'projects'),
  ];
  return candidates.filter((dir, index) => candidates.indexOf(dir) === index);
}

function codexSessionsDirs(override?: string[]): string[] {
  if (override) return override;
  const candidates = [
    join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'sessions'),
  ];
  return candidates.filter((dir, index) => candidates.indexOf(dir) === index);
}

function grokSessionsDir(override?: string): string {
  return override || join(process.env.GROK_HOME?.trim() || join(homedir(), '.grok'), 'sessions');
}

function ompSessionsDir(override?: string): string {
  return override
    || process.env.OMP_CODING_AGENT_DIR?.trim()
    || join(homedir(), '.omp', 'agent', 'sessions');
}

function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
}

function cacheKey(agent: NativeChatTranscriptAgent, sessionId: string, options: ResolveSessionFileOptions): string {
  return [
    agent,
    sessionId,
    options.claudeProjectsDir || '',
    (options.codexSessionsDirs || []).join('|'),
    options.grokSessionsDir || '',
    options.ompSessionsDir || '',
    options.cwd || '',
  ].join('\0');
}

function rememberPath(key: string, filePath: string | null): string | null {
  pathCache.set(key, { filePath, checkedAt: Date.now() });
  if (pathCache.size > PATH_CACHE_MAX) {
    const oldest = pathCache.keys().next().value;
    if (oldest) pathCache.delete(oldest);
  }
  return filePath;
}

export async function resolveSessionFilePath(
  agent: NativeChatTranscriptAgent,
  sessionId: string,
  options: ResolveSessionFileOptions = {},
): Promise<string | null> {
  const trimmedId = sessionId.trim();
  if (!trimmedId) return null;

  const hookPath = options.transcriptPath?.trim();
  if (hookPath && extname(hookPath) === '.jsonl' && existsSync(hookPath)) {
    return hookPath;
  }

  const key = cacheKey(agent, trimmedId, options);
  const cached = pathCache.get(key);
  if (cached?.filePath && existsSync(cached.filePath)) return cached.filePath;
  if (cached && !cached.filePath && Date.now() - cached.checkedAt < NEGATIVE_PATH_CACHE_MS) {
    return null;
  }

  let filePath: string | null = null;
  if (agent === 'claude') {
    const roots = claudeProjectsDirs(options.claudeProjectsDir);
    if (options.cwd) {
      const slug = claudeProjectSlug(options.cwd);
      for (const root of roots) {
        const direct = join(root, slug, `${trimmedId}.jsonl`);
        if (existsSync(direct)) {
          filePath = direct;
          break;
        }
      }
    }
    if (!filePath) {
      filePath = findFile(roots, path => basename(path) === `${trimmedId}.jsonl`);
    }
  } else if (agent === 'codex') {
    filePath = findFile(codexSessionsDirs(options.codexSessionsDirs), path => {
      const name = basename(path, extname(path));
      return name === trimmedId || name.endsWith(`-${trimmedId}`);
    });
  } else if (agent === 'grok') {
    const root = grokSessionsDir(options.grokSessionsDir);
    const cwdHint = options.cwd ? encodeURIComponent(options.cwd) : '';
    const direct = cwdHint ? join(root, cwdHint, trimmedId, 'chat_history.jsonl') : '';
    if (direct && existsSync(direct)) filePath = direct;
    else {
      const byId = join(root, trimmedId, 'chat_history.jsonl');
      filePath = existsSync(byId)
        ? byId
        : findFile([root], path => basename(path) === 'chat_history.jsonl' && path.includes(trimmedId));
    }
  } else {
    filePath = findFile([ompSessionsDir(options.ompSessionsDir)], path => {
      const name = basename(path, extname(path));
      return name === trimmedId || name.endsWith(`_${trimmedId}`);
    });
  }
  return rememberPath(key, filePath);
}

function findFile(roots: string[], predicate: (path: string) => boolean): string | null {
  let seen = 0;
  const visit = (dir: string, depth: number): string | null => {
    if (depth > MAX_WALK_DEPTH || seen >= MAX_WALK_FILES) return null;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of entries) {
      if (seen >= MAX_WALK_FILES) return null;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const nested = visit(full, depth + 1);
        if (nested) return nested;
        continue;
      }
      if (!stat.isFile() || extname(full) !== '.jsonl') continue;
      seen += 1;
      if (predicate(full)) return full;
    }
    return null;
  };
  for (const root of roots) {
    const hit = visit(root, 0);
    if (hit) return hit;
  }
  return null;
}
