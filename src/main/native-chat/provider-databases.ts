import { execFile } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { NativeChatBlock, NativeChatMessage, NativeChatTranscriptAgent } from './types';
import { providerMessage } from './provider-transcripts';
import { toolResultOutput } from './transcript-record-blocks';

const run = promisify(execFile);
const cache = new Map<string, { revision: string; messages: NativeChatMessage[] }>();

// Async, read-only and session-scoped: never load a provider's entire database into memory.
export async function queryChatDatabase(file: string, sql: string): Promise<any[]> {
  const { stdout } = await run('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 1000', file, sql], {
    timeout: 5000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

function quote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function revisionOf(file: string): string {
  return [file, `${file}-wal`].map(path => {
    try { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return '0'; }
  }).join(':');
}

export function providerDatabasePath(agent: NativeChatTranscriptAgent, id: string, root?: string): string | null {
  if (!['cursor', 'devin', 'zcode', 'opencode', 'codex'].includes(agent)) return null;
  const home = homedir();
  if (agent === 'cursor') {
    const base = root || join(home, '.cursor', 'chats');
    try {
      for (const workspace of readdirSync(base)) {
        const file = join(base, workspace, id, 'store.db');
        if (existsSync(file)) return file;
      }
    } catch { /* not yet saved */ }
    return null;
  }
  const files = agent === 'devin' ? [join(home, '.local', 'share', 'devin', 'cli', 'sessions.db')]
    : agent === 'zcode' ? [join(home, '.zcode', 'cli', 'db', 'db.sqlite')]
    : agent === 'opencode' ? [join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode', 'opencode.db')]
    : agent === 'codex' ? [join(process.env.CODEX_HOME || join(home, '.codex'), 'thread_history_1.sqlite')] : [];
  if (root) return existsSync(root) ? root : null;
  return files.find(existsSync) || null;
}

// Cursor root field 1 contains the ordered SHA-256 message references. Other
// fields hold token budgets/editor state; neither rowid nor all blobs is history.
export function cursorMessageRefs(bytes: Buffer): string[] {
  let offset = 0;
  const refs: string[] = [];
  const readVarint = () => {
    let value = 0, shift = 0;
    while (offset < bytes.length && shift < 49) {
      const byte = bytes[offset++]; value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error('Invalid Cursor root record');
  };
  while (offset < bytes.length) {
    const tag = readVarint(), kind = tag & 7, field = Math.floor(tag / 8);
    if (kind === 2) {
      const length = readVarint();
      if (length > bytes.length - offset) throw new Error('Incomplete Cursor root record');
      if (field === 1 && length === 32) refs.push(bytes.subarray(offset, offset + length).toString('hex'));
      offset += length;
    } else if (kind === 0) readVarint();
    else if (kind === 1) offset += 8;
    else if (kind === 5) offset += 4;
    else throw new Error('Unsupported Cursor root format');
  }
  return refs;
}

function cursorMessages(rows: any[], refs: string[]): NativeChatMessage[] {
  const byId = new Map(rows.map(r => [r.id, JSON.parse(Buffer.from(r.data, 'hex').toString('utf8'))]));
  const result: NativeChatMessage[] = [];
  for (const id of refs) {
    const r = byId.get(id);
    if (!r || !['user', 'assistant', 'tool'].includes(r.role)) continue;
    const normal: NativeChatBlock[] = [], thought: NativeChatBlock[] = [];
    const parts = typeof r.content === 'string' ? [{ type: 'text', text: r.content }] : r.content || [];
    for (const p of parts) {
      if ((p.type === 'text' || p.type === 'reasoning') && typeof p.text === 'string') {
        let text = p.text;
        if (r.role === 'user') {
          const query = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
          if (query) text = query[1].trim();
          else if (/^\s*<(?:user_info|system_reminder|environment_context|rules|session_context|dynamic_tools)>/.test(text)) continue;
        }
        if (text.trim()) (p.type === 'reasoning' ? thought : normal).push({ type: 'text', text });
      } else if (p.type === 'tool-call') normal.push({ type: 'tool-call', name: p.toolName || 'tool', input: p.args, callId: p.toolCallId });
      else if (p.type === 'tool-result') normal.push({ type: 'tool-result', output: toolResultOutput(p.result), callId: p.toolCallId });
    }
    if (thought.length) result.push(providerMessage(`${id}:thinking`, 'reasoning', thought, null));
    if (normal.length) result.push(providerMessage(id, r.role, normal, null));
  }
  return result;
}

function openCodeMessages(rows: any[]): NativeChatMessage[] {
  const messages = new Map<string, NativeChatMessage>();
  for (const row of rows) {
    const r = JSON.parse(row.message_data);
    if (!['user', 'assistant'].includes(r.role) || r.synthetic === true || r.semantics?.uiVisibility === 'hidden') continue;
    const p = row.part_data ? JSON.parse(row.part_data) : null;
    if (!p || p.synthetic === true || p.ignored === true) continue;
    const role = p.type === 'reasoning' ? 'reasoning' : r.role;
    const key = `${row.id}:${role}`;
    let message = messages.get(key);
    if (!message) { message = providerMessage(key, role, [], row.time_created); messages.set(key, message); }
    if (p.type === 'text' || p.type === 'reasoning') {
      if (p.text) message.blocks.push({ type: 'text', text: p.text });
    } else if (p.type === 'tool') {
      const s = p.state || {};
      message.blocks.push({ type: 'tool-call', name: p.tool || 'tool', input: s.input, callId: p.callID,
        state: s.status === 'error' ? 'failed' : s.status === 'completed' ? 'completed' : 'running' });
      if (s.output !== undefined || s.error !== undefined) message.blocks.push({ type: 'tool-result', output: toolResultOutput(s.output ?? s.error), callId: p.callID, isError: s.status === 'error' });
    } else if (p.type === 'file' && p.mime?.startsWith('image/') && p.url) message.blocks.push({ type: 'image-ref', url: p.url, alt: p.filename });
  }
  return [...messages.values()].filter(m => m.blocks.length);
}

function devinMessages(rows: any[]): NativeChatMessage[] {
  const result: NativeChatMessage[] = [];
  for (const row of rows) {
    const r = JSON.parse(row.chat_message) || {}, meta = JSON.parse(row.metadata || '{}') || {};
    if (!['user', 'assistant', 'tool'].includes(r.role) || meta.is_system_prefix || (r.role === 'user' && r.metadata?.is_user_input !== true)) continue;
    const id = String(row.node_id), blocks: NativeChatBlock[] = [];
    if (r.role === 'tool') blocks.push({ type: 'tool-result', callId: r.tool_call_id || r.message_id, output: toolResultOutput(r.content) });
    else {
      if (typeof r.content === 'string' && r.content.trim()) blocks.push({ type: 'text', text: r.content });
      for (const t of r.tool_calls || []) blocks.push({ type: 'tool-call', name: t.function?.name || t.name || 'tool', input: t.function?.arguments ?? t.arguments, callId: t.id });
    }
    if (r.thinking?.thinking) result.push(providerMessage(`${id}:thinking`, 'reasoning', [{ type: 'text', text: r.thinking.thinking }], row.created_at));
    if (blocks.length) result.push(providerMessage(id, r.role, blocks, row.created_at));
  }
  return result;
}

function codexMessages(rows: any[]): NativeChatMessage[] {
  return rows.flatMap(row => {
    const r = JSON.parse(row.item_json), blocks: NativeChatBlock[] = [];
    let role: NativeChatMessage['role'] = 'assistant';
    if (r.type === 'userMessage') {
      role = 'user';
      for (const p of r.content || []) {
        if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
        if (p.type === 'image' && p.url) blocks.push({ type: 'image-ref', url: p.url });
        if (p.type === 'localImage' && p.path) blocks.push({ type: 'image-ref', path: p.path });
      }
    } else if (r.type === 'agentMessage' && r.text) blocks.push({ type: 'text', text: r.text });
    else if (r.type === 'plan' && r.text) blocks.push({ type: 'text', text: r.text });
    else if (r.type === 'imageView' && r.path) blocks.push({ type: 'image-ref', path: r.path });
    else if (r.type === 'fileChange') {
      blocks.push({ type: 'tool-call', name: 'apply_patch', input: r.changes, callId: r.id, state: r.status === 'failed' ? 'failed' : r.status === 'completed' ? 'completed' : 'running' });
      blocks.push({ type: 'tool-result', output: toolResultOutput(r.changes), callId: r.id, isError: r.status === 'failed' });
    } else if (r.type === 'webSearch') {
      blocks.push({ type: 'tool-call', name: 'web_search', input: r.query ?? r.action, callId: r.id, state: 'completed' });
      if (r.results != null) blocks.push({ type: 'tool-result', output: toolResultOutput(r.results), callId: r.id });
    } else if (r.type === 'collabAgentToolCall') {
      blocks.push({ type: 'tool-call', name: r.tool || 'agent', input: r.prompt, callId: r.id });
      if (r.agentsStates != null) blocks.push({ type: 'tool-result', output: toolResultOutput(r.agentsStates), callId: r.id });
    } else if (r.type === 'imageGeneration') {
      blocks.push({ type: 'tool-call', name: 'image_generation', input: r.revisedPrompt, callId: r.id, state: r.status === 'failed' ? 'failed' : r.status === 'completed' ? 'completed' : 'running' });
      if (r.savedPath) blocks.push({ type: 'image-ref', path: r.savedPath });
      else if (r.result != null || r.failure != null) blocks.push({ type: 'tool-result', output: toolResultOutput(r.failure ?? r.result), callId: r.id, isError: r.failure != null });
    }
    else if (r.type === 'reasoning') {
      role = 'reasoning';
      for (const text of [...r.summary || [], ...r.content || []]) if (typeof text === 'string' && text.trim()) blocks.push({ type: 'text', text });
    } else if (r.type === 'commandExecution' || r.type === 'mcpToolCall' || r.type === 'dynamicToolCall') {
      blocks.push({ type: 'tool-call', name: r.tool || (r.type === 'commandExecution' ? 'shell' : 'tool'), input: r.arguments ?? r.command, callId: r.id,
        state: r.status === 'failed' ? 'failed' : r.status === 'completed' ? 'completed' : 'running' });
      if (r.aggregatedOutput != null || r.result != null || r.error != null) blocks.push({ type: 'tool-result', output: toolResultOutput(r.aggregatedOutput ?? r.result ?? r.error), callId: r.id, isError: r.status === 'failed' || (typeof r.exitCode === 'number' && r.exitCode !== 0) });
    }
    return blocks.length ? [providerMessage(r.id || row.item_id, role, blocks, row.created_at_ms)] : [];
  });
}

export async function readProviderDatabase(agent: NativeChatTranscriptAgent, id: string, file: string): Promise<{ messages: NativeChatMessage[]; filePath: string; revision: string } | null> {
  const revision = revisionOf(file), key = `${agent}:${file}:${id}`;
  const prior = cache.get(key);
  if (prior?.revision === revision) return { messages: prior.messages, filePath: file, revision };
  let messages: NativeChatMessage[];
  if (agent === 'cursor') {
    const [row] = await queryChatDatabase(file, 'SELECT value FROM meta WHERE key=\'0\'');
    if (!row) return null;
    const meta = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'));
    if (meta.agentId !== id) throw new Error('Cursor session identity mismatch');
    const [root] = await queryChatDatabase(file, `SELECT hex(data) AS data FROM blobs WHERE id=${quote(meta.latestRootBlobId)}`);
    if (!root) return null;
    const refs = cursorMessageRefs(Buffer.from(root.data, 'hex'));
    if (!refs.length) messages = [];
    else messages = cursorMessages(await queryChatDatabase(file, `SELECT id,hex(data) AS data FROM blobs WHERE id IN (${refs.map(quote).join(',')})`), refs);
  } else if (agent === 'devin') {
    const rows = await queryChatDatabase(file, `WITH RECURSIVE chain AS (
      SELECT n.* FROM message_nodes n JOIN sessions s ON s.id=n.session_id AND s.main_chain_id=n.node_id WHERE s.id=${quote(id)}
      UNION ALL SELECT n.* FROM message_nodes n JOIN chain c ON n.session_id=c.session_id AND n.node_id=c.parent_node_id
    ) SELECT * FROM chain ORDER BY row_id`);
    messages = devinMessages(rows);
  } else if (agent === 'codex') {
    const rows = await queryChatDatabase(file, `SELECT item_id,item_json,created_at_ms,rollout_ordinal FROM thread_items WHERE thread_id=${quote(id)}
      UNION ALL SELECT item_id,item_json,created_at_ms,rollout_ordinal FROM thread_realtime_items WHERE thread_id=${quote(id)} ORDER BY rollout_ordinal`);
    if (!rows.length) return null; // Older CLIs still write only JSONL.
    messages = [...new Map(codexMessages(rows).map(m => [`${m.role}:${m.id}`, m])).values()];
  } else {
    const columns = await queryChatDatabase(file, "SELECT 'message' AS tbl,name FROM pragma_table_info('message') UNION ALL SELECT 'part' AS tbl,name FROM pragma_table_info('part')");
    const messageOrder = columns.some(c => c.tbl === 'message' && c.name === 'sequence') ? 'm.sequence,m.time_created,m.id' : 'm.time_created,m.id';
    const partOrder = columns.some(c => c.tbl === 'part' && c.name === 'sequence') ? 'p.sequence,p.time_created,p.id' : 'p.time_created,p.id';
    const rows = await queryChatDatabase(file, `SELECT m.id,m.time_created,m.data AS message_data,p.data AS part_data
      FROM message m LEFT JOIN part p ON p.message_id=m.id AND p.session_id=m.session_id
      WHERE m.session_id=${quote(id)} ORDER BY ${messageOrder},${partOrder}`);
    messages = openCodeMessages(rows);
  }
  cache.set(key, { revision, messages });
  if (cache.size > 24) cache.delete(cache.keys().next().value!);
  return { messages, filePath: file, revision };
}
