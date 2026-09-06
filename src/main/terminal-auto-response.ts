export interface TerminalAutoResponseRule {
  keyword: string;
  response: string;
}

export interface TerminalAutoResponseConfig {
  enabled: boolean;
  rules: TerminalAutoResponseRule[];
  delaySeconds: number;
  cooldownSeconds: number;
}

export const DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG: TerminalAutoResponseConfig = {
  enabled: false,
  rules: [{ keyword: 'Selected model is at capacity', response: '继续' }],
  delaySeconds: 2,
  cooldownSeconds: 60,
};

const MAX_RULES = 20;
const MAX_KEYWORD_LENGTH = 200;
const MAX_RESPONSE_LENGTH = 2000;

function clampSeconds(value: unknown, fallback: number, maximum: number): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return fallback;
  return Math.min(Math.max(seconds, 0), maximum);
}

export function normalizeTerminalAutoResponseConfig(value: unknown): TerminalAutoResponseConfig {
  const source = value && typeof value === 'object' ? value as Partial<TerminalAutoResponseConfig> : {};
  const rawRules = Array.isArray(source.rules) ? source.rules : DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG.rules;
  const rules: TerminalAutoResponseRule[] = [];

  for (const rawRule of rawRules.slice(0, MAX_RULES)) {
    if (!rawRule || typeof rawRule !== 'object') continue;
    const { keyword, response } = rawRule as Partial<TerminalAutoResponseRule>;
    const cleanKeyword = String(keyword || '').trim().slice(0, MAX_KEYWORD_LENGTH);
    const cleanResponse = String(response || '').trim().slice(0, MAX_RESPONSE_LENGTH);
    if (cleanKeyword && cleanResponse) rules.push({ keyword: cleanKeyword, response: cleanResponse });
  }

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG.enabled,
    rules,
    delaySeconds: clampSeconds(source.delaySeconds, DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG.delaySeconds, 60),
    cooldownSeconds: clampSeconds(source.cooldownSeconds, DEFAULT_TERMINAL_AUTO_RESPONSE_CONFIG.cooldownSeconds, 3600),
  };
}

/**
 * 仅返回“在本次新增文本中完成匹配”的第一条规则，避免旧终端历史反复触发。
 */
export function findNewAutoResponseRule(
  previousTail: string,
  newText: string,
  rules: TerminalAutoResponseRule[],
): TerminalAutoResponseRule | null {
  const combined = (previousTail + newText).toLocaleLowerCase();
  const newTextStart = previousTail.length;

  for (const rule of rules) {
    const keyword = rule.keyword.toLocaleLowerCase();
    const matchAt = combined.lastIndexOf(keyword);
    if (matchAt !== -1 && matchAt + keyword.length > newTextStart) return rule;
  }
  return null;
}
