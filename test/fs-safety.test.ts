import { chmod, link, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertPrivateAppDirSafe,
  assertExistingPrivateDirSafe,
  assertSafeReadablePrivateFile,
  compareTargetIdentities,
  detectTargetState,
  safeTargetStateForReport
} from '../src/fs-safety.js';

describe('filesystem target safety', () => {
  test('blocks hardlinked WAL and shared-writable database files', async () => {
    const root = await makeTempDir();
    const db = path.join(root, 'logs_2.sqlite');
    await writeFile(db, 'main');
    await writeFile(`${db}-wal`, 'wal');
    await writeFile(`${db}-shm`, 'shm');
    await link(`${db}-wal`, path.join(root, 'wal-hardlink'));
    await chmod(db, 0o664);

    const state = await detectTargetState(db);

    expect(state.fixable).toBe(false);
    expect(state.blockers).toContain('main database is group/other writable');
    expect(state.blockers).toContain('codex-log-db-wal has hard links');
  });

  test('blocks unsafe report or backup directory symlinks', async () => {
    const root = await makeTempDir();
    const target = path.join(root, 'outside');
    const appDir = path.join(root, 'app');
    await mkdir(target);
    await symlink(target, appDir);

    await expect(assertPrivateAppDirSafe(appDir)).resolves.toContain(
      '<app-data> is a symlink'
    );
  });

  test('does not create child directories through a symlinked app data root', async () => {
    const root = await makeTempDir();
    const target = path.join(root, 'outside');
    const appDir = path.join(root, '.ai-dev-maintenance');
    await mkdir(target);
    await symlink(target, appDir);

    const blockers = await assertPrivateAppDirSafe(path.join(appDir, 'reports'));

    expect(blockers).toContain('<app-data> is a symlink');
    await expect(readdir(target)).resolves.toEqual([]);
  });

  test('private app directory blockers do not expose absolute local paths', async () => {
    const root = await makeTempDir();
    const appDir = path.join(root, '.ai-dev-maintenance');
    await mkdir(appDir);
    await chmod(appDir, 0o777);

    const blockers = await assertPrivateAppDirSafe(path.join(appDir, 'reports'));

    expect(blockers.join('\n')).not.toContain(root);
    expect(blockers).toContain('<app-data> is group/other writable');
  });

  test('private app directories with group or other visibility block before creating children', async () => {
    const root = await makeTempDir();
    const appDir = path.join(root, '.ai-dev-maintenance');
    await mkdir(appDir);
    await chmod(appDir, 0o755);

    const blockers = await assertPrivateAppDirSafe(path.join(appDir, 'reports'));

    expect(blockers).toContain('<app-data> exposes group/other permissions');
    await expect(readdir(appDir)).resolves.toEqual([]);
  });

  test('blocks unsafe private files before reading reports or backups', async () => {
    const root = await makeTempDir();
    const file = path.join(root, 'report.json');
    await writeFile(file, '{}');
    await chmod(file, 0o666);

    const blockers = await assertSafeReadablePrivateFile(file, 'report file');

    expect(blockers).toContain('report file is group/other writable');
  });

  test('existing private directory check rejects symlink roots without creating children', async () => {
    const root = await makeTempDir();
    const outside = path.join(root, 'outside');
    const appDir = path.join(root, '.ai-dev-maintenance');
    await mkdir(outside);
    await symlink(outside, appDir);

    const blockers = await assertExistingPrivateDirSafe(path.join(appDir, 'backups'));

    expect(blockers).toContain('<app-data> is a symlink');
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  test('detects target identity drift between preflight phases', async () => {
    const root = await makeTempDir();
    const db = path.join(root, 'logs_2.sqlite');
    await writeFile(db, 'first');
    await writeFile(`${db}-wal`, 'wal');
    await writeFile(`${db}-shm`, 'shm');
    const before = await detectTargetState(db);
    await writeFile(db, 'second');
    const after = await detectTargetState(db);

    expect(compareTargetIdentities(before, after, { allowSidecarSizeMtimeChange: false })).toContain(
      'main database identity changed'
    );
  });

  test('redacted target state omits local filesystem fingerprints', async () => {
    const root = await makeTempDir();
    const db = path.join(root, 'logs_2.sqlite');
    await writeFile(db, 'main');
    const state = await detectTargetState(db);

    const redacted = safeTargetStateForReport(state);

    expect(JSON.stringify(redacted)).not.toMatch(/"dev"|"ino"|"uid"|"gid"|"mode"|"mtimeMs"|"realpath"/);
    expect(redacted.main).toEqual({
      pathCategory: 'codex-log-db-main',
      exists: true,
      regularFile: true,
      symbolicLink: false,
      size: 4
    });
  });
});

async function makeTempDir(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return await mkdtemp(path.join(tmpdir(), 'adm-fs-test-'));
}
