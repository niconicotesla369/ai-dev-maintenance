import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { planCursorSafeCleanup, runCursorSafeCleanup } from '../src/cursor-clean.js';
import { runCli } from '../src/cli.js';

describe('Cursor safe cleanup planning', () => {
  test('only plans safe Cursor cache and log roots', async () => {
    const home = await makeCursorFixture();
    try {
      const plan = await planCursorSafeCleanup({ env: { HOME: home } });

      expect(plan.status).toBe('ready');
      expect(plan.targets.map((target) => target.pathCategory).sort()).toEqual([
        '<home>/Library/Application Support/Cursor/Cache',
        '<home>/Library/Application Support/Cursor/CachedData',
        '<home>/Library/Application Support/Cursor/CachedExtensionVSIXs',
        '<home>/Library/Application Support/Cursor/logs'
      ].sort());
      expect(JSON.stringify(plan)).not.toContain('state.vscdb');
      expect(JSON.stringify(plan)).not.toContain('workspaceStorage');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('blocks unsafe safe-root symlinks before cleanup', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-cursor-clean-home-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aidm-cursor-clean-outside-'));
    try {
      const cursorRoot = cursorRootFor(home);
      await mkdir(cursorRoot, { recursive: true });
      await symlink(outside, path.join(cursorRoot, 'Cache'));

      const plan = await planCursorSafeCleanup({ env: { HOME: home } });

      expect(plan.status).toBe('blocked');
      expect(plan.blockedReasons).toContain('unsafe Cursor cleanup target: symbolic link');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('Cursor safe cleanup execution', () => {
  test('deletes cache and log contents while preserving private state', async () => {
    const home = await makeCursorFixture();
    try {
      const result = await runCursorSafeCleanup({ env: { HOME: home }, yes: true, processList: '' });
      const cursorRoot = cursorRootFor(home);

      expect(result.status).toBe('ok');
      expect(result.deletedBytes).toBe(20);
      await expect(lstat(path.join(cursorRoot, 'Cache'))).resolves.toBeTruthy();
      await expect(lstat(path.join(cursorRoot, 'CachedData'))).resolves.toBeTruthy();
      await expect(lstat(path.join(cursorRoot, 'CachedExtensionVSIXs'))).resolves.toBeTruthy();
      await expect(lstat(path.join(cursorRoot, 'logs'))).resolves.toBeTruthy();
      await expect(lstat(path.join(cursorRoot, 'Cache', 'cache.bin'))).rejects.toThrow();
      await expect(lstat(path.join(cursorRoot, 'CachedData', 'runtime.bin'))).rejects.toThrow();
      await expect(lstat(path.join(cursorRoot, 'CachedExtensionVSIXs', 'extension.vsix'))).rejects.toThrow();
      await expect(lstat(path.join(cursorRoot, 'logs', 'main.log'))).rejects.toThrow();
      await expect(readFile(path.join(cursorRoot, 'User', 'globalStorage', 'state.vscdb'), 'utf8')).resolves.toBe('private conversation');
      await expect(readFile(path.join(cursorRoot, 'User', 'workspaceStorage', 'workspace', 'state.json'), 'utf8')).resolves.toBe('workspace context');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('skips symlinks inside safe roots and does not remove their targets', async () => {
    const home = await makeCursorFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aidm-cursor-clean-outside-'));
    try {
      const cursorRoot = cursorRootFor(home);
      await writeFile(path.join(outside, 'outside.txt'), 'outside');
      await symlink(path.join(outside, 'outside.txt'), path.join(cursorRoot, 'Cache', 'outside-link'));

      const result = await runCursorSafeCleanup({ env: { HOME: home }, yes: true, processList: '' });

      expect(result.warnings).toContain('skipped symbolic link in Cursor cleanup target');
      await expect(readFile(path.join(outside, 'outside.txt'), 'utf8')).resolves.toBe('outside');
      await expect(lstat(path.join(cursorRoot, 'Cache', 'outside-link'))).resolves.toBeTruthy();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('dry run reports bytes without deleting files', async () => {
    const home = await makeCursorFixture();
    try {
      const result = await runCursorSafeCleanup({ env: { HOME: home }, yes: false });

      expect(result.status).toBe('ready');
      expect(result.deletedBytes).toBe(0);
      expect(result.reclaimableBytes).toBe(20);
      await expect(readFile(path.join(cursorRootFor(home), 'Cache', 'cache.bin'), 'utf8')).resolves.toBe('cache');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('blocks mutating cleanup while Cursor is running', async () => {
    const home = await makeCursorFixture();
    try {
      const result = await runCursorSafeCleanup({
        env: { HOME: home },
        yes: true,
        processList: '57828 /Applications/Cursor.app/Contents/MacOS/Cursor\n'
      });

      expect(result.status).toBe('blocked');
      expect(result.deletedBytes).toBe(0);
      expect(result.blockedReasons).toContain('Cursor is running');
      await expect(readFile(path.join(cursorRootFor(home), 'Cache', 'cache.bin'), 'utf8')).resolves.toBe('cache');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('Cursor safe cleanup CLI', () => {
  test('prints a dry-run summary without --yes', async () => {
    const home = await makeCursorFixture();
    try {
      const result = await runCli(['cursor', 'clean', '--safe'], {
        env: { ...process.env, HOME: home },
        io: { isInputTty: false, isOutputTty: false },
        commands: {
          runCursorSafeCleanup: async (options) => runCursorSafeCleanup({ ...options, processList: '' })
        }
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Cursor cleanup');
      expect(result.output).toContain('Mode            dry run');
      expect(result.output).toContain('Reclaimable     20 B');
      expect(result.output).toContain('Next            ai-dev-maintenance cursor clean --safe --yes');
      await expect(readFile(path.join(cursorRootFor(home), 'Cache', 'cache.bin'), 'utf8')).resolves.toBe('cache');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('runs cleanup with --yes', async () => {
    const home = await makeCursorFixture();
    try {
      const result = await runCli(['cursor', 'clean', '--safe', '--yes'], {
        env: { ...process.env, HOME: home },
        io: { isInputTty: false, isOutputTty: false },
        commands: {
          runCursorSafeCleanup: async (options) => runCursorSafeCleanup({ ...options, processList: '' })
        }
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Mode            cleanup');
      expect(result.output).toContain('Reclaimed       20 B');
      await expect(lstat(path.join(cursorRootFor(home), 'Cache', 'cache.bin'))).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function makeCursorFixture(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-cursor-clean-home-'));
  const cursorRoot = cursorRootFor(home);
  await mkdir(path.join(cursorRoot, 'User', 'globalStorage'), { recursive: true });
  await mkdir(path.join(cursorRoot, 'User', 'workspaceStorage', 'workspace'), { recursive: true });
  await mkdir(path.join(cursorRoot, 'Cache'), { recursive: true });
  await mkdir(path.join(cursorRoot, 'CachedData'), { recursive: true });
  await mkdir(path.join(cursorRoot, 'CachedExtensionVSIXs'), { recursive: true });
  await mkdir(path.join(cursorRoot, 'logs'), { recursive: true });
  await writeFile(path.join(cursorRoot, 'User', 'globalStorage', 'state.vscdb'), 'private conversation');
  await writeFile(path.join(cursorRoot, 'User', 'globalStorage', 'state.vscdb.backup'), 'private backup');
  await writeFile(path.join(cursorRoot, 'User', 'workspaceStorage', 'workspace', 'state.json'), 'workspace context');
  await writeFile(path.join(cursorRoot, 'Cache', 'cache.bin'), 'cache');
  await writeFile(path.join(cursorRoot, 'CachedData', 'runtime.bin'), 'runtime');
  await writeFile(path.join(cursorRoot, 'CachedExtensionVSIXs', 'extension.vsix'), 'vsix');
  await writeFile(path.join(cursorRoot, 'logs', 'main.log'), 'logs');
  return home;
}

function cursorRootFor(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'Cursor');
}
