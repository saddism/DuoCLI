import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);
const writeFileAsync = promisify(fs.writeFile);
const mkdtempAsync = promisify(fs.mkdtemp);
const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);

const BRANCH_NAME = '_duocli_snapshots';
const DEBOUNCE_MS = 30000; // 30秒防抖

export interface SnapshotInfo {
  id: string;       // commit hash
  message: string;
  timestamp: number; // unix seconds
  fileCount: number;
}

export interface SnapshotFile {
  path: string;
  status: string; // A/M/D
}

export class SnapshotManager {
  private lastSnapshotTime: Map<string, number> = new Map();

  // 执行 git 命令的辅助方法
  private async git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
    const result = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  }

  // 检测是否 Git 仓库
  async isGitRepo(cwd: string): Promise<boolean> {
    try {
      await this.git(cwd, ['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  // 获取 .git 目录的绝对路径
  private async getGitDir(cwd: string): Promise<string> {
    return this.git(cwd, ['rev-parse', '--absolute-git-dir']);
  }

  // 获取仓库根目录
  private async getRepoRoot(cwd: string): Promise<string> {
    return this.git(cwd, ['rev-parse', '--show-toplevel']);
  }

  // 检查孤儿分支是否存在
  private async branchExists(cwd: string): Promise<boolean> {
    try {
      await this.git(cwd, ['rev-parse', '--verify', `refs/heads/${BRANCH_NAME}`]);
      return true;
    } catch {
      return false;
    }
  }

  // 用 git plumbing 命令创建孤儿分支（不切换分支）
  async ensureOrphanBranch(cwd: string): Promise<void> {
    if (await this.branchExists(cwd)) return;

    // 创建空 tree
    const emptyTree = await this.git(cwd, ['hash-object', '-t', 'tree', '/dev/null']);
    // 创建初始 commit
    const commit = await this.git(cwd, ['commit-tree', emptyTree, '-m', 'DuoCLI snapshots root']);
    // 创建分支引用
    await this.git(cwd, ['update-ref', `refs/heads/${BRANCH_NAME}`, commit]);
  }

  // 创建快照
  async createSnapshot(cwd: string, message: string = '自动快照'): Promise<string | null> {
    // 防抖检查
    const now = Date.now();
    const last = this.lastSnapshotTime.get(cwd) || 0;
    if (now - last < DEBOUNCE_MS) return null;

    if (!(await this.isGitRepo(cwd))) return null;
    await this.ensureOrphanBranch(cwd);

    const gitDir = await this.getGitDir(cwd);
    const tmpDir = await mkdtempAsync(path.join(os.tmpdir(), 'duocli-snap-'));
    const tmpIndex = path.join(tmpDir, 'index');

    try {
      const env = { GIT_INDEX_FILE: tmpIndex };

      // 用临时 index 添加所有文件
      await this.git(cwd, ['add', '-A'], env);

      // 写入 tree
      const tree = await this.git(cwd, ['write-tree'], env);

      // 获取父 commit
      const parent = await this.git(cwd, ['rev-parse', `refs/heads/${BRANCH_NAME}`]);

      // 比较 tree 是否与父 commit 相同（无文件改动则跳过）
      try {
        const parentTree = await this.git(cwd, ['rev-parse', `${parent}^{tree}`]);
        if (tree === parentTree) return null;
      } catch { /* 父 commit 无 tree（如根 commit），继续创建 */ }

      // 创建 commit
      const commit = await this.git(cwd, [
        'commit-tree', tree,
        '-p', parent,
        '-m', message,
      ]);

      // 更新分支引用
      await this.git(cwd, ['update-ref', `refs/heads/${BRANCH_NAME}`, commit]);

      this.lastSnapshotTime.set(cwd, now);
      return commit;
    } finally {
      // 清理临时文件
      try { await unlinkAsync(tmpIndex); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
    }
  }

  // 更新快照的 commit message（用新 message 重建 commit）
  async updateMessage(cwd: string, commitId: string, newMessage: string): Promise<void> {
    try {
      const tree = await this.git(cwd, ['rev-parse', `${commitId}^{tree}`]);
      let parentArgs: string[] = [];
      try {
        const parent = await this.git(cwd, ['rev-parse', `${commitId}^`]);
        parentArgs = ['-p', parent];
      } catch { /* 根 commit 无 parent */ }

      const newCommit = await this.git(cwd, [
        'commit-tree', tree, ...parentArgs, '-m', newMessage,
      ]);

      // 只有当 commitId 是分支头时才更新引用
      const head = await this.git(cwd, ['rev-parse', `refs/heads/${BRANCH_NAME}`]);
      if (head === commitId) {
        await this.git(cwd, ['update-ref', `refs/heads/${BRANCH_NAME}`, newCommit]);
      }
    } catch { /* 静默失败 */ }
  }

  // 列出快照历史
  async listSnapshots(cwd: string, limit: number = 50): Promise<SnapshotInfo[]> {
    if (!(await this.isGitRepo(cwd))) return [];
    if (!(await this.branchExists(cwd))) return [];

    const log = await this.git(cwd, [
      'log', `refs/heads/${BRANCH_NAME}`,
      `--max-count=${limit}`,
      '--format=%H|%s|%ct',
    ]);

    if (!log) return [];

    const snapshots: SnapshotInfo[] = [];
    for (const line of log.split('\n')) {
      if (!line) continue;
      const [id, message, tsStr] = line.split('|');
      if (message === 'DuoCLI snapshots root') continue; // 跳过根 commit

      // 获取文件数量
      let fileCount = 0;
      try {
        const diff = await this.git(cwd, [
          'diff-tree', '--no-commit-id', '--name-only', '-r', id,
        ]);
        fileCount = diff ? diff.split('\n').filter(Boolean).length : 0;
      } catch { /* ignore */ }

      snapshots.push({
        id,
        message,
        timestamp: parseInt(tsStr, 10),
        fileCount,
      });
    }
    return snapshots;
  }

  // 获取快照中的变更文件列表
  async getSnapshotFiles(cwd: string, commitId: string): Promise<SnapshotFile[]> {
    if (!(await this.isGitRepo(cwd))) return [];

    try {
      const output = await this.git(cwd, [
        'diff-tree', '--no-commit-id', '-r', '--name-status', commitId,
      ]);
      if (!output) return [];

      return output.split('\n').filter(Boolean).map((line) => {
        const [status, ...parts] = line.split('\t');
        return { path: parts.join('\t'), status };
      });
    } catch {
      return [];
    }
  }

  // 恢复指定文件（撤销快照中的变更，恢复到快照之前的状态）
  async rollbackFiles(cwd: string, commitId: string, files: string[]): Promise<{ changed: number; unchanged: number }> {
    // 用仓库根目录拼接路径（cwd 可能是子目录，git 路径相对于仓库根）
    const repoRoot = await this.getRepoRoot(cwd);

    let parentId: string;
    try {
      parentId = await this.git(cwd, ['rev-parse', `${commitId}^`]);
    } catch {
      console.error(`[snapshot] rollback: no parent for ${commitId.slice(0, 8)}`);
      return { changed: 0, unchanged: 0 };
    }
    console.log(`[snapshot] rollback: ${commitId.slice(0, 8)} -> parent ${parentId.slice(0, 8)}, repoRoot: ${repoRoot}, files: ${files.length}`);

    let changed = 0;
    let unchanged = 0;
    for (const file of files) {
      try {
        const result = await execFileAsync('git', ['show', `${parentId}:${file}`], {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'buffer',
        });
        const fullPath = path.join(repoRoot, file);
        let currentContent: Buffer | null = null;
        try { currentContent = fs.readFileSync(fullPath); } catch { /* 文件不存在 */ }
        const same = currentContent !== null && Buffer.compare(result.stdout, currentContent) === 0;
        await mkdirAsync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, result.stdout);
        if (same) {
          unchanged++;
          console.log(`[snapshot] unchanged: ${file}`);
        } else {
          changed++;
          console.log(`[snapshot] restored: ${file} -> ${fullPath} (${result.stdout.length} bytes)`);
        }
      } catch {
        // 文件在父 commit 中不存在（即快照中新增的文件），删除它
        try {
          await unlinkAsync(path.join(repoRoot, file));
          changed++;
          console.log(`[snapshot] deleted: ${file} (new in snapshot)`);
        } catch { unchanged++; }
      }
    }
    return { changed, unchanged };
  }

  // 恢复快照中所有变更文件
  async rollbackAll(cwd: string, commitId: string): Promise<{ total: number; changed: number; unchanged: number }> {
    const files = await this.getSnapshotFiles(cwd, commitId);
    const filePaths = files.map((f) => f.path);
    const result = await this.rollbackFiles(cwd, commitId, filePaths);
    return { total: filePaths.length, ...result };
  }

  // 还原到指定快照的完整状态（时间机器）
  async restoreToSnapshot(cwd: string, commitId: string): Promise<{ total: number; changed: number; unchanged: number; deleted: number; backupCommitId: string | null }> {
    if (!(await this.isGitRepo(cwd))) {
      return { total: 0, changed: 0, unchanged: 0, deleted: 0, backupCommitId: null };
    }

    const repoRoot = await this.getRepoRoot(cwd);

    // 1. 先创建安全备份（绕过防抖）
    const savedTime = this.lastSnapshotTime.get(cwd);
    this.lastSnapshotTime.delete(cwd);
    const backupCommitId = await this.createSnapshot(cwd, '还原前自动备份');
    if (savedTime !== undefined) {
      this.lastSnapshotTime.set(cwd, savedTime);
    }

    // 2. 获取目标快照中的完整文件列表
    const lsOutput = await this.git(cwd, ['ls-tree', '-r', '--name-only', commitId]);
    const snapshotFiles = new Set(lsOutput ? lsOutput.split('\n').filter(Boolean) : []);

    // 3. 获取当前工作区的被跟踪文件列表（用最新快照的 tree）
    let currentFiles = new Set<string>();
    try {
      const head = await this.git(cwd, ['rev-parse', `refs/heads/${BRANCH_NAME}`]);
      const currentLs = await this.git(cwd, ['ls-tree', '-r', '--name-only', head]);
      currentFiles = new Set(currentLs ? currentLs.split('\n').filter(Boolean) : []);
    } catch { /* 忽略 */ }

    let changed = 0;
    let unchanged = 0;
    let deleted = 0;
    const total = snapshotFiles.size;

    // 4. 逐文件从快照提取内容写入磁盘
    for (const file of snapshotFiles) {
      try {
        const result = await execFileAsync('git', ['show', `${commitId}:${file}`], {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'buffer',
        });
        const fullPath = path.join(repoRoot, file);
        let currentContent: Buffer | null = null;
        try { currentContent = fs.readFileSync(fullPath); } catch { /* 文件不存在 */ }
        const same = currentContent !== null && Buffer.compare(result.stdout, currentContent) === 0;
        if (same) {
          unchanged++;
        } else {
          await mkdirAsync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, result.stdout);
          changed++;
        }
      } catch {
        // 无法提取的文件跳过
        unchanged++;
      }
    }

    // 5. 删除当前存在但快照中不存在的被跟踪文件
    for (const file of currentFiles) {
      if (!snapshotFiles.has(file)) {
        try {
          const fullPath = path.join(repoRoot, file);
          if (fs.existsSync(fullPath)) {
            await unlinkAsync(fullPath);
            deleted++;
          }
        } catch { /* 忽略 */ }
      }
    }

    return { total, changed, unchanged, deleted, backupCommitId };
  }

  // 获取单个文件的 diff
  async getFileDiff(cwd: string, commitId: string, filePath: string): Promise<string> {
    if (!(await this.isGitRepo(cwd))) return '';
    try {
      // 获取父 commit
      const parent = await this.git(cwd, ['rev-parse', `${commitId}^`]);
      const diff = await this.git(cwd, [
        'diff', parent, commitId, '--', filePath,
      ]);
      return diff || '(无差异)';
    } catch {
      // 可能是根 commit 没有父，用 diff-tree
      try {
        const diff = await this.git(cwd, [
          'diff-tree', '-p', '--no-commit-id', '-r', commitId, '--', filePath,
        ]);
        return diff || '(无差异)';
      } catch {
        return '(无法获取 diff)';
      }
    }
  }

  // 获取整个快照的 diff（用于总结）
  async getSnapshotDiff(cwd: string, commitId: string): Promise<string> {
    if (!(await this.isGitRepo(cwd))) return '';
    try {
      const parent = await this.git(cwd, ['rev-parse', `${commitId}^`]);
      const diff = await this.git(cwd, [
        'diff', parent, commitId,
      ]);
      if (diff.length > 20000) {
        return diff.substring(0, 20000) + '\n... (diff 过长，已截断)';
      }
      return diff || '';
    } catch {
      try {
        const diff = await this.git(cwd, [
          'diff-tree', '-p', '--no-commit-id', '-r', commitId,
        ]);
        if (diff.length > 20000) {
          return diff.substring(0, 20000) + '\n... (diff 过长，已截断)';
        }
        return diff || '';
      } catch {
        return '';
      }
    }
  }
}
