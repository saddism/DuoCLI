// Read-only product audit: invokes actual protocol code against in-memory PTY fixtures.
import { Readable } from 'node:stream';
import { PtyManager } from '../dist/main/pty-manager.js';
import { decodeTranscriptStream } from '../dist/main/native-chat/transcript-stream-lines.js';
import { decodeCodexTranscriptLine } from '../dist/main/native-chat/transcript-line-decoders-codex.js';

function fixture(bracketed = true) {
  const writes = [];
  const manager = new PtyManager({ onData() {}, onTitleUpdate() {}, onExit() {} });
  manager.sessions.set('fixture', {
    submissions: new Map(), submitQueue: Promise.resolve(),
    inputTransaction: false, inputTransactionCount: 0, queuedInputs: [],
    terminalState: {
      terminal: { modes: { bracketedPasteMode: bracketed } },
      snapshot: async consume => consume({}),
    },
    ptyProcess: { write: data => writes.push(data) }, sizeBySource: { desktop: null, mobile: null },
    sizeOwner: null, lastInputAt: { desktop: 0, mobile: 0 }, currentLine: '', accumulatedInputs: [],
    titleInputRevision: 0, titleSegmentCount: 0, titleGenerated: true, titleLocked: false,
    autoResponseTimers: new Set(), updatedAt: 0,
  });
  return { manager, writes };
}

const interleaved = fixture();
const submission = interleaved.manager.submit('fixture', 'first', 'composer text');
await new Promise(resolve => setTimeout(resolve, 10));
interleaved.manager.write('fixture', 'desktop text');
await submission;
console.log('PROTOCOL_AUDIT', JSON.stringify({ id: 'INPUT-06', writes: interleaved.writes }));

const evicted = fixture();
for (let i = 0; i < 257; i++) await evicted.manager.submit('fixture', `id-${i}`, `text-${i}`, 0);
const before = evicted.writes.length;
await evicted.manager.submit('fixture', 'id-0', 'text-0', 0);
console.log('PROTOCOL_AUDIT', JSON.stringify({ id: 'INPUT-07', retryWritesAfterEviction: evicted.writes.slice(before) }));

const failed = fixture();
let attempts = 0;
failed.manager.sessions.get('fixture').ptyProcess.write = () => { attempts++; throw new Error('fixture write failure'); };
for (let i = 0; i < 2; i++) {
  try { await failed.manager.submit('fixture', 'same-id', 'retry text', 0); } catch { /* observe attempts */ }
}
console.log('PROTOCOL_AUDIT', JSON.stringify({ id: 'INPUT-08', sends: 2, writeAttempts: attempts }));

const rows = [
  { type: 'event_msg', payload: { type: 'user_message', message: 'same turn' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'same turn' }] } },
];
const decoded = await decodeTranscriptStream(Readable.from(rows.map(row => JSON.stringify(row) + '\n')), 'fixture.jsonl', 0, decodeCodexTranscriptLine, true);
console.log('PROTOCOL_AUDIT', JSON.stringify({ id: 'CHAT-06', inputRecords: rows.length, messages: decoded.messages.map(message => ({ role: message.role, blocks: message.blocks })) }));
for (const type of ['input_text', 'output_text']) {
  const message = decodeCodexTranscriptLine(JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: type === 'input_text' ? 'user' : 'assistant', content: [{ type, text: 'fixture text' }],
  } }), 'fixture');
  console.log('PROTOCOL_AUDIT', JSON.stringify({ id: 'CHAT-06', blockType: type, decoded: message }));
}
