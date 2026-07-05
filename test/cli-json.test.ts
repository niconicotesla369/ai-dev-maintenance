import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { MaintenanceReport } from '../src/types.js';

describe('management command JSON output', () => {
  test('fix --safe --yes --json prints only the sanitized fix report', async () => {
    const rawReportPath = privateHomePath('.ai-dev-maintenance', 'reports', 'report-private.json');
    const result = await runCli(['fix', '--safe', '--yes', '--json'], {
      commands: {
        runFixSafe: async () => ({
          report: makeFixReport(),
          reportPath: rawReportPath
        })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('Diagnosis');
    expect(result.output).not.toContain('Report');
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      command: 'fix --safe',
      status: 'ok',
      redacted: true
    });
    expect(JSON.stringify(parsed)).not.toContain(privateHomePath());
  });

  test('cursor clean --safe --json omits raw target paths', async () => {
    const rawPath = privateHomePath('Library', 'Application Support', 'Cursor', 'Cache');
    const result = await runCli(['cursor', 'clean', '--safe', '--json'], {
      commands: {
        runCursorSafeCleanup: async () => ({
          status: 'ready',
          mode: 'dry-run',
          reclaimableBytes: 12,
          deletedBytes: 0,
          deletedEntries: 0,
          targets: [{
            path: rawPath,
            pathCategory: '<home>/Library/Application Support/Cursor/Cache',
            bytes: 12,
            note: 'cache data'
          }],
          blockedReasons: [],
          warnings: []
        })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('Cursor cleanup');
    expect(result.output).not.toContain(rawPath);
    const parsed = JSON.parse(result.output);
    expect(parsed.targets).toEqual([{
      pathCategory: '<home>/Library/Application Support/Cursor/Cache',
      bytes: 12,
      note: 'cache data'
    }]);
    expect(JSON.stringify(parsed)).not.toContain('"path"');
  });

  test('prune commands support JSON output', async () => {
    const reports = await runCli(['reports', 'prune', '--yes', '--json'], {
      commands: {
        pruneReports: async () => ({ deleted: 2, warnings: [] })
      }
    });
    const backups = await runCli(['backups', 'prune', '--yes', '--json'], {
      commands: {
        pruneBackups: async () => ({ deleted: 1, warnings: ['skipped unsafe backup-link'] })
      }
    });

    expect(reports.exitCode).toBe(0);
    expect(JSON.parse(reports.output)).toEqual({
      kind: 'reports',
      deleted: 2,
      warnings: []
    });
    expect(backups.exitCode).toBe(3);
    expect(JSON.parse(backups.output)).toEqual({
      kind: 'backups',
      deleted: 1,
      warnings: ['skipped unsafe backup-link']
    });
  });

  test('restore validate --json prints JSON without human text', async () => {
    const result = await runCli(['restore', 'validate', '--backup', '/tmp/backup.sqlite', '--json'], {
      commands: {
        validateRestoreBackup: async () => ({
          valid: true,
          inspection: {
            quickCheck: 'ok',
            recognizedSchema: true
          },
          warnings: ['Validation only.']
        })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('Usage:');
    expect(JSON.parse(result.output)).toEqual({
      valid: true,
      inspection: {
        quickCheck: 'ok',
        recognizedSchema: true
      },
      warnings: ['Validation only.']
    });
  });

  test('report --latest --json returns reportPath and report without text prelude', async () => {
    const reportPath = privateHomePath('.ai-dev-maintenance', 'reports', 'report-latest.json');
    const result = await runCli(['report', '--latest', '--json'], {
      commands: {
        latestReport: async () => ({
          path: reportPath,
          report: makeFixReport()
        })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('Report:');
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({
      reportPath: '<home>/.ai-dev-maintenance/reports/report-latest.json',
      report: {
        schemaVersion: 1,
        command: 'fix --safe',
        redacted: true
      }
    });
    expect(JSON.stringify(parsed)).not.toContain(privateHomePath());
  });

  test('report --latest --json --show-paths exposes only the report file path explicitly requested', async () => {
    const reportPath = privateHomePath('.ai-dev-maintenance', 'reports', 'report-latest.json');
    const result = await runCli(['report', '--latest', '--json', '--show-paths'], {
      commands: {
        latestReport: async () => ({
          path: reportPath,
          report: makeFixReport()
        })
      }
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.reportPath).toBe(reportPath);
    expect(JSON.stringify(parsed.report)).not.toContain(privateHomePath());
  });
});

function privateHomePath(...segments: string[]): string {
  return ['', 'Users', 'example', ...segments].join('/');
}

function makeFixReport(): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: '0.4.0-beta.2',
    generatedAt: '2026-07-03T00:00:00.000Z',
    command: 'fix --safe',
    status: 'ok',
    redacted: true,
    target: {
      kind: 'default-codex-log-db',
      pathCategory: '<home>/.codex/logs_2.sqlite'
    },
    findings: {},
    metrics: {
      beforeWalBytes: 1024,
      afterWalBytes: 0,
      reclaimedBytes: 1024
    },
    blockedReasons: []
  };
}
