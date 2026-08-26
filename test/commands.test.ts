import { describe, expect, test } from 'vitest';
import {
  ALLOWED_COMMANDS,
  batchCommandArguments,
  isTrustedSystemCommand,
  runCommand
} from '../src/commands.js';
import { checkOpenHandles } from '../src/doctor.js';
import { classifyLsofResult, planFixSafety } from '../src/safety.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('command execution safety', () => {
  test('batches variable arguments by both count and encoded argv bytes', () => {
    const values = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'];
    const batches = batchCommandArguments(['-F', 'pcn'], values, {
      executable: '/cmd',
      maxValuesPerBatch: 2,
      maxBytesPerBatch: 22
    });

    expect(batches).toEqual([
      ['-F', 'pcn', 'aaaa', 'bbbb'],
      ['-F', 'pcn', 'cccc', 'dddd'],
      ['-F', 'pcn', 'eeee']
    ]);
    expect(batches.flatMap((args) => args.slice(2))).toEqual(values);
    for (const args of batches) {
      expect(['/cmd', ...args].reduce(
        (bytes, arg) => bytes + Buffer.byteLength(arg) + 1,
        0
      )).toBeLessThanOrEqual(22);
    }
  });

  test('rejects an argument that cannot fit a bounded command batch', () => {
    expect(() => batchCommandArguments(['fixed'], ['x'.repeat(20)], {
      executable: '/cmd',
      maxValuesPerBatch: 2,
      maxBytesPerBatch: 16
    })).toThrow('command argument exceeds the batch byte limit');
  });

  test('counts executable argv[0] inside the byte bound', () => {
    const executable = '/usr/sbin/lsof';
    const maxBytesPerBatch = Buffer.byteLength(executable) + 1 + 8;

    expect(() => batchCommandArguments([], ['12345678'], {
      executable,
      maxValuesPerBatch: 1,
      maxBytesPerBatch
    })).toThrow('command argument exceeds the batch byte limit');
  });

  test('allows pressure system commands only through trusted root-owned paths', () => {
    expect(ALLOWED_COMMANDS).toMatchObject({
      launchctl: '/bin/launchctl',
      osascript: '/usr/bin/osascript',
      open: '/usr/bin/open',
      plutil: '/usr/bin/plutil',
      ps: '/bin/ps',
      vm_stat: '/usr/bin/vm_stat',
      df: '/bin/df',
      memory_pressure: '/usr/bin/memory_pressure'
    });

    expect(isTrustedSystemCommand({
      path: '/bin/launchctl',
      uid: 0,
      mode: 0o100755,
      isSymbolicLink: false
    })).toBe(true);
    expect(isTrustedSystemCommand({
      path: '/usr/bin/osascript',
      uid: 0,
      mode: 0o100755,
      isSymbolicLink: false
    })).toBe(true);
    expect(isTrustedSystemCommand({
      path: '/usr/bin/open',
      uid: 0,
      mode: 0o100755,
      isSymbolicLink: false
    })).toBe(true);
    expect(isTrustedSystemCommand({
      path: '/usr/bin/plutil',
      uid: 0,
      mode: 0o100755,
      isSymbolicLink: false
    })).toBe(true);
    expect(isTrustedSystemCommand({
      path: '/usr/bin/vm_stat',
      uid: 0,
      mode: 0o100755,
      isSymbolicLink: false
    })).toBe(true);
    expect(isTrustedSystemCommand({
      path: '/bin/df',
      uid: 0,
      mode: 0o100755,
      isSymbolicLink: false
    })).toBe(true);
    expect(isTrustedSystemCommand({
      path: '/usr/bin/memory_pressure',
      uid: 0,
      mode: 0o100755,
      isSymbolicLink: false
    })).toBe(true);
  });

  test('does not pass the real HOME to subprocesses by default', async () => {
    const result = await runCommand('/usr/bin/printenv', ['HOME']);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).not.toBe(process.env.HOME);
    expect(result.stdout).toContain('ai-dev-maintenance');
  });

  test('marks stdout and stderr truncation instead of silently cutting output', async () => {
    const stdout = await runCommand('/usr/bin/printf', ['abcdef'], {
      maxStdoutBytes: 3
    });
    const stderr = await runCommand('/bin/sh', ['-c', 'printf abcdef >&2'], {
      maxStderrBytes: 3
    });

    expect(stdout.stdout).toBe('abc');
    expect(stdout.stdoutTruncated).toBe(true);
    expect(stderr.stderr).toBe('abc');
    expect(stderr.stderrTruncated).toBe(true);
  });

  test('waits for a timed-out subprocess to exit before returning', async () => {
    const start = Date.now();
    const result = await runCommand('/bin/sleep', ['5'], {
      timeoutMs: 100
    });
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBeTruthy();
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  test('treats truncated process discovery as unsafe for fix', () => {
    const plan = planFixSafety({
      knownCodexProcessExists: false,
      anyOpenHandleOnTarget: false,
      lsofUsable: true,
      processListTruncated: true
    });

    expect(plan.allowed).toBe(false);
    expect(plan.reasons).toContain('process list check was truncated');
  });

  test('classifies lsof failures without preserving raw stderr', () => {
    const result = classifyLsofResult({
      code: 1,
      stdout: '',
      stderr: '/private/path/with/user/name: permission denied',
      stderrTruncated: false,
      stdoutTruncated: false
    });

    expect(result.usable).toBe(false);
    expect(result.reason).toBe('permission_denied');
    expect(JSON.stringify(result)).not.toContain('/private/path');
  });

  test('checks open handles when only the main database file exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aidm-lsof-main-only-'));
    try {
      const main = path.join(dir, 'logs_2.sqlite');
      await writeFile(main, '');
      let resolverCalled = false;
      let runnerCalled = false;

      const result = await checkOpenHandles([main, `${main}-wal`, `${main}-shm`], {
        trustedCommandPath: async (name) => {
          resolverCalled = true;
          expect(name).toBe('lsof');
          return '/mock/lsof';
        },
        runCommand: async (command, args) => {
          runnerCalled = true;
          expect(command).toBe('/mock/lsof');
          expect(args).toEqual(['-F', 'pcn', main]);
          return {
            code: 1,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false
          };
        }
      });

      expect(resolverCalled).toBe(true);
      expect(runnerCalled).toBe(true);
      expect(result).toEqual({
        usable: true,
        openHandles: false,
        reason: 'no open handles reported'
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
