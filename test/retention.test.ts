import { chmod, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { pruneBackups, pruneReports } from '../src/retention.js';
import { runCli } from '../src/cli.js';

describe('report and backup retention', () => {
  test('keeps only the newest report files within retention limits', async () => {
    const dir = await makePrivateDir('aidm-reports-retention-');
    try {
      const old = new Date('2026-01-01T00:00:00.000Z');
      const now = new Date('2026-02-15T00:00:00.000Z');
      for (let index = 0; index < 55; index += 1) {
        const file = path.join(dir, `report-2026-02-01T00-00-${String(index).padStart(2, '0')}-000Z.json`);
        await writeFile(file, '{}\n', { mode: 0o600 });
      }
      await writeFile(path.join(dir, 'notes.txt'), 'keep\n', { mode: 0o600 });
      await writeFile(path.join(dir, 'report-old.json'), '{}\n', { mode: 0o600 });
      await touch(path.join(dir, 'report-old.json'), old);

      const result = await pruneReports(dir, { now, maxCount: 50, maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
      const entries = await readdir(dir);

      expect(result.deleted).toBeGreaterThanOrEqual(6);
      expect(entries.filter((entry) => /^report-.*\.json$/.test(entry))).toHaveLength(50);
      expect(entries).toContain('notes.txt');
      expect(entries).not.toContain('report-old.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('deletes report files older than the age limit even when count is below the limit', async () => {
    const dir = await makePrivateDir('aidm-reports-age-retention-');
    try {
      await writeFile(path.join(dir, 'report-old.json'), '{}\n', { mode: 0o600 });
      await touch(path.join(dir, 'report-old.json'), new Date('2026-01-01T00:00:00.000Z'));

      const result = await pruneReports(dir, { now: new Date('2026-02-15T00:00:00.000Z') });
      const entries = await readdir(dir);

      expect(result.deleted).toBe(1);
      expect(entries).not.toContain('report-old.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('keeps newest backup generations and never deletes the current backup', async () => {
    const dir = await makePrivateDir('aidm-backups-retention-');
    try {
      const current = path.join(dir, 'backup-current');
      for (const name of ['backup-a', 'backup-b', 'backup-c', 'backup-d', 'backup-current']) {
        await makeBackupDir(path.join(dir, name));
      }
      await writeFile(path.join(dir, 'readme.txt'), 'keep\n', { mode: 0o600 });

      const result = await pruneBackups(dir, {
        now: new Date('2026-02-15T00:00:00.000Z'),
        maxCount: 3,
        maxAgeMs: 14 * 24 * 60 * 60 * 1000,
        keepPath: current
      });
      const entries = await readdir(dir);

      expect(result.deleted).toBe(2);
      expect(entries).toContain('backup-current');
      expect(entries.filter((entry) => entry.startsWith('backup-'))).toHaveLength(3);
      expect(entries).toContain('readme.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('uses default backup retention policy when only the current backup is provided', async () => {
    const dir = await makePrivateDir('aidm-backups-default-retention-');
    try {
      const current = path.join(dir, 'backup-current');
      for (const name of ['backup-a', 'backup-b', 'backup-c', 'backup-d', 'backup-current']) {
        await makeBackupDir(path.join(dir, name));
        await touch(path.join(dir, name), new Date('2026-01-01T00:00:00.000Z'));
      }
      await touch(current, new Date('2026-06-01T00:00:00.000Z'));

      const result = await pruneBackups(dir, {
        now: new Date('2026-06-29T00:00:00.000Z'),
        keepPath: current
      });
      const entries = await readdir(dir);

      expect(result.deleted).toBe(4);
      expect(entries).toContain('backup-current');
      expect(entries.filter((entry) => entry.startsWith('backup-'))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('deletes old backup generations even when count is below the limit', async () => {
    const dir = await makePrivateDir('aidm-backups-age-retention-');
    try {
      await makeBackupDir(path.join(dir, 'backup-old'));
      await touch(path.join(dir, 'backup-old'), new Date('2026-01-01T00:00:00.000Z'));

      const result = await pruneBackups(dir, { now: new Date('2026-02-15T00:00:00.000Z') });
      const entries = await readdir(dir);

      expect(result.deleted).toBe(1);
      expect(entries).not.toContain('backup-old');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does not delete unsafe symlink backup entries', async () => {
    const dir = await makePrivateDir('aidm-backups-unsafe-');
    const target = await makePrivateDir('aidm-backups-target-');
    try {
      await makeBackupDir(path.join(dir, 'backup-safe'));
      await symlink(target, path.join(dir, 'backup-link'));

      const result = await pruneBackups(dir, {
        now: new Date('2026-02-15T00:00:00.000Z'),
        maxCount: 0,
        maxAgeMs: 0
      });
      const entries = await readdir(dir);

      expect(result.warnings.join('\n')).toContain('backup-link');
      expect(entries).toContain('backup-link');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });
});

describe('prune CLI commands', () => {
  test('accepts explicit report and backup prune commands', async () => {
    const reports = await runCli(['reports', 'prune', '--yes'], {
      commands: {
        pruneReports: async () => ({ deleted: 2, warnings: [] })
      }
    });
    const backups = await runCli(['backups', 'prune', '--yes'], {
      commands: {
        pruneBackups: async () => ({ deleted: 1, warnings: ['skipped unsafe backup-link'] })
      }
    });

    expect(reports.output).not.toContain('Usage:');
    expect(reports.output).toContain('Deleted reports  2');
    expect(backups.output).not.toContain('Usage:');
    expect(backups.output).toContain('Deleted backups  1');
    expect(backups.output).toContain('skipped unsafe backup-link');
  });
});

async function makePrivateDir(prefix: string): Promise<string> {
  const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  await chmod(dir, 0o700);
  return dir;
}

async function makeBackupDir(dir: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(dir, 'logs_2.sqlite.2026.sqlite'), 'sqlite\n', { mode: 0o600 });
  await writeFile(path.join(dir, 'logs_2.sqlite.2026.sqlite.manifest.json'), '{}\n', { mode: 0o600 });
}

async function touch(file: string, date: Date): Promise<void> {
  await import('node:fs/promises').then((fs) => fs.utimes(file, date, date));
}
