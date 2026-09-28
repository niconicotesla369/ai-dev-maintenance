import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CommandRunResult } from '../src/types.js';

const hooks = vi.hoisted(() => ({
  ps: undefined as CommandRunResult | undefined,
  psThrows: false
}));

vi.mock('../src/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/commands.js')>();
  return {
    ...actual,
    runCommand: async (
      command: string,
      args: string[],
      options?: Parameters<typeof actual.runCommand>[2]
    ) => {
      if (command.endsWith('/ps')) {
        if (hooks.psThrows) throw new Error('synthetic ps failure');
        if (hooks.ps) return hooks.ps;
      }
      return actual.runCommand(command, args, options);
    }
  };
});

import { runCursorSafeCleanup } from '../src/cursor-clean.js';

afterEach(() => {
  hooks.ps = undefined;
  hooks.psThrows = false;
});

describe('Cursor cleanup process guard', () => {
  test.each([
    ['non-zero exit', { code: 1, stdout: '', stderr: 'ps failed' }],
    ['timeout', { code: null, stdout: '', stderr: '', timedOut: true }],
    ['truncated output', { code: 0, stdout: '1 x x\n', stderr: '', stdoutTruncated: true }]
  ] as const)('deletes nothing when the process list has a %s', async (_label, result) => {
    const home = await makeCursorHome();
    try {
      hooks.ps = result;

      const cleanup = await runCursorSafeCleanup({ env: { HOME: home }, yes: true });

      expect(cleanup).toMatchObject({
        status: 'blocked',
        mode: 'dry-run',
        deletedEntries: 0,
        blockedReasons: ['Cursor process check unavailable']
      });
      await expect(readFile(cacheFile(home), 'utf8')).resolves.toBe('cache');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('deletes nothing when the process list command throws', async () => {
    const home = await makeCursorHome();
    try {
      hooks.psThrows = true;

      const cleanup = await runCursorSafeCleanup({ env: { HOME: home }, yes: true });

      expect(cleanup).toMatchObject({ status: 'blocked', blockedReasons: ['Cursor process check unavailable'] });
      await expect(readFile(cacheFile(home), 'utf8')).resolves.toBe('cache');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('deletes nothing while a Cursor helper process is listed', async () => {
    const home = await makeCursorHome();
    try {
      hooks.ps = { code: 0, stdout: '42 Cursor Helper /Applications/Cursor.app/Contents/Frameworks/Cursor Helper\n', stderr: '' };

      const cleanup = await runCursorSafeCleanup({ env: { HOME: home }, yes: true });

      expect(cleanup).toMatchObject({ status: 'blocked', blockedReasons: ['Cursor is running'] });
      await expect(readFile(cacheFile(home), 'utf8')).resolves.toBe('cache');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function makeCursorHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-cursor-guard-'));
  await mkdir(path.dirname(cacheFile(home)), { recursive: true, mode: 0o700 });
  await writeFile(cacheFile(home), 'cache', { mode: 0o600 });
  return home;
}

function cacheFile(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'Cursor', 'Cache', 'cache.bin');
}
