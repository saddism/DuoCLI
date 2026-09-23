export type TerminalTaskStatus =
  | 'pending'
  | 'paused'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'needs_attention';

export interface TerminalTaskDependency {
  kind: 'task' | 'session';
  id: string;
  generation?: number;
}

export interface TerminalTask {
  id: string;
  revision: number;
  requestId: string;
  name: string;
  cwd: string;
  presetCommand: string;
  themeId: string;
  instruction: string;
  notBefore?: number;
  dependency?: TerminalTaskDependency;
  quietMs: number;
  status: TerminalTaskStatus;
  runId?: string;
  sessionId?: string;
  activityGeneration?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  completionReason?: 'quiet' | 'manual';
  error?: string;
}

export interface CreateTerminalTaskInput {
  requestId: string;
  name: string;
  cwd: string;
  presetCommand?: string;
  themeId?: string;
  instruction: string;
  notBefore?: number;
  dependsOnTaskId?: string;
  dependsOnSessionId?: string;
  quietMs?: number;
}

export interface TerminalTaskSnapshot {
  revision: number;
  tasks: TerminalTask[];
}
