import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CommandRunResult } from '../src/types.js';

type CommandOverride = (command: string, args: string[]) => CommandRunResult | undefined;

const hooks = vi.hoisted(() => ({
  command: undefined as CommandOverride | undefined,
  statfs: undefined as ((target: string) => { bavail: number; bsize: number }) | undefined,
  calls: [] as string[][]
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
      hooks.calls.push([command, ...args]);
      return hooks.command?.(command, args) ?? actual.runCommand(command, args, options);
    }
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    statfs: async (target: string) => {
      const override = hooks.statfs?.(target);
      return override ? { ...(await actual.statfs(target)), ...override } : actual.statfs(target);
    }
  };
});

import { runFixSafe } from '../src/fix.js';

const macTest = process.platform === 'darwin' ? test : test.skip;
const SQLITE = '/usr/bin/sqlite3';

let home = '';
let db = '';
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'aidm-fix-failure-'));
  await mkdir(path.join(home, '.codex'), { mode: 0o700 });
  await mkdir(path.join(home, '.ai-dev-maintenance'), { mode: 0o700 });
  db = path.join(home, '.codex', 'logs_2.sqlite');
  if (process.platform === 'darwin') {
    execFileSync(SQLITE, [db, [
      'PRAGMA journal_mode=WAL;',
      "CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, estimated_bytes INTEGER DEFAULT 0, message TEXT DEFAULT '');",
      "INSERT INTO logs(level, estimated_bytes, message) VALUES ('INFO', 128, 'synthetic');"
    ].join(' ')]);
  }
  previousHome = process.env.HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  hooks.calls.length = 0;
  // Deterministic process list so a real Codex on the host cannot change the outcome.
  hooks.command = (command) => command.endsWith('/ps') ? ok(`${process.pid} node node synthetic-test\n`) : undefined;
  hooks.statfs = undefined;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousCodexHome !== undefined) process.env.CODEX_HOME = previousCodexHome;
  hooks.command = undefined;
  hooks.statfs = undefined;
  await rm(home, { recursive: true, force: true });
});

describe('fix --safe failure handling', () => {
  macTest('records a blocked report and leaves the database untouched when the backup command fails', async () => {
    const before = await digest(db);
    overrideSqlite('VACUUM INTO', { code: 1, stdout: '', stderr: 'disk I/O error' });

    const { report, reportPath } = await runFixSafe();

    expect(report.status).toBe('blocked');
    expect(report.blockedReasons).toContain('backup: backup failed');
    expect(report.metrics.checkpointAttempted).toBeUndefined();
    expect(report.metrics.backupCreated).toBeUndefined();
    expect(reportPath).toBeTypeOf('string');
    await expect(access(reportPath ?? '')).resolves.toBeUndefined();
    expect(await backupEntries()).toEqual([]);
    expect(await digest(db)).toBe(before);
    expect(checkpointCalls()).toHaveLength(0);
  }, 45_000);

  macTest('distinguishes a timed-out backup from a failed one', async () => {
    overrideSqlite('VACUUM INTO', { code: null, stdout: '', stderr: '', timedOut: true });

    const { report } = await runFixSafe();

    expect(report.status).toBe('blocked');
    expect(report.blockedReasons).toContain('backup: backup timed out');
    expect(checkpointCalls()).toHaveLength(0);
  }, 45_000);

  macTest('blocks before creating a backup when free space is insufficient', async () => {
    hooks.statfs = () => ({ bavail: 1, bsize: 1 });

    const { report, reportPath } = await runFixSafe();

    expect(report.status).toBe('blocked');
    expect(report.blockedReasons).toContain('before backup: insufficient free space for backup');
    expect(Number(report.metrics.backupRequiredBytes)).toBeGreaterThan(Number(report.metrics.backupAvailableBytes));
    expect(reportPath).toBeTypeOf('string');
    expect(vacuumCalls()).toHaveLength(0);
    expect(await backupEntries()).toEqual([]);
  }, 45_000);

  macTest('blocks before creating a backup when free space cannot be measured', async () => {
    hooks.statfs = () => {
      throw Object.assign(new Error('synthetic statfs failure'), { code: 'EACCES' });
    };

    const { report } = await runFixSafe();

    expect(report.status).toBe('blocked');
    expect(report.blockedReasons).toContain('before backup: free-space check unavailable');
    expect(vacuumCalls()).toHaveLength(0);
  }, 45_000);

  // The open-handle check is the fix gate; the process list is advisory by design.
  macTest.each([
    ['unusable', { code: null, stdout: '', stderr: '', timedOut: true }, 'open-handle check is unavailable'],
    ['reporting an open handle', { code: 0, stdout: 'p4242\ncsynthetic\nn/tmp/logs_2.sqlite\n', stderr: '' }, 'target database is open by a process']
  ] as const)('blocks before any backup when lsof is %s', async (_label, lsofResult, reason) => {
    const base = hooks.command;
    hooks.command = (command, args) => command.endsWith('/lsof') ? lsofResult : base?.(command, args);

    const { report } = await runFixSafe();

    expect(report.status).toBe('blocked');
    expect(report.blockedReasons).toContain(reason);
    expect(report.metrics.backupCreated).toBeUndefined();
    expect(vacuumCalls()).toHaveLength(0);
    expect(checkpointCalls()).toHaveLength(0);
  }, 45_000);

  macTest('reports a timed-out checkpoint as partial, never as blocked', async () => {
    overrideSqlite('wal_checkpoint', { code: null, stdout: '', stderr: '', timedOut: true });

    const { report } = await runFixSafe();

    expect(report.status).toBe('partial');
    expect(report.blockedReasons).toContain('checkpoint timed out; outcome unknown');
    expect(report.metrics).toMatchObject({ backupCreated: true, checkpointAttempted: true });
    expect(report.metrics.reclaimedBytes).toBeUndefined();
  }, 45_000);

  macTest('reports an incomplete checkpoint as partial', async () => {
    overrideSqlite('wal_checkpoint', { code: 0, stdout: '[{"busy":1,"log":5,"checkpointed":2}]\n', stderr: '' });

    const { report } = await runFixSafe();

    expect(report.status).toBe('partial');
    expect(report.blockedReasons).toContain('checkpoint busy');
    expect(report.metrics.checkpointAttempted).toBe(true);
  }, 45_000);

  macTest('keeps the logical rows after a successful run', async () => {
    const { report } = await runFixSafe();

    expect(report.status).toBe('ok');
    expect(execFileSync(SQLITE, [db, 'SELECT count(*), max(message) FROM logs;']).toString().trim()).toBe('1|synthetic');
    const metrics = report.metrics as Record<string, number>;
    expect(metrics.targetNetDeltaBytes).toBe(
      (metrics.afterMainBytes + metrics.afterWalBytes) - (metrics.beforeMainBytes + metrics.beforeWalBytes)
    );
    expect(metrics.backupBytes).toBeGreaterThan(0);
  }, 45_000);
});

function ok(stdout: string): CommandRunResult {
  return { code: 0, stdout, stderr: '' };
}

function overrideSqlite(marker: string, result: CommandRunResult): void {
  const base = hooks.command;
  hooks.command = (command, args) => {
    if (command === SQLITE && args.some((arg) => arg.includes(marker))) return result;
    return base?.(command, args);
  };
}

function vacuumCalls(): string[][] {
  return hooks.calls.filter((call) => call.some((arg) => arg.includes('VACUUM INTO')));
}

function checkpointCalls(): string[][] {
  return hooks.calls.filter((call) => call.some((arg) => arg.includes('wal_checkpoint')));
}

async function backupEntries(): Promise<string[]> {
  return readdir(path.join(home, '.ai-dev-maintenance', 'backups')).catch(() => []);
}

async function digest(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
