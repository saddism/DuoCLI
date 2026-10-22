import { readFile } from 'fs/promises';
import type { NativeChatBlock, NativeChatMessage, NativeChatTranscriptAgent } from './types';
import { asRecord, timestampMs, parseJsonObject } from './values';
import { claudeContentBlocks, toolResultOutput } from './transcript-record-blocks';
import { decodeClaudeTranscriptLine, decodeClaudeTranscriptMessages } from './transcript-line-decoders-claude';
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp';

export function providerMessage(id: string, role: NativeChatMessage['role'], blocks: NativeChatBlock[], time: unknown): NativeChatMessage {
  const stamp = timestampMs(time);
  return { id, role, blocks, timestamp: Number.isFinite(stamp) ? stamp : null, source: 'transcript' };
}

// Follow the recorded leaf. Rewound/forked turns must not leak into the active conversation.
export function activeBranch(records: Record<string, any>[], idKey: string, parentKey: string): Record<string, any>[] {
  const nodes = records.filter(r => typeof r[idKey] === 'string' && r.isSidechain !== true);
  if (!nodes.some(r => Object.prototype.hasOwnProperty.call(r, parentKey))) return records;
  const byId = new Map(nodes.map(r => [r[idKey], r]));
  const explicit = records.filter(r => r.type === 'active-leaf').at(-1)?.leafUuid;
  let leaf = typeof explicit === 'string' ? explicit : nodes.at(-1)?.[idKey];
  const selected = new Set<string>();
  while (leaf && !selected.has(leaf)) {
    selected.add(leaf);
    leaf = byId.get(leaf)?.[parentKey];
  }
  return records.filter(r => r.isSidechain !== true && (!r[idKey] || selected.has(r[idKey])));
}

export async function readProviderTranscript(agent: NativeChatTranscriptAgent, file: string): Promise<NativeChatMessage[]> {
  const text = await readFile(file, 'utf8');
  // JSONL's last record belongs to the writer until the terminating newline arrives.
  let rows: Record<string, any>[] = file.endsWith('.json') ? [JSON.parse(text)]
    : text.slice(0, text.lastIndexOf('\n') + 1).split('\n').map(parseJsonObject).filter(Boolean) as Record<string, any>[];
  if (agent === 'qoder' || agent === 'qodercn' || agent === 'qwen') rows = activeBranch(rows, 'uuid', 'parentUuid');
  if (agent === 'pi') rows = activeBranch(rows, 'id', 'parentId');
  const result: NativeChatMessage[] = [];
  const append = (id: string, role: NativeChatMessage['role'], blocks: NativeChatBlock[], time: unknown) => {
    if (blocks.length) result.push(providerMessage(id, role, blocks, time));
  };
  let stepId = '';
  const steps = new Map<string, NativeChatMessage>();
  for (const [index, r] of rows.entries()) {
    const id = String(r.uuid || r.id || `row-${index}`);
    const time = r.timestamp ?? r.time;
    if (agent === 'agy') {
      const mid = `step-${r.step_index ?? index}`;
      if ((r.source === 'USER_EXPLICIT' || r.source === 'USER') && ['USER_INPUT', 'REQUEST'].includes(r.type) && typeof r.content === 'string') {
        const query = r.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        const text = query ? query[1].trim() : r.content;
        if (text.trim()) append(mid, 'user', [{ type: 'text', text }], r.created_at);
      } else if (r.source === 'MODEL' && r.type === 'PLANNER_RESPONSE') {
        if (typeof r.thinking === 'string' && r.thinking.trim()) append(`${mid}:thinking`, 'reasoning', [{ type: 'text', text: r.thinking }], r.created_at);
        const blocks: NativeChatBlock[] = [];
        if (typeof r.content === 'string' && r.content.trim()) blocks.push({ type: 'text', text: r.content });
        for (const t of r.tool_calls || []) blocks.push({ type: 'tool-call', name: t.name || 'tool', input: t.args });
        append(mid, 'assistant', blocks, r.created_at);
      } else if (r.source === 'MODEL' && r.type === 'GENERIC' && typeof r.content === 'string' && r.content.trim()) {
        append(mid, 'tool', [{ type: 'tool-result', output: r.content, isError: r.status === 'ERROR' || r.status === 'FAILED' }], r.created_at);
      }
      continue;
    }
    if (agent === 'qoder' || agent === 'qodercn' || agent === 'pi') {
      if (agent !== 'pi') result.push(...decodeClaudeTranscriptMessages(JSON.stringify(r), id));
      else {
        const content = r.message?.role === 'assistant' && Array.isArray(r.message.content) ? r.message.content : [];
        const thinking = content.filter((p: any) => p.type === 'thinking');
        if (thinking.length) {
          const reason = decodeOmpTranscriptLine(JSON.stringify({ ...r, message: { ...r.message, content: thinking } }), id);
          if (reason) result.push({ ...reason, id: `${id}:thinking`, role: 'reasoning' });
        }
        const message = decodeOmpTranscriptLine(JSON.stringify(thinking.length ? { ...r, message: { ...r.message, content: content.filter((p: any) => p.type !== 'thinking') } } : r), id);
        if (message) result.push(message);
      }
    } else if (agent === 'qwen') {
      if (r.isMeta || r.isSynthetic || !['user', 'assistant'].includes(r.type)) continue;
      const m = asRecord(r.message);
      if (!m) continue;
      if (m.content) {
        const message = decodeClaudeTranscriptLine(JSON.stringify(r), id);
        if (message) result.push(message);
        continue;
      }
      const normal: NativeChatBlock[] = [], thought: NativeChatBlock[] = [], tools: NativeChatBlock[] = [];
      for (const p of Array.isArray(m.parts) ? m.parts as any[] : []) {
        if (typeof p.text === 'string' && p.text.trim()) (p.thought ? thought : normal).push({ type: 'text', text: p.text });
        if (p.functionCall) normal.push({ type: 'tool-call', name: p.functionCall.name || 'tool', input: p.functionCall.args, callId: p.functionCall.id });
        if (p.functionResponse) tools.push({ type: 'tool-result', callId: p.functionResponse.id, output: toolResultOutput(p.functionResponse.response) });
      }
      append(`${id}:thinking`, 'reasoning', thought, time);
      append(id, r.type === 'user' ? 'user' : 'assistant', normal, time);
      append(`${id}:tools`, 'tool', tools, time);
    } else if (agent === 'gemini') {
      if (Array.isArray(r.$set?.messages)) result.length = 0;
      const messages = r.$set?.messages || r.messages || [r];
      for (const m of messages) {
        if (!['user', 'gemini'].includes(m.type)) continue;
        const mid = String(m.id || id);
        const content = m.type === 'user' ? m.displayContent ?? m.content : m.content;
        const parts = typeof content === 'string' ? [{ text: content }] : content || [];
        const blocks: NativeChatBlock[] = parts.filter((p: any) => typeof p.text === 'string' && p.text.trim() && !(m.type === 'user' && /^(?:<session_context>|<hook_context>|[/?])/.test(p.text.trimStart())))
          .map((p: any) => ({ type: 'text', text: p.text }));
        for (const t of m.toolCalls || []) {
          blocks.push({ type: 'tool-call', name: t.name || 'tool', input: t.args, callId: t.id, state: t.status === 'error' ? 'failed' : 'completed' });
          if (t.result !== undefined) blocks.push({ type: 'tool-result', output: toolResultOutput(t.result), callId: t.id, isError: t.status === 'error' });
        }
        append(mid, m.type === 'user' ? 'user' : 'assistant', blocks, m.timestamp);
        append(`${mid}:thinking`, 'reasoning', (m.thoughts || []).map((t: any) => ({ type: 'text', text: t.description || t.subject || '' })).filter((t: any) => t.text), m.timestamp);
      }
    } else if (agent === 'kiro') {
      const m = r.data;
      if (!m || !['Prompt', 'AssistantMessage', 'ToolResults'].includes(r.kind)) continue;
      const blocks: NativeChatBlock[] = [], thought: NativeChatBlock[] = [];
      for (const p of m.content || []) {
        if (p.kind === 'text' && typeof p.data === 'string') blocks.push({ type: 'text', text: p.data });
        if (p.kind === 'thinking' && typeof p.data?.text === 'string') thought.push({ type: 'text', text: p.data.text });
        if (p.kind === 'toolUse') blocks.push({ type: 'tool-call', name: p.data?.name || 'tool', input: p.data?.input, callId: p.data?.toolUseId });
        if (p.kind === 'toolResult') blocks.push({ type: 'tool-result', output: (p.data?.content || []).map((c: any) => typeof c.data === 'string' ? c.data : c.text || toolResultOutput(c)).join('\n'), callId: p.data?.toolUseId, isError: p.data?.status === 'error' });
      }
      append(`${m.message_id || id}:thinking`, 'reasoning', thought, m.meta?.timestamp);
      append(m.message_id || id, r.kind === 'Prompt' ? 'user' : r.kind === 'ToolResults' ? 'tool' : 'assistant', blocks, m.meta?.timestamp);
    } else if (agent === 'kimi') {
      if (['user', 'assistant', 'tool'].includes(r.role)) {
        const blocks: NativeChatBlock[] = r.role === 'tool' ? [{ type: 'tool-result' as const, output: toolResultOutput(r.content), callId: r.tool_call_id }]
          : claudeContentBlocks(r.content);
        for (const t of r.tool_calls || []) blocks.push({ type: 'tool-call', name: t.function?.name || t.name || 'tool', input: t.function?.arguments ?? t.arguments, callId: t.id });
        append(id, r.role, blocks, time);
        continue;
      }
      if (r.type === 'context.append_message' && r.message?.role === 'user' && r.message.origin?.kind === 'user') {
        append(id, 'user', claudeContentBlocks(r.message.content), time);
      }
      const e = r.type === 'context.append_loop_event' ? r.event : null;
      if (!e) continue;
      if (e.type === 'step.begin') stepId = e.uuid;
      if (e.type === 'content.part') {
        const reasoning = e.part?.type === 'think' || e.part?.type === 'thinking';
        const chunk = reasoning ? e.part.think ?? e.part.thinking : e.part?.type === 'text' ? e.part.text : null;
        if (typeof chunk !== 'string') continue;
        const key = `${e.stepUuid || stepId || e.uuid}:${reasoning ? 'thinking' : 'text'}`;
        let message = steps.get(key);
        if (!message) {
          message = providerMessage(key, reasoning ? 'reasoning' : 'assistant', [{ type: 'text', text: '' }], time);
          steps.set(key, message); result.push(message);
        }
        (message.blocks[0] as { type: 'text'; text: string }).text += chunk;
      }
      if (e.type === 'tool.call') append(e.uuid || id, 'assistant', [{ type: 'tool-call', name: e.name || 'tool', input: e.args, callId: e.toolCallId }], time);
      if (e.type === 'tool.result') append(`${e.toolCallId}:result`, 'tool', [{ type: 'tool-result', callId: e.toolCallId, output: toolResultOutput(e.result?.output ?? e.result), isError: e.result?.isError === true }], time);
    }
  }
  // Snapshot-style records replace the same message; real repeated turns retain distinct ids.
  const byId = new Map<string, NativeChatMessage>();
  for (const m of result) byId.set(`${m.role}:${m.id}`, m);
  return [...byId.values()];
}
