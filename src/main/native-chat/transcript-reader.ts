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

const transcriptCache = new Map<string, {
  ino: number; mtimeMs: number; size: number; consumedBytes: number; messages: NativeChatMessage[];
}>();
const TRANSCRIPT_CACHE_MAX = 24;

export type ReadTranscriptResult =
  | { messages: NativeChatMessage[]; filePath: string; revision: string }
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
    const stat = statSync(filePath);
    const mtimeMs = stat.mtimeMs;
    const revision = `${stat.size}:${mtimeMs}`;
    const cached = transcriptCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === stat.size) {
      return { messages: cached.messages, filePath, revision };
    }
    const append = cached && cached.ino === stat.ino && stat.size > cached.size;
    const start = append ? cached.consumedBytes : 0;
    const stream = createReadStream(filePath, { encoding: 'utf-8', start });
    // A writer may leave a partial JSON record at EOF. Decode it only after its
    // newline arrives; consumedBytes then stays at the last complete boundary.
    const decoded = await decodeTranscriptStream(stream, filePath, start, decode, false);
    const messages = append ? mergeMessages(cached.messages, decoded.messages) : mergeMessages([], decoded.messages);
    transcriptCache.set(filePath, {
      ino: stat.ino, mtimeMs, size: stat.size, consumedBytes: start + decoded.consumedBytes, messages,
    });
    if (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
      const oldest = transcriptCache.keys().next().value;
      if (oldest) transcriptCache.delete(oldest);
    }
    return { messages, filePath, revision };
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { error: errorMessage(err), notFound: true };
    }
    return { error: errorMessage(err) };
  }
}

function mergeMessages(existing: NativeChatMessage[], incoming: NativeChatMessage[]): NativeChatMessage[] {
  const messages = existing.slice();
  const indexByKey = new Map(messages.map((message, index) => [`${message.role}\0${message.id}`, index]));
  for (const message of incoming) {
    const key = `${message.role}\0${message.id}`;
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, messages.length);
      messages.push(message);
    } else {
      // Some CLIs emit an in-progress item followed by its completed form.
      messages[index] = message;
    }
  }
  return messages;
}

function decoderFor(agent: NativeChatTranscriptAgent) {
  if (agent === 'claude') return decodeClaudeTranscriptLine;
  if (agent === 'codex') return decodeCodexTranscriptLine;
  if (agent === 'grok') return decodeGrokTranscriptLine;
  if (agent === 'omp') return decodeOmpTranscriptLine;
  return null;
}
