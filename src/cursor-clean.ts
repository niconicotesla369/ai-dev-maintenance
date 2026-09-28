import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runCommand, trustedCommandPath } from './commands.js';
import { scanPathSize } from './fs-size.js';
import { resolveHome } from './paths.js';

const CURSOR_ROOT_CATEGORY = '<home>/Library/Application Support/Cursor';

const SAFE_TARGETS = [
  ['Cache', 'cache data'],
  ['CachedData', 'cached runtime data'],
  ['CachedExtensionVSIXs', 'extension cache'],
  ['logs', 'logs']
] as const;

export function cursorSafeTargetPaths(env: NodeJS.ProcessEnv = process.env): Array<{ path: string; pathCategory: string }> {
  const root = cursorRoot(env);
  return SAFE_TARGETS.map(([name]) => ({ path: path.join(root, name), pathCategory: `${CURSOR_ROOT_CATEGORY}/${name}` }));
}

export type CursorCleanupTarget = {
  path: string;
  pathCategory: string;
  bytes: number;
  note: string;
};

export type CursorCleanupPlan = {
  status: 'ready' | 'blocked';
  reclaimableBytes: number;
  targets: CursorCleanupTarget[];
  blockedReasons: string[];
  warnings: string[];
};

export type CursorCleanupResult = Omit<CursorCleanupPlan, 'status'> & {
  status: CursorCleanupPlan['status'] | 'ok' | 'partial';
  deletedBytes: number;
  deletedEntries: number;
  mode: 'dry-run' | 'cleanup';
};

export type CursorCleanupOptions = {
  env?: NodeJS.ProcessEnv;
  yes?: boolean;
  processList?: string;
};

export async function planCursorSafeCleanup(options: CursorCleanupOptions = {}): Promise<CursorCleanupPlan> {
  const root = cursorRoot(options.env);
  const targets: CursorCleanupTarget[] = [];
  const blockedReasons: string[] = [];
  const warnings: string[] = [];

  for (const [name, note] of SAFE_TARGETS) {
    const targetPath = path.join(root, name);
    const pathCategory = `${CURSOR_ROOT_CATEGORY}/${name}`;
    const safety = await safeCleanupRoot(targetPath);
    if (safety.missing) continue;
    if (safety.blockers.length > 0) {
      for (const blocker of safety.blockers) blockedReasons.push(`unsafe Cursor cleanup target: ${blocker}`);
      continue;
    }
    const scan = await scanPathSize(targetPath, pathCategory);
    warnings.push(...(scan.warnings ?? []).map((warning) => String(warning.message ?? warning.code ?? 'scan warning')));
    targets.push({
      path: targetPath,
      pathCategory,
      bytes: scan.bytes,
      note
    });
  }

  return {
    status: blockedReasons.length > 0 ? 'blocked' : 'ready',
    reclaimableBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    targets,
    blockedReasons: unique(blockedReasons),
    warnings: unique(warnings)
  };
}

export async function runCursorSafeCleanup(options: CursorCleanupOptions = {}): Promise<CursorCleanupResult> {
  const plan = await planCursorSafeCleanup(options);
  if (plan.status === 'blocked' || options.yes !== true) {
    return {
      ...plan,
      deletedBytes: 0,
      deletedEntries: 0,
      mode: 'dry-run'
    };
  }

  const running = await cursorProcessStatus(options);
  if (running.blockedReason) {
    return {
      ...plan,
      status: 'blocked',
      blockedReasons: unique([...plan.blockedReasons, running.blockedReason]),
      deletedBytes: 0,
      deletedEntries: 0,
      mode: 'dry-run'
    };
  }

  let deletedEntries = 0;
  let deletedBytes = 0;
  let failedEntries = 0;
  const warnings = [...plan.warnings];
  for (const target of plan.targets) {
    const result = await deleteChildren(target.path);
    deletedEntries += result.deletedEntries;
    deletedBytes += result.deletedBytes;
    failedEntries += result.failedEntries;
    warnings.push(...result.warnings);
  }

  return {
    ...plan,
    status: failedEntries > 0 ? 'partial' : 'ok',
    blockedReasons: failedEntries > 0
      ? unique([...plan.blockedReasons, 'some Cursor cleanup entries could not be removed'])
      : plan.blockedReasons,
    warnings: unique(warnings),
    deletedBytes,
    deletedEntries,
    mode: 'cleanup'
  };
}

async function cursorProcessStatus(options: CursorCleanupOptions): Promise<{ blockedReason?: string }> {
  let processList = options.processList;
  if (processList === undefined) {
    try {
      const ps = await trustedCommandPath('ps');
      const result = await runCommand(ps, ['-axo', 'pid=,comm=,command='], { timeoutMs: 5_000 });
      if (result.stdoutTruncated || result.stderrTruncated || result.timedOut || result.code !== 0) {
        return { blockedReason: 'Cursor process check unavailable' };
      }
      processList = result.stdout;
    } catch {
      return { blockedReason: 'Cursor process check unavailable' };
    }
  }
  return processList.split('\n').some(isCursorProcessLine)
    ? { blockedReason: 'Cursor is running' }
    : {};
}

function isCursorProcessLine(line: string): boolean {
  return line.includes('/Applications/Cursor.app/') || /\bCursor Helper\b/.test(line);
}

async function safeCleanupRoot(targetPath: string): Promise<{ missing: boolean; blockers: string[] }> {
  let stat;
  try {
    stat = await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { missing: true, blockers: [] };
    return { missing: false, blockers: ['read error'] };
  }

  const blockers: string[] = [];
  if (stat.isSymbolicLink()) blockers.push('symbolic link');
  if (!stat.isDirectory()) blockers.push('not a directory');
  if (stat.uid !== process.getuid?.()) blockers.push('not owned by current user');
  if ((stat.mode & 0o022) !== 0) blockers.push('group/other writable');
  return { missing: false, blockers };
}

type DeleteResult = {
  deletedBytes: number;
  deletedEntries: number;
  failedEntries: number;
  warnings: string[];
};

async function deleteChildren(dir: string): Promise<DeleteResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return failed('failed to read Cursor cleanup target');
  }

  let deletedBytes = 0;
  let deletedEntries = 0;
  let failedEntries = 0;
  const warnings: string[] = [];
  for (const entry of entries) {
    const result = await deleteEntry(path.join(dir, entry));
    deletedBytes += result.deletedBytes;
    deletedEntries += result.deletedEntries;
    failedEntries += result.failedEntries;
    warnings.push(...result.warnings);
  }
  return { deletedBytes, deletedEntries, failedEntries, warnings };
}

async function deleteEntry(entryPath: string): Promise<DeleteResult> {
  let stat;
  try {
    stat = await lstat(entryPath);
  } catch {
    return failed('failed to inspect Cursor cleanup entry');
  }

  if (stat.isSymbolicLink()) {
    return skipped('skipped symbolic link in Cursor cleanup target');
  }
  if (stat.isDirectory()) {
    const childResult = await deleteChildren(entryPath);
    try {
      await rmdir(entryPath);
      return { ...childResult, deletedEntries: childResult.deletedEntries + 1 };
    } catch {
      return {
        ...childResult,
        failedEntries: childResult.failedEntries + 1,
        warnings: [...childResult.warnings, 'failed to remove Cursor cleanup directory']
      };
    }
  }
  if (stat.isFile()) {
    try {
      await unlink(entryPath);
      return { deletedBytes: stat.size, deletedEntries: 1, failedEntries: 0, warnings: [] };
    } catch {
      return failed('failed to remove Cursor cleanup file');
    }
  }
  return skipped('skipped unsupported Cursor cleanup entry');
}

function failed(warning: string): DeleteResult {
  return { deletedBytes: 0, deletedEntries: 0, failedEntries: 1, warnings: [warning] };
}

function skipped(warning: string): DeleteResult {
  return { deletedBytes: 0, deletedEntries: 0, failedEntries: 0, warnings: [warning] };
}

function cursorRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome(env), 'Library', 'Application Support', 'Cursor');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
