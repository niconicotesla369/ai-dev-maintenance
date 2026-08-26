import { chmod, link, mkdir, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertPrivateAppDirSafe,
  assertExistingPrivateDirSafe,
  assertSafeReadablePrivateFile,
  compareTargetIdentities,
  detectTargetState,
  inspectSafeExecutable,
  sameExecutableIdentity,
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

  test('accepts only a canonical private or root-owned regular executable', async () => {
    const created = await makeTempDir();
    const root = await realpath(created);
    const executable = path.join(root, 'codex');
    try {
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

      const inspection = await inspectSafeExecutable(executable, '<codex-executable>');

      expect(inspection).toMatchObject({ safe: true, blockers: [] });
      expect(inspection.identity).toMatchObject({
        pathCategory: '<codex-executable>',
        realpath: executable,
        regularFile: true,
        symbolicLink: false,
        nlink: 1
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects relative, symlinked, hardlinked, writable, and non-executable commands', async () => {
    const created = await makeTempDir();
    const root = await realpath(created);
    const executable = path.join(root, 'codex');
    const alias = path.join(root, 'codex-link');
    const hardlink = path.join(root, 'codex-hardlink');
    try {
      await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });
      await symlink(executable, alias);
      expect((await inspectSafeExecutable('relative-codex', '<codex-executable>')).blockers)
        .toContain('executable-path-invalid');
      expect((await inspectSafeExecutable(alias, '<codex-executable>')).blockers)
        .toContain('executable-symlink');

      await link(executable, hardlink);
      expect((await inspectSafeExecutable(executable, '<codex-executable>')).blockers)
        .toContain('executable-hardlinked');
      await unlink(hardlink);

      await chmod(executable, 0o722);
      expect((await inspectSafeExecutable(executable, '<codex-executable>')).blockers)
        .toContain('executable-mode-unsafe');
      await chmod(executable, 0o600);
      expect((await inspectSafeExecutable(executable, '<codex-executable>')).blockers)
        .toContain('executable-not-executable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('compares executable identity without trusting only its path', async () => {
    const created = await makeTempDir();
    const root = await realpath(created);
    const executable = path.join(root, 'codex');
    try {
      await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });
      const before = await inspectSafeExecutable(executable, '<codex-executable>');
      await writeFile(executable, '#!/bin/sh\n# drift\n', { mode: 0o700 });
      const after = await inspectSafeExecutable(executable, '<codex-executable>');

      expect(before.identity).toBeDefined();
      expect(after.identity).toBeDefined();
      expect(sameExecutableIdentity(before.identity!, after.identity!)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeTempDir(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return await mkdtemp(path.join(tmpdir(), 'adm-fs-test-'));
}
