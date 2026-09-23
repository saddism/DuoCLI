import crypto from 'crypto';
import type { TerminalActivityState, TerminalActivityTracker } from './terminal-activity-tracker';
import type { TerminalTaskStore } from './terminal-task-store';
import type { CreateTerminalTaskInput, TerminalTask, TerminalTaskSnapshot } from './terminal-task-types';

interface TerminalTaskLauncher {
  create(task: TerminalTask): Promise<{ sessionId: string }>;
  submit(sessionId: string, instruction: string, submissionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  hasSession(sessionId: string): boolean;
  hasInputAutomation?(sessionId: string): boolean;
}

const MIN_QUIET_MS = 1000;
const MAX_QUIET_MS = 3_600_000;

export class TerminalTaskScheduler {
  private tasks: TerminalTask[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;
  private readonly listeners = new Set<(snapshot: TerminalTaskSnapshot) => void>();
  private readonly unsubscribeActivity: () => void;

  constructor(
    private readonly store: TerminalTaskStore,
    private readonly activity: TerminalActivityTracker,
    private readonly launcher: TerminalTaskLauncher,
    private readonly now: () => number = Date.now,
  ) {
    this.tasks = store.snapshot().tasks;
    this.recoverInterruptedTasks();
    this.unsubscribeActivity = activity.onChange(state => this.onActivity(state));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.evaluate(); }, 1000);
    void this.evaluate();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeActivity();
  }

  onChange(listener: (snapshot: TerminalTaskSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): TerminalTaskSnapshot {
    return this.store.snapshot();
  }

  isManagedSessionActive(sessionId: string): boolean {
    return this.tasks.some(task => task.sessionId === sessionId && ['starting', 'running'].includes(task.status));
  }

  create(input: CreateTerminalTaskInput): TerminalTask {
    const duplicate = this.tasks.find(task => task.requestId === input.requestId);
    if (duplicate) {
      const same = duplicate.name === String(input.name || '').trim()
        && duplicate.cwd === String(input.cwd || '').trim()
        && duplicate.instruction === String(input.instruction || '').trim()
        && duplicate.presetCommand === String(input.presetCommand || '');
      if (!same) throw new Error('请求编号已用于另一个任务');
      return { ...duplicate };
    }
    const name = String(input.name || '').trim();
    const cwd = String(input.cwd || '').trim();
    const instruction = String(input.instruction || '').trim();
    if (!input.requestId || input.requestId.length > 128) throw new Error('无效的请求编号');
    if (!name || name.length > 120) throw new Error('任务名称应为 1–120 个字符');
    if (!cwd) throw new Error('请选择工作目录');
    if (!instruction || instruction.length > 100_000) throw new Error('任务指令应为 1–100000 个字符');
    if (input.dependsOnTaskId && input.dependsOnSessionId) throw new Error('只能选择一个前置任务');
    if (input.dependsOnTaskId && !this.tasks.some(task => task.id === input.dependsOnTaskId)) throw new Error('前置任务不存在');
    const notBefore = Number(input.notBefore);
    const quietMs = Number(input.quietMs ?? 10_000);
    if (!Number.isFinite(quietMs) || quietMs < MIN_QUIET_MS || quietMs > MAX_QUIET_MS) throw new Error('静止时间应为 1–3600 秒');
    let dependency: TerminalTask['dependency'];
    if (input.dependsOnTaskId) dependency = { kind: 'task', id: input.dependsOnTaskId };
    if (input.dependsOnSessionId) {
      if (!this.launcher.hasSession(input.dependsOnSessionId)) throw new Error('前置终端不存在');
      if (this.launcher.hasInputAutomation?.(input.dependsOnSessionId)) throw new Error('前置终端正在使用循环计划，请先停用');
      const current = this.activity.get(input.dependsOnSessionId);
      dependency = {
        kind: 'session',
        id: input.dependsOnSessionId,
        generation: current?.status === 'running' ? current.generation : (current?.generation || 0) + 1,
      };
    }
    const now = this.now();
    const task: TerminalTask = {
      id: crypto.randomUUID(),
      revision: 1,
      requestId: input.requestId,
      name,
      cwd,
      presetCommand: String(input.presetCommand || ''),
      themeId: String(input.themeId || 'default'),
      instruction,
      notBefore: Number.isFinite(notBefore) && notBefore > 0 ? notBefore : undefined,
      dependency,
      quietMs: Math.floor(quietMs),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks = [...this.tasks, task];
    this.persist();
    void this.evaluate();
    return { ...task };
  }

  update(taskId: string, input: Partial<CreateTerminalTaskInput> & { expectedRevision?: number }): TerminalTask {
    const task = this.requireTask(taskId);
    if (!['pending', 'paused', 'blocked'].includes(task.status)) throw new Error('只能修改尚未启动的任务');
    if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision) throw new Error('任务已被其他设备修改，请刷新后重试');
    const name = input.name === undefined ? task.name : String(input.name).trim();
    const instruction = input.instruction === undefined ? task.instruction : String(input.instruction).trim();
    const quietMs = input.quietMs === undefined ? task.quietMs : Number(input.quietMs);
    if (!name || name.length > 120) throw new Error('任务名称应为 1–120 个字符');
    if (!instruction || instruction.length > 100_000) throw new Error('任务指令应为 1–100000 个字符');
    if (!Number.isFinite(quietMs) || quietMs < MIN_QUIET_MS || quietMs > MAX_QUIET_MS) throw new Error('静止时间应为 1–3600 秒');
    if (input.dependsOnTaskId && input.dependsOnSessionId) throw new Error('只能选择一个前置任务');
    let dependency = task.dependency;
    if (Object.prototype.hasOwnProperty.call(input, 'dependsOnTaskId') || Object.prototype.hasOwnProperty.call(input, 'dependsOnSessionId')) {
      dependency = undefined;
      if (input.dependsOnTaskId) {
        if (input.dependsOnTaskId === task.id || !this.tasks.some(item => item.id === input.dependsOnTaskId)) throw new Error('前置任务无效');
        if (this.dependsOn(input.dependsOnTaskId, task.id)) throw new Error('任务依赖不能形成循环');
        dependency = { kind: 'task', id: input.dependsOnTaskId };
      } else if (input.dependsOnSessionId) {
        if (!this.launcher.hasSession(input.dependsOnSessionId)) throw new Error('前置终端不存在');
        if (this.launcher.hasInputAutomation?.(input.dependsOnSessionId)) throw new Error('前置终端正在使用循环计划，请先停用');
        const current = this.activity.get(input.dependsOnSessionId);
        dependency = { kind: 'session', id: input.dependsOnSessionId, generation: current?.status === 'running' ? current.generation : (current?.generation || 0) + 1 };
      }
    }
    task.name = name;
    task.instruction = instruction;
    task.notBefore = input.notBefore === undefined ? task.notBefore : (Number(input.notBefore) > 0 ? Number(input.notBefore) : undefined);
    task.quietMs = Math.floor(quietMs);
    task.dependency = dependency;
    task.status = task.status === 'paused' ? 'paused' : 'pending';
    task.error = undefined;
    this.touch(task);
    this.persist();
    void this.evaluate();
    return { ...task };
  }

  pause(taskId: string): TerminalTask {
    const task = this.requireTask(taskId);
    if (!['pending', 'blocked'].includes(task.status)) throw new Error('只能暂停尚未启动的任务');
    task.status = 'paused';
    task.error = undefined;
    this.touch(task);
    this.persist();
    return { ...task };
  }

  resume(taskId: string): TerminalTask {
    const task = this.requireTask(taskId);
    if (task.status !== 'paused') throw new Error('只能继续已暂停的任务');
    task.status = this.dependencyComplete(task) ? 'pending' : 'blocked';
    task.error = task.status === 'blocked' ? '前置任务尚未完成' : undefined;
    this.touch(task);
    this.persist();
    void this.evaluate();
    return { ...task };
  }

  runNow(taskId: string): TerminalTask {
    const task = this.requireTask(taskId);
    if (!['pending', 'paused', 'blocked'].includes(task.status)) throw new Error('只能立即执行尚未启动的任务');
    if (!this.dependencyComplete(task)) throw new Error('前置任务尚未完成');
    task.notBefore = undefined;
    task.status = 'pending';
    task.error = undefined;
    this.touch(task);
    this.persist();
    void this.evaluate();
    return { ...task };
  }

  remove(taskId: string): TerminalTaskSnapshot {
    const task = this.requireTask(taskId);
    const wasCompleted = task.status === 'completed';
    if (['starting', 'running'].includes(task.status) && task.sessionId) {
      void this.launcher.cancel(task.sessionId).catch(() => {});
    }
    this.tasks = this.tasks.filter(item => item.id !== taskId);
    for (const item of this.tasks) {
      if (item.dependency?.kind !== 'task' || item.dependency.id !== taskId) continue;
      if (wasCompleted) {
        item.dependency = undefined;
        if (item.status === 'blocked') {
          item.status = 'pending';
          item.error = undefined;
        }
      } else if (['pending', 'paused', 'blocked'].includes(item.status)) {
        item.status = 'blocked';
        item.error = '前置任务已删除';
      }
      this.touch(item);
    }
    this.persist();
    void this.evaluate();
    return this.snapshot();
  }

  cancel(taskId: string): TerminalTask {
    const task = this.requireTask(taskId);
    if (task.status === 'completed' || task.status === 'cancelled') return { ...task };
    task.status = 'cancelled';
    task.error = undefined;
    this.touch(task);
    this.persist();
    if (task.sessionId) void this.launcher.cancel(task.sessionId).catch(() => {});
    this.blockDependents(task.id, '前置任务已取消');
    return { ...task };
  }

  confirmComplete(taskId: string): TerminalTask {
    const task = this.requireTask(taskId);
    if (!['running', 'needs_attention'].includes(task.status)) throw new Error('当前任务不能确认完成');
    this.complete(task, 'manual');
    void this.evaluate();
    return { ...task };
  }

  sessionExited(sessionId: string, userClosed = false): void {
    const task = this.tasks.find(item => item.sessionId === sessionId && ['starting', 'running'].includes(item.status));
    if (!task) return;
    task.status = userClosed ? 'cancelled' : 'needs_attention';
    task.error = userClosed ? '计划终端已由用户关闭' : '终端已退出，请确认任务是否完成';
    this.touch(task);
    this.persist();
    this.blockDependents(task.id, userClosed ? '前置任务已取消' : '前置任务需要确认');
  }

  private async evaluate(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const now = this.now();
      for (const task of this.tasks) {
        if (task.status !== 'pending' || (task.notBefore && task.notBefore > now)) continue;
        if (!this.dependencyComplete(task)) continue;
        await this.launch(task);
      }
    } finally {
      this.evaluating = false;
    }
  }

  private dependencyComplete(task: TerminalTask): boolean {
    if (!task.dependency) return true;
    if (task.dependency.kind === 'task') {
      return this.tasks.find(item => item.id === task.dependency?.id)?.status === 'completed';
    }
    const state = this.activity.get(task.dependency.id);
    return state?.status === 'stopped' && state.generation >= (task.dependency.generation || 1);
  }

  private async launch(task: TerminalTask): Promise<void> {
    task.status = 'starting';
    task.runId = crypto.randomUUID();
    task.error = undefined;
    this.touch(task);
    this.persist();
    const runId = task.runId;
    try {
      const created = await this.launcher.create(task);
      if (task.status !== 'starting' || task.runId !== runId) {
        await this.launcher.cancel(created.sessionId);
        return;
      }
      task.sessionId = created.sessionId;
      this.touch(task);
      this.persist();
      const submissionId = `terminal-task-${task.id}-${runId}`;
      await this.launcher.submit(created.sessionId, task.instruction, submissionId);
      if (task.status !== 'starting' || task.runId !== runId) return;
      const armed = this.activity.arm(created.sessionId, task.quietMs);
      task.activityGeneration = armed.generation;
      task.status = 'running';
      this.touch(task);
      this.persist();
    } catch (error) {
      if (task.runId !== runId || (task.status as string) === 'cancelled') return;
      task.status = task.sessionId ? 'needs_attention' : 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      this.touch(task);
      this.persist();
      this.blockDependents(task.id, `前置任务${task.status === 'failed' ? '失败' : '需要确认'}`);
    }
  }

  private onActivity(state: TerminalActivityState): void {
    if (state.status !== 'stopped') return;
    let changed = false;
    for (const task of this.tasks) {
      if (task.status !== 'running' || task.sessionId !== state.sessionId) continue;
      if (state.generation < (task.activityGeneration || 0)) continue;
      task.status = 'completed';
      task.completedAt = this.now();
      task.completionReason = 'quiet';
      task.error = undefined;
      this.touch(task);
      changed = true;
    }
    if (changed) this.persist();
    void this.evaluate();
  }

  private complete(task: TerminalTask, reason: 'quiet' | 'manual'): void {
    task.status = 'completed';
    task.completedAt = this.now();
    task.completionReason = reason;
    task.error = undefined;
    this.touch(task);
    this.persist();
  }

  private blockDependents(taskId: string, reason: string): void {
    let changed = false;
    const newlyBlocked: string[] = [];
    for (const task of this.tasks) {
      if (task.status === 'pending' && task.dependency?.kind === 'task' && task.dependency.id === taskId) {
        task.status = 'blocked';
        task.error = reason;
        this.touch(task);
        newlyBlocked.push(task.id);
        changed = true;
      }
    }
    if (changed) this.persist();
    for (const id of newlyBlocked) this.blockDependents(id, '前置任务链已受阻');
  }

  private recoverInterruptedTasks(): void {
    let changed = false;
    for (const task of this.tasks) {
      if (task.status === 'starting' || task.status === 'running') {
        task.status = 'needs_attention';
        task.error = '应用重启后无法确认上次执行结果';
        this.touch(task);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private requireTask(taskId: string): TerminalTask {
    const task = this.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('任务不存在');
    return task;
  }

  private dependsOn(taskId: string, targetId: string): boolean {
    const seen = new Set<string>();
    let current = this.tasks.find(task => task.id === taskId);
    while (current?.dependency?.kind === 'task' && !seen.has(current.id)) {
      if (current.dependency.id === targetId) return true;
      seen.add(current.id);
      current = this.tasks.find(task => task.id === current?.dependency?.id);
    }
    return false;
  }

  private touch(task: TerminalTask): void {
    task.revision += 1;
    task.updatedAt = this.now();
  }

  private persist(): void {
    try {
      const snapshot = this.store.replace(this.tasks);
      for (const listener of this.listeners) listener(snapshot);
    } catch (error) {
      this.tasks = this.store.snapshot().tasks;
      throw error;
    }
  }
}
