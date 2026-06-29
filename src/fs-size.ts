import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export type SizeScanOptions = {
  maxDepth?: number;
  maxEntries?: number;
  maxChildrenPerDir?: number;
  deadlineMs?: number;
};

export type SizeScanWarningCode =
  | 'missing'
  | 'not_directory'
  | 'permission_denied'
  | 'symlink_skipped'
  | 'max_depth'
  | 'max_entries'
  | 'max_children'
  | 'deadline'
  | 'read_error';

export type SizeScanWarning = {
  code: SizeScanWarningCode;
  pathCategory: string;
  message: string;
};

export type SizeScanResult = {
  pathCategory: string;
  exists: boolean;
  bytes: number;
  files: number;
  directories: number;
  symlinksSkipped: number;
  sizeTruncated: boolean;
  warnings: SizeScanWarning[];
};

type QueueEntry = {
  filePath: string;
  depth: number;
};

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_CHILDREN_PER_DIR = 2_000;
const DEFAULT_DEADLINE_MS = 2_000;

export async function scanPathSize(
  rootPath: string,
  pathCategory: string,
  options: SizeScanOptions = {}
): Promise<SizeScanResult> {
  const limits = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxChildrenPerDir: options.maxChildrenPerDir ?? DEFAULT_MAX_CHILDREN_PER_DIR,
    deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS
  };
  const startedAt = Date.now();
  const result: SizeScanResult = {
    pathCategory,
    exists: true,
    bytes: 0,
    files: 0,
    directories: 0,
    symlinksSkipped: 0,
    sizeTruncated: false,
    warnings: []
  };
  const queue: QueueEntry[] = [{ filePath: rootPath, depth: 0 }];
  let entriesScanned = 0;

  while (queue.length > 0) {
    if (deadlineReached(startedAt, limits.deadlineMs)) {
      truncateWithWarning(result, 'deadline', 'scan deadline reached');
      break;
    }

    const current = queue.shift();
    if (!current) break;

    if (entriesScanned >= limits.maxEntries) {
      truncateWithWarning(result, 'max_entries', 'maximum entry count reached');
      break;
    }
    entriesScanned += 1;

    const stats = await lstat(current.filePath).catch((error: unknown) => {
      handleStatError(result, error, current.depth === 0);
      return undefined;
    });
    if (!stats) {
      if (current.depth === 0 && warningCodes(result).includes('missing')) {
        result.exists = false;
      }
      continue;
    }

    if (stats.isSymbolicLink()) {
      result.symlinksSkipped += 1;
      addWarning(result, 'symlink_skipped', 'symbolic link skipped');
      continue;
    }

    if (stats.isFile()) {
      result.bytes += stats.size;
      result.files += 1;
      continue;
    }

    if (!stats.isDirectory()) {
      addWarning(result, 'not_directory', 'path is not a regular file or directory');
      if (current.depth === 0) result.sizeTruncated = true;
      continue;
    }

    result.directories += 1;
    if (current.depth >= limits.maxDepth) {
      truncateWithWarning(result, 'max_depth', 'maximum directory depth reached');
      continue;
    }

    const children = await readdir(current.filePath).catch((error: unknown) => {
      handleReadError(result, error);
      return undefined;
    });
    if (!children) continue;

    const sortedChildren = [...children].sort();
    const selectedChildren = sortedChildren.slice(0, limits.maxChildrenPerDir);
    if (sortedChildren.length > limits.maxChildrenPerDir) {
      truncateWithWarning(result, 'max_children', 'maximum children per directory reached');
    }

    for (const child of selectedChildren) {
      queue.push({
        filePath: path.join(current.filePath, child),
        depth: current.depth + 1
      });
    }
  }

  return result;
}

function handleStatError(result: SizeScanResult, error: unknown, isRoot: boolean): void {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    addWarning(result, 'missing', isRoot ? 'path is missing' : 'entry disappeared during scan');
    if (!isRoot) result.sizeTruncated = true;
    return;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    truncateWithWarning(result, 'permission_denied', 'permission denied while scanning');
    return;
  }
  truncateWithWarning(result, 'read_error', 'unable to inspect entry');
}

function handleReadError(result: SizeScanResult, error: unknown): void {
  const code = errorCode(error);
  if (code === 'EACCES' || code === 'EPERM') {
    truncateWithWarning(result, 'permission_denied', 'permission denied while scanning directory');
    return;
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    truncateWithWarning(result, 'missing', 'directory disappeared during scan');
    return;
  }
  truncateWithWarning(result, 'read_error', 'unable to scan directory');
}

function truncateWithWarning(
  result: SizeScanResult,
  code: SizeScanWarningCode,
  message: string
): void {
  result.sizeTruncated = true;
  addWarning(result, code, message);
}

function addWarning(result: SizeScanResult, code: SizeScanWarningCode, message: string): void {
  result.warnings.push({
    code,
    pathCategory: result.pathCategory,
    message
  });
}

function warningCodes(result: SizeScanResult): SizeScanWarningCode[] {
  return result.warnings.map((warning) => warning.code);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function deadlineReached(startedAt: number, deadlineMs: number): boolean {
  return Date.now() - startedAt > deadlineMs;
}
