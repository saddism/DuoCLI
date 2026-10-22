import type { CliKind } from '../session-resume';
import { isNativeChatSupportedCli, nativeChatAgentFromCli } from './session-file-resolver';
import { readNativeChatTranscript } from './transcript-reader';
import type { NativeChatMessage } from './types';
import { join } from 'path';
import type { ReadTranscriptOptions } from './transcript-reader';

export { isNativeChatSupportedCli, nativeChatAgentFromCli } from './session-file-resolver';
export { readNativeChatTranscript } from './transcript-reader';
export type { NativeChatMessage, NativeChatBlock, NativeChatRole } from './types';

export type NativeChatSnapshot = {
  supported: boolean;
  ready: boolean;
  notFound?: boolean;
  unbound?: boolean;
  error?: string;
  agent: string | null;
  sessionId: string | null;
  filePath?: string;
  revision?: string;
  messages: NativeChatMessage[];
};

export async function loadSessionChat(
  cliKind: CliKind | string | null | undefined,
  resumeId: string | null | undefined,
  cwd?: string | null,
  storageEnv: Record<string, string | undefined> = process.env,
): Promise<NativeChatSnapshot> {
  const agent = nativeChatAgentFromCli(cliKind);
  if (!agent || !isNativeChatSupportedCli(cliKind)) {
    return { supported: false, ready: false, agent: null, sessionId: resumeId || null, messages: [] };
  }
  if (!resumeId) {
    return {
      supported: true,
      ready: false,
      notFound: true,
      unbound: true,
      agent,
      sessionId: null,
      messages: [],
    };
  }
  const options: ReadTranscriptOptions = { cwd };
  if (agent === 'claude' && storageEnv.CLAUDE_CONFIG_DIR) options.claudeProjectsDir = join(storageEnv.CLAUDE_CONFIG_DIR, 'projects');
  if (agent === 'codex' && storageEnv.CODEX_HOME) {
    options.codexSessionsDirs = [join(storageEnv.CODEX_HOME, 'sessions')];
    options.providerRoot = join(storageEnv.CODEX_HOME, 'thread_history_1.sqlite');
  }
  if (agent === 'pi' && storageEnv.PI_CODING_AGENT_DIR) options.providerRoot = join(storageEnv.PI_CODING_AGENT_DIR, 'sessions');
  if (agent === 'kimi' && storageEnv.KIMI_CODE_HOME) options.providerRoot = join(storageEnv.KIMI_CODE_HOME, 'sessions');
  if (storageEnv.XDG_DATA_HOME && (agent === 'opencode' || agent === 'devin')) {
    options.providerRoot = agent === 'opencode' ? join(storageEnv.XDG_DATA_HOME, 'opencode', 'opencode.db') : join(storageEnv.XDG_DATA_HOME, 'devin', 'cli', 'sessions.db');
  }
  const result = await readNativeChatTranscript(agent, resumeId, options);
  if ('error' in result) {
    return {
      supported: true,
      ready: false,
      notFound: result.notFound,
      error: result.error,
      agent,
      sessionId: resumeId,
      messages: [],
    };
  }
  return {
    supported: true,
    ready: true,
    agent,
    sessionId: resumeId,
    filePath: result.filePath,
    revision: result.revision,
    messages: result.messages,
  };
}
