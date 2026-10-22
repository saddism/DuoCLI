import fs from 'fs';
import path from 'path';
import type { TerminalTask, TerminalTaskSnapshot } from './terminal-task-types';

interface StoredTerminalTasks {
  schemaVersion: 1;
  revision: number;
  tasks: TerminalTask[];
}

export class TerminalTaskStore {
  private revision = 0;
  private tasks: TerminalTask[] = [];
  private loadError: string | null = null;

  constructor(private readonly filePath: string) {
    this.load();
  }

  snapshot(): TerminalTaskSnapshot {
    return { revision: this.revision, tasks: this.tasks.map(task => ({ ...task, dependency: task.dependency ? { ...task.dependency } : undefined })) };
  }

  replace(tasks: TerminalTask[]): TerminalTaskSnapshot {
    if (this.loadError) throw new Error(this.loadError);
    const nextRevision = this.revision + 1;
    const payload: StoredTerminalTasks = { schemaVersion: 1, revision: nextRevision, tasks };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
    this.revision = nextRevision;
    this.tasks = tasks;
    return this.snapshot();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<StoredTerminalTasks>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) {
        throw new Error('计划任务文件格式不受支持');
      }
      this.revision = Number.isInteger(parsed.revision) ? Number(parsed.revision) : 0;
      this.tasks = parsed.tasks;
    } catch (error) {
      this.loadError = `计划任务文件读取失败，原文件已保留：${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
