export type AttentionKind = 'decision' | 'done' | 'waiting';

export const NOTIFY_COOLDOWN_MS = 45_000;
export const MIN_INPUT_AGE_MS = 12_000;
export const DECISION_SETTLE_MS = 2_000;
export const IDLE_SETTLE_MS = 5_000;
export const NOTIFY_TAIL_CHARS = 2_000;

export function stripAnsiForNotify(text: string): string {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

export function appendNotifyTail(previous: string, chunk: string): string {
  return (previous + chunk).slice(-NOTIFY_TAIL_CHARS);
}

export function settleMsFor(kind: AttentionKind): number {
  return kind === 'decision' ? DECISION_SETTLE_MS : IDLE_SETTLE_MS;
}

export function delayUntilNotify(
  kind: AttentionKind,
  now: number,
  lastInputAt: number,
): number {
  const settle = settleMsFor(kind);
  if (kind === 'decision') return settle;
  const remainInput = Math.max(0, MIN_INPUT_AGE_MS - (now - lastInputAt));
  return Math.max(settle, remainInput);
}

export function classifyAttention(tail: string): AttentionKind | null {
  const text = String(tail || '');
  if (!text.trim()) return null;
  if (isCliWorking(text)) return null;
  if (isDecisionPrompt(text)) return 'decision';
  if (!isIdlePrompt(text)) return null;
  if (isTaskDone(text)) return 'done';
  return 'waiting';
}

export function canNotifyAttention(input: {
  kind: AttentionKind | null;
  armed: boolean;
  now: number;
  lastInputAt: number;
  lastNotifyAt: number;
}): boolean {
  if (!input.kind) return false;
  if (input.now - input.lastNotifyAt < NOTIFY_COOLDOWN_MS) return false;
  if (input.kind !== 'decision' && !input.armed) return false;
  if (input.kind !== 'decision' && input.now - input.lastInputAt < MIN_INPUT_AGE_MS) return false;
  return true;
}

function isCliWorking(tail: string): boolean {
  if (/esc to interrupt/i.test(tail)) return true;
  if (/ctrl(?:\+|-)c to (?:stop|cancel)/i.test(tail)) return true;
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/.test(tail)) return true;
  if (/[✶✻✽✢].{0,48}\(\s*\d/.test(tail)) return true;
  if (/\w+[.…]\s*\(\s*\d/.test(tail)) return true;
  return false;
}

function isDecisionPrompt(tail: string): boolean {
  if (/(?:^|\n).{0,80}Do you want to .+\?/im.test(tail)) return true;
  if (/(?:^|\n).{0,80}Allow .+ to .+\?/im.test(tail)) return true;
  if (/(?:^|\n).{0,80}Would you like to .+\?/im.test(tail)) return true;
  if (/\[(?:y\/n|yes\/no|Y\/n|y\/N)\]/.test(tail)) return true;
  if (/(?:Enter to confirm|Press enter to (?:confirm|continue)|按回车(?:键)?(?:继续|确认))/.test(tail)) return true;
  if (/(?:^|\n)\s*(?:是否继续[？?]|请选择(?:一项|其中一项|操作)[：:]?|输入\s*(?:y|n|yes|no))/im.test(tail)) return true;
  const lastLines = tail.split(/\n/).slice(-12).join('\n');
  if (/(?:^|\n)\s*[❯>]\s*\d+\./.test(lastLines) && /^\s+\d+\.\s/m.test(lastLines)) return true;
  return false;
}

function isIdlePrompt(tail: string): boolean {
  // 必须是单独一行的输入符，避免 Markdown 引用行 `> 正文` 被当成提示符。
  return /(?:^|\n)\s*(?:[a-zA-Z0-9._~\-@:/]*[$#]|[❯›➜]|>(?:\s*))\s*$/.test(tail);
}

function isTaskDone(tail: string): boolean {
  return /(?:任务已完成|已全部完成|工作已完成|All done\.|Task complete\.|I'm done\.)/i.test(tail);
}
