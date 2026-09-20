export type NativeChatSource = 'transcript' | 'hook' | 'scrape';

export const NATIVE_CHAT_INTERRUPTED_STATUS_TEXT = 'Conversation interrupted';

export type NativeChatRole = 'user' | 'assistant' | 'tool' | 'reasoning' | 'system';

export type NativeChatTextBlock = {
  type: 'text';
  text: string;
};

export type NativeChatEditPatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export type NativeChatEditPatch = {
  filePath?: string;
  hunks: NativeChatEditPatchHunk[];
};

export type NativeChatToolCallBlock = {
  type: 'tool-call';
  name: string;
  input: unknown;
  callId?: string;
  state?: 'running' | 'completed' | 'failed';
};

export type NativeChatToolResultBlock = {
  type: 'tool-result';
  output: string;
  isError?: boolean;
  callId?: string;
  editPatch?: NativeChatEditPatch;
};

export type NativeChatImageRefBlock = {
  type: 'image-ref';
  path?: string;
  url?: string;
  alt?: string;
};

export type NativeChatSubagentEntry = {
  id: string;
  label: string;
  state: string;
};

export type NativeChatSubagentGroupBlock = {
  type: 'subagent-group';
  groupId: string;
  agents: NativeChatSubagentEntry[];
};

export type NativeChatBlock =
  | NativeChatTextBlock
  | NativeChatToolCallBlock
  | NativeChatToolResultBlock
  | NativeChatImageRefBlock
  | NativeChatSubagentGroupBlock;

export type NativeChatMessage = {
  id: string;
  submissionId?: string;
  role: NativeChatRole;
  blocks: NativeChatBlock[];
  timestamp: number | null;
  source: NativeChatSource;
  turnId?: string;
};

export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'grok' | 'omp';
