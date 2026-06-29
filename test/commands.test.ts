import { describe, expect, test } from 'vitest';
import { runCommand } from '../src/commands.js';
import { checkOpenHandles } from '../src/doctor.js';
import { classifyLsofResult, planFixSafety } from '../src/safety.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('command execution safety', () => {
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

      const result = await checkOpenHandles([main, `${main}-wal`, `${main}-shm`]);

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
