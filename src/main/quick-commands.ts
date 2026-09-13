import fs from 'fs';
import path from 'path';
import os from 'os';

export const DEFAULT_QUICK_COMMANDS = ['/new', '/help', '/compact', '/unicloud-log-viewer', '/uniapp-dev'];
export class QuickCommandStore {
  constructor(private file: string) {}

  read(): { commands: string[]; initialized: boolean } {
    if (!fs.existsSync(this.file)) return { commands: [...DEFAULT_QUICK_COMMANDS], initialized: false };
    return { commands: this.validate(JSON.parse(fs.readFileSync(this.file, 'utf8'))), initialized: true };
  }

  private validate(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 10000)) {
      throw new Error('快捷命令格式无效（最多 200 条，每条最多 10000 字符）');
    }
    return [...new Set(value as string[])];
  }

  update(operation: { action: string; command?: string; commands?: string[] }) {
    const current = this.read();
    let commands = current.commands;
    if (operation.action === 'migrate') {
      if (current.initialized) return current;
      commands = this.validate(operation.commands);
    } else if (operation.action === 'add') {
      commands = this.validate([...commands, operation.command]);
    } else if (operation.action === 'remove') {
      this.validate([operation.command]);
      commands = commands.filter(command => command !== operation.command);
    } else {
      throw new Error('未知快捷命令操作');
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(commands, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    return this.read();
  }
}

export const quickCommands = new QuickCommandStore(path.join(
  process.env.DUOCLI_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.duocli-mobile'), 'quick-commands.json',
));
