import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertExistingPrivateDirSafe, assertSafeReadablePrivateFile } from './fs-safety.js';
import { redactPath } from './paths.js';

export type RetentionOptions = {
  now?: Date;
  maxCount?: number;
  maxAgeMs?: number;
  keepPath?: string;
};

export type RetentionResult = {
  deleted: number;
  warnings: string[];
};

type ResolvedRetentionOptions = {
  now?: Date;
  maxCount: number;
  maxAgeMs: number;
  keepPath?: string;
};

export const DEFAULT_REPORT_RETENTION = {
  maxCount: 50,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000
};

export const DEFAULT_BACKUP_RETENTION = {
  maxCount: 3,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000
};

export async function pruneReports(
  dir: string,
  rawOptions: RetentionOptions = {}
): Promise<RetentionResult> {
  const options: ResolvedRetentionOptions = {
    ...rawOptions,
    maxCount: rawOptions.maxCount ?? DEFAULT_REPORT_RETENTION.maxCount,
    maxAgeMs: rawOptions.maxAgeMs ?? DEFAULT_REPORT_RETENTION.maxAgeMs
  };
  const warnings: string[] = [];
  const blockers = await assertExistingPrivateDirSafe(dir).catch((error) => [String(error)]);
  if (blockers.length > 0) return { deleted: 0, warnings: blockers.map(redactPath) };

  const now = options.now ?? new Date();
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const reports = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^report-.*\.json$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const blockers = await assertSafeReadablePrivateFile(file, `report ${entry.name}`);
    if (blockers.length > 0) {
      warnings.push(...blockers.map(redactPath));
      continue;
    }
    const stat = await lstat(file);
    reports.push({ name: entry.name, path: file, mtimeMs: stat.mtimeMs });
  }

  const deleteSet = selectExpiredEntries(reports, now, options);
  let deleted = 0;
  for (const item of deleteSet) {
    await rm(item.path, { force: true });
    deleted += 1;
  }
  return { deleted, warnings };
}

export async function pruneBackups(
  dir: string,
  rawOptions: RetentionOptions = {}
): Promise<RetentionResult> {
  const options: ResolvedRetentionOptions = {
    ...rawOptions,
    maxCount: rawOptions.maxCount ?? DEFAULT_BACKUP_RETENTION.maxCount,
    maxAgeMs: rawOptions.maxAgeMs ?? DEFAULT_BACKUP_RETENTION.maxAgeMs
  };
  const warnings: string[] = [];
  const blockers = await assertExistingPrivateDirSafe(dir).catch((error) => [String(error)]);
  if (blockers.length > 0) return { deleted: 0, warnings: blockers.map(redactPath) };

  const now = options.now ?? new Date();
  const keepPath = options.keepPath ? path.resolve(options.keepPath) : undefined;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const backups = [];
  for (const entry of entries) {
    if (!entry.name.startsWith('backup-')) continue;
    const backupDir = path.join(dir, entry.name);
    const safety = await backupEntryWarnings(backupDir, entry.name);
    if (safety.length > 0) {
      warnings.push(...safety);
      continue;
    }
    const stat = await lstat(backupDir);
    backups.push({ name: entry.name, path: backupDir, mtimeMs: stat.mtimeMs });
  }

  const deleteSet = selectExpiredEntries(backups, now, options)
    .filter((item) => path.resolve(item.path) !== keepPath);
  let deleted = 0;
  for (const item of deleteSet) {
    await rm(item.path, { recursive: true, force: false });
    deleted += 1;
  }
  return { deleted, warnings };
}

function selectExpiredEntries<T extends { name: string; path: string; mtimeMs: number }>(
  entries: T[],
  now: Date,
  options: ResolvedRetentionOptions
): T[] {
  const sorted = [...entries].sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.name.localeCompare(a.name);
  });
  const maxAgeMs = Math.max(0, options.maxAgeMs);
  const maxCount = Math.max(0, options.maxCount);
  return sorted.filter((entry, index) => {
    return now.getTime() - entry.mtimeMs >= maxAgeMs || index >= maxCount;
  });
}

async function backupEntryWarnings(backupDir: string, name: string): Promise<string[]> {
  const warnings: string[] = [];
  const info = await lstat(backupDir).catch((error) => {
    warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  if (!info) return warnings;
  const uid = process.getuid?.();
  if (info.isSymbolicLink()) warnings.push(`${name} is a symlink`);
  if (!info.isDirectory()) warnings.push(`${name} is not a directory`);
  if (uid !== undefined && info.uid !== uid) warnings.push(`${name} is not owned by current user`);
  if ((info.mode & 0o022) !== 0) warnings.push(`${name} is group/other writable`);
  if (warnings.length > 0) return warnings.map(redactPath);

  const entries = await readdir(backupDir).catch(() => []);
  const sqlite = entries.find((entry) => entry.endsWith('.sqlite'));
  const manifest = entries.find((entry) => entry.endsWith('.manifest.json'));
  for (const [file, label] of [
    [sqlite, `${name} sqlite backup`],
    [manifest, `${name} manifest`]
  ] as const) {
    if (!file) {
      warnings.push(`${label} is missing`);
      continue;
    }
    warnings.push(...(await assertSafeReadablePrivateFile(path.join(backupDir, file), label)));
  }
  return warnings.map(redactPath);
}
