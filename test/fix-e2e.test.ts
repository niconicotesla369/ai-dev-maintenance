import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';

const macTest = process.platform === 'darwin' ? test : test.skip;

describe('fix safe e2e', () => {
  macTest('runs backup and checkpoint on a disposable SQLite WAL fixture', async () => {
    const tempHome = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'aidm-e2e-home-')));
    const previousHome = process.env.HOME;
    try {
      await mkdir(path.join(tempHome, '.codex'), { mode: 0o700 });
      await mkdir(path.join(tempHome, '.ai-dev-maintenance'), { mode: 0o700 });
      const db = path.join(tempHome, '.codex', 'logs_2.sqlite');
      execFileSync('/usr/bin/sqlite3', [
        db,
        [
          'PRAGMA journal_mode=WAL;',
          'PRAGMA wal_autocheckpoint=0;',
          'CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, estimated_bytes INTEGER DEFAULT 0, message TEXT DEFAULT \'\');',
          "INSERT INTO logs(level, estimated_bytes, message) VALUES ('INFO', 128, 'fixture');"
        ].join(' ')
      ]);

      process.env.HOME = tempHome;
      const result = await runCli(['fix', '--safe', '--yes']);
      const backupEntries = await readdir(path.join(tempHome, '.ai-dev-maintenance', 'backups'));
      const reportEntries = await readdir(path.join(tempHome, '.ai-dev-maintenance', 'reports'));

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('Diagnosis       ok');
      expect(result.output).toContain('Changed         private backup + WAL cleanup');
      expect(backupEntries.some((entry) => entry.startsWith('backup-'))).toBe(true);
      expect(reportEntries.some((entry) => /^report-.*\.json$/.test(entry))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);
});
