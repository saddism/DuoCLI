import type { CliKind } from '../session-resume';
import { isNativeChatSupportedCli, nativeChatAgentFromCli } from './session-file-resolver';
import { readNativeChatTranscript } from './transcript-reader';
import type { NativeChatMessage } from './types';

export { isNativeChatSupportedCli, nativeChatAgentFromCli } from './session-file-resolver';
export { readNativeChatTranscript } from './transcript-reader';
export type { NativeChatMessage, NativeChatBlock, NativeChatRole } from './types';

export type NativeChatSnapshot = {
  supported: boolean;
  ready: boolean;
  notFound?: boolean;
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
      agent,
      sessionId: null,
      messages: [],
    };
  }
  const result = await readNativeChatTranscript(agent, resumeId, { cwd });
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
