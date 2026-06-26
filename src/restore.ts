import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { assertExistingPrivateDirSafe, assertSafeReadablePrivateFile, collectFileIdentity } from './fs-safety.js';
import { appDataHome } from './paths.js';
import type { FileIdentity } from './types.js';
import { inspectSqliteSnapshot } from './sqlite.js';

export async function validateRestoreBackup(backupPath: string) {
  const backupRoot = path.join(appDataHome(), 'backups');
  const rootBlockers = await assertExistingPrivateDirSafe(backupRoot);
  if (rootBlockers.length > 0) return invalidRestoreResult(rootBlockers.join('; '));
  const [backupRootReal, backupReal] = await Promise.all([
    realpath(backupRoot),
    realpath(backupPath)
  ]).catch(() => [undefined, undefined]);
  if (!backupRootReal || !backupReal || !isInsideDirectory(backupReal, backupRootReal)) {
    return invalidRestoreResult('backup is outside the tool backup directory');
  }
  const beforeBlockers = await assertSafeReadablePrivateFile(backupPath, 'backup file');
  if (beforeBlockers.length > 0) return invalidRestoreResult(beforeBlockers.join('; '));
  const beforeIdentity = await collectFileIdentity(backupPath, 'backup file');

  const inspection = await inspectSqliteSnapshot(backupPath);
  const afterBlockers = await assertSafeReadablePrivateFile(backupPath, 'backup file');
  if (afterBlockers.length > 0) return invalidRestoreResult('backup file changed during validation');
  const afterIdentity = await collectFileIdentity(backupPath, 'backup file');
  if (!sameBackupIdentity(beforeIdentity, afterIdentity)) return invalidRestoreResult('backup file changed during validation');
  return {
    valid: inspection.quickCheck === 'ok' && inspection.recognizedSchema,
    inspection,
    warnings: [
      'Validation only. This command does not restore anything.',
      'Do not move, copy, or replace database files unless following a recovery guide.',
      'Ask for help before manual restore if you are not comfortable with SQLite files.'
    ]
  };
}

function invalidRestoreResult(reason: string) {
  return {
    valid: false,
    reason,
    warnings: [
      'Validation only. This command does not restore anything.',
      'Do not move, copy, or replace database files unless following a recovery guide.',
      'Ask for help before manual restore if you are not comfortable with SQLite files.'
    ]
  };
}

function isInsideDirectory(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function sameBackupIdentity(before: FileIdentity, after: FileIdentity): boolean {
  return (
    before.exists === after.exists &&
    before.regularFile === after.regularFile &&
    before.symbolicLink === after.symbolicLink &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.nlink === after.nlink &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}
