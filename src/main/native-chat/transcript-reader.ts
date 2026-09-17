import { createReadStream, statSync } from 'fs';
import type { NativeChatMessage } from './types';
import type { NativeChatTranscriptAgent } from './types';
import { errorMessage } from './values';
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver';
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine,
  decodeOmpTranscriptLine,
} from './transcript-line-decoders';
import { decodeTranscriptStream } from './transcript-stream-lines';

const transcriptCache = new Map<string, { mtimeMs: number; messages: NativeChatMessage[] }>();
const TRANSCRIPT_CACHE_MAX = 24;

export type ReadTranscriptResult =
  | { messages: NativeChatMessage[]; filePath: string }
  | { error: string; notFound?: true };

export type ReadTranscriptOptions = ResolveSessionFileOptions & {
  filePath?: string;
};

export async function readNativeChatTranscript(
  agent: NativeChatTranscriptAgent,
  sessionId: string,
  options: ReadTranscriptOptions = {},
): Promise<ReadTranscriptResult> {
  const filePath = options.filePath ?? await resolveSessionFilePath(agent, sessionId, options);
  if (!filePath) {
    return { error: `No transcript found for ${agent} session ${sessionId}`, notFound: true };
  }
  try {
    const decode = decoderFor(agent);
    if (!decode) return { error: `Unsupported agent for Chat UI transcript: ${agent}` };
    const mtimeMs = statSync(filePath).mtimeMs;
    const cached = transcriptCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return { messages: cached.messages, filePath };
    }
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const { messages } = await decodeTranscriptStream(stream, filePath, 0, decode, true);
    transcriptCache.set(filePath, { mtimeMs, messages });
    if (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
      const oldest = transcriptCache.keys().next().value;
      if (oldest) transcriptCache.delete(oldest);
    }
    return { messages, filePath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { error: errorMessage(err), notFound: true };
    }
    return { error: errorMessage(err) };
  }
}

function decoderFor(agent: NativeChatTranscriptAgent) {
  if (agent === 'claude') return decodeClaudeTranscriptLine;
  if (agent === 'codex') return decodeCodexTranscriptLine;
  if (agent === 'grok') return decodeGrokTranscriptLine;
  if (agent === 'omp') return decodeOmpTranscriptLine;
  return null;
}
