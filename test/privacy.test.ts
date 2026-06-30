import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { sanitizeReportForOutput, writeReport } from '../src/reports.js';
import { redactPath } from '../src/paths.js';
import { formatCliError } from '../src/cli.js';
import type { MaintenanceReport } from '../src/types.js';

describe('privacy boundaries', () => {
  test('redacts non-home absolute paths before they enter user-visible reports', () => {
    const volumePath = ['', 'Volumes', 'Work', 'example', 'logs_2.sqlite'].join('/');
    const privatePath = ['', 'private', 'var', 'folders', 'example', 'logs_2.sqlite'].join('/');
    const tmpPath = ['', 'tmp', 'example', 'logs_2.sqlite'].join('/');

    expect(redactPath(volumePath)).toBe('<absolute-path>');
    expect(redactPath(privatePath)).toBe('<absolute-path>');
    expect(redactPath(`prefix ${tmpPath} suffix`)).toBe('prefix <absolute-path> suffix');
  });

  test('sanitizes saved reports again before printing latest report output', () => {
    const homePath = ['', 'Users', 'example', '.codex', 'logs_2.sqlite'].join('/');
    const privatePath = ['', 'private', 'var', 'folders', 'example', 'logs_2.sqlite'].join('/');
    const volumePath = ['', 'Volumes', 'Work', 'private stderr'].join('/');
    const tmpPath = ['', 'tmp', 'example', 'raw'].join('/');
    const report: MaintenanceReport & { unexpectedRawPath?: string } = {
      schemaVersion: 1,
      toolVersion: '0.0.0-test',
      generatedAt: '2026-01-01T00:00:00.000Z',
      command: 'doctor',
      status: 'partial',
      redacted: true,
      target: {
        kind: 'default-codex-log-db',
        pathCategory: '<home>/.codex/logs_2.sqlite'
      },
      findings: {
        [homePath]: 'path-shaped key',
        targetState: {
          main: {
            pathCategory: 'codex-log-db-main',
            exists: true,
            regularFile: true,
            symbolicLink: false,
            size: 1,
            dev: 1,
            ino: 2,
            uid: 501,
            gid: 20,
            mode: 33152,
            realpath: homePath
          }
        },
        sqlite: {
          error: `sqlite failed near ${privatePath}`
        },
        rawStderr: volumePath
      },
      metrics: {},
      blockedReasons: [`${homePath} is group writable`],
      unexpectedRawPath: tmpPath
    };

    const sanitized = JSON.stringify(sanitizeReportForOutput(report));

    expect(sanitized).not.toMatch(/"dev"|"ino"|"uid"|"gid"|"mode"|"realpath"|rawStderr|unexpectedRawPath/);
    expect(sanitized).not.toContain(homePath);
    expect(sanitized).not.toContain(['', 'private', 'var'].join('/'));
    expect(sanitized).not.toContain(['', 'Volumes'].join('/'));
    expect(sanitized).not.toContain(['', 'tmp', 'example'].join('/'));
  });

  test('sanitizes reports before writing them to disk', async () => {
    const rawPath = ['', 'Users', 'example', '.codex', 'logs_2.sqlite'].join('/');
    const report: MaintenanceReport = {
      schemaVersion: 1,
      toolVersion: '0.2.3',
      generatedAt: '2026-01-01T00:00:00.123Z',
      command: 'doctor',
      status: 'partial',
      redacted: true,
      target: {
        kind: 'default-codex-log-db',
        pathCategory: rawPath
      },
      findings: {
        targetState: {
          main: {
            pathCategory: 'codex-log-db-main',
            exists: true,
            regularFile: true,
            symbolicLink: false,
            size: 1,
            dev: 1,
            ino: 2,
            uid: 501,
            gid: 20,
            mode: 33152,
            mtimeMs: 1,
            realpath: rawPath
          }
        },
        stdout: rawPath,
        stderr: rawPath
      },
      metrics: {},
      blockedReasons: [rawPath]
    };

    const written = await writeReport(report);
    try {
      const saved = await readFile(written, 'utf8');

      expect(saved).not.toMatch(/"dev"|"ino"|"uid"|"gid"|"mode"|"mtimeMs"|"realpath"|"stdout"|"stderr"/);
      expect(saved).not.toContain(rawPath);
      expect(saved).toContain('<home>/.codex/logs_2.sqlite');
    } finally {
      await rm(written, { force: true });
    }
  });

  test('redacts absolute paths with spaces', () => {
    const homePath = ['', 'Users', 'Name With Space', '.codex', 'logs_2.sqlite'].join('/');
    const volumePath = ['', 'Volumes', 'Work Drive', 'private.txt'].join('/');
    const tmpPath = ['', 'tmp', 'my dir', 'file.txt'].join('/');

    expect(redactPath(homePath)).toBe('<home>/.codex/logs_2.sqlite');
    expect(redactPath(volumePath)).toBe('<absolute-path>');
    expect(redactPath(tmpPath)).toBe('<absolute-path>');
  });

  test('doctor and fix do not create private SQLite byte snapshots for inspection', async () => {
    const doctor = await readFile(path.join(process.cwd(), 'src/doctor.ts'), 'utf8');
    const fix = await readFile(path.join(process.cwd(), 'src/fix.ts'), 'utf8');
    const sqlite = await readFile(path.join(process.cwd(), 'src/sqlite.ts'), 'utf8');

    expect(doctor).not.toContain('createPrivateSnapshot');
    expect(fix).not.toContain('createPrivateSnapshot');
    expect(sqlite).not.toContain('copyFile(mainPath');
  });

  test('top-level CLI errors are redacted before printing', () => {
    const rawPath = ['', 'Users', 'example', '.ai-dev-maintenance', 'reports'].join('/');
    const output = formatCliError(new Error(`unsafe private directory: ${rawPath} is group writable`));

    expect(output).toContain('<home>');
    expect(output).not.toContain(rawPath);
  });
});
