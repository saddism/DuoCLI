import type { NativeChatMessage } from './types';

type Submission = { text: string; createdAt: number; phase: string };

// Match in send order. A later identical prompt cannot claim an earlier turn,
// and historical text from before a submission cannot acknowledge that send.
export function trackChatSubmissions(
  messages: NativeChatMessage[],
  submissions: Iterable<[string, Submission]>,
): NativeChatMessage[] {
  const pending = [...submissions]
    .filter(([, entry]) => entry.phase === 'entered')
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  const claimed = new Set<number>();
  return messages.map(message => {
    if (message.role !== 'user' || message.timestamp === null) return message;
    const text = message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
    const index = pending.findIndex(([, entry], index) => !claimed.has(index)
      && entry.createdAt <= message.timestamp! && entry.text.trim() === text);
    if (index < 0) return message;
    claimed.add(index);
    return { ...message, submissionId: pending[index][0] };
  });
}
