import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  classifyLsofResult,
  createSqliteUri,
  detectTargetState,
  isTrustedSystemCommand,
  planFixSafety,
  redactPath
} from '../src/index.js';

describe('SQLite safety', () => {
  test('uses file URI mode and rejects plain sqlite paths', () => {
    expect(createSqliteUri('/tmp/example db.sqlite', 'ro')).toBe(
      'file:///tmp/example%20db.sqlite?mode=ro'
    );
    expect(createSqliteUri('/tmp/example.db', 'rw')).toBe(
      'file:///tmp/example.db?mode=rw'
    );
  });

  test('does not treat a missing main database as fixable', async () => {
    const root = await makeTempDir();
    const state = await detectTargetState(path.join(root, '.codex', 'logs_2.sqlite'));

    expect(state.exists).toBe(false);
    expect(state.fixable).toBe(false);
    expect(state.blockers).toContain('main database is missing');
  });
});

describe('process and command safety', () => {
  test('blocks fix when any known Codex process exists', () => {
    const plan = planFixSafety({
      knownCodexProcessExists: true,
      anyOpenHandleOnTarget: false,
      lsofUsable: true
    });

    expect(plan.allowed).toBe(false);
    expect(plan.reasons).toContain('known Codex process is running');
  });

  test('blocks fix when lsof cannot prove the target is closed', () => {
    const plan = planFixSafety({
      knownCodexProcessExists: false,
      anyOpenHandleOnTarget: false,
      lsofUsable: false
    });

    expect(plan.allowed).toBe(false);
    expect(plan.reasons).toContain('open-handle check is unavailable');
  });

  test('classifies lsof no-output exit as no handles but stderr as unsafe', () => {
    expect(classifyLsofResult({ code: 1, stdout: '', stderr: '' })).toEqual({
      usable: true,
      openHandles: false,
      reason: 'no open handles reported'
    });
    expect(classifyLsofResult({ code: 1, stdout: '', stderr: 'permission denied' })).toEqual({
      usable: false,
      openHandles: false,
      reason: 'permission_denied'
    });
    expect(classifyLsofResult({ code: 0, stdout: '', stderr: 'unexpected warning' })).toEqual({
      usable: false,
      openHandles: false,
      reason: 'nonzero_stderr'
    });
  });

  test('trusts only root-owned non-writable absolute system commands', () => {
    expect(
      isTrustedSystemCommand({
        path: '/usr/bin/sqlite3',
        uid: 0,
        mode: 0o100755,
        isSymbolicLink: false
      })
    ).toBe(true);
    expect(
      isTrustedSystemCommand({
        path: '/tmp/sqlite3',
        uid: 501,
        mode: 0o100755,
        isSymbolicLink: false
      })
    ).toBe(false);
  });
});

describe('privacy', () => {
  test('redacts absolute home paths by default', () => {
    const sample = ['', 'Users', 'example', '.codex', 'logs_2.sqlite'].join('/');
    expect(redactPath(sample)).toBe('<home>/.codex/logs_2.sqlite');
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(tmpdir(), 'adm-test-'))
  );
  await mkdir(path.join(dir, '.codex'), { recursive: true });
  await writeFile(path.join(dir, 'placeholder'), '');
  return dir;
}
