import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { ApplyPlanResult, MaintenancePlanAction, MaintenancePlanSummary } from '../src/plan.js';
import type { CodexNativeCompressionStatus } from '../src/reclaim/codex-native.js';
import type { CodexSessionImageScanResult } from '../src/reclaim/codex-session-images.js';
import type { CodexSessionMonitorResult } from '../src/monitor/codex-sessions.js';
import type { MaintenanceReport } from '../src/types.js';
import { TOOL_VERSION } from '../src/version.js';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

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

  test('image scan JSON uses validated binary units and omits every private candidate field', async () => {
    let received: unknown;
    const privatePath = privateHomePath('.codex', 'sessions', '2026', '01', 'rollout-private.jsonl');
    const result = await runCli([
      'reclaim',
      'scan',
      'codex-session-images',
      '--older-than-days',
      '31',
      '--min-file-size-mb',
      '64',
      '--json'
    ], {
      commands: {
        scanCodexSessionImages: async (options) => {
          received = options;
          return makeImageScanResult(privatePath);
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(received).toMatchObject({ olderThanDays: 31, minFileSizeBytes: 64 * MIB });
    const parsed = JSON.parse(result.output);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      toolVersion: TOOL_VERSION,
      command: 'reclaim scan codex-session-images',
      contentRead: true,
      filters: { olderThanDays: 31, minFileSizeBytes: 64 * MIB },
      totals: { candidateFiles: 1, imagesPrunable: 3, reclaimableBytes: 3072 }
    });
    expect(JSON.stringify(parsed)).not.toContain(privatePath);
    expect(parsed).not.toHaveProperty('candidates');
    expect(parsed).not.toHaveProperty('privateOutcomes');
    expect(JSON.stringify(parsed)).not.toContain('sourceSha256');
    expect(JSON.stringify(parsed)).not.toContain('realpath');
  });

  test('native status and manual monitor JSON remain path-free and manual monitoring never persists', async () => {
    const privatePath = privateHomePath('.codex', 'sessions');
    let monitorOptions: unknown;
    const native = await runCli(['reclaim', 'status', 'codex-native-compression', '--json'], {
      commands: {
        inspectCodexNativeCompression: async () => makeNativeStatus(privatePath)
      }
    });
    const monitor = await runCli(['monitor', 'codex-sessions', '--json'], {
      commands: {
        measureCodexSessionState: async (options) => {
          monitorOptions = options;
          return makeMonitorResult({ warnings: [`review ${privatePath}`] });
        }
      }
    });

    expect(native.exitCode).toBe(0);
    expect(monitor.exitCode).toBe(0);
    expect(monitorOptions).toMatchObject({ persistState: false, notify: false });
    expect(JSON.parse(native.output)).toMatchObject({
      command: 'reclaim status codex-native-compression',
      configuredState: 'unknown'
    });
    expect(JSON.parse(monitor.output)).toMatchObject({
      command: 'monitor codex-sessions',
      statePersisted: false,
      notificationAttempted: false
    });
    expect(native.output).not.toContain(privatePath);
    expect(monitor.output).not.toContain(privatePath);
  });

  test('plan value flags are converted to action-specific byte options instead of positional actions', async () => {
    const received: unknown[] = [];
    const runtime = {
      commands: {
        createPlan: async (options: Parameters<typeof import('../src/plan.js').createMaintenancePlan>[0]) => {
          received.push(options);
          return makePlanSummary(options.action);
        }
      }
    };

    const image = await runCli([
      'plan',
      'codex-session-image-prune',
      '--older-than-days',
      '45',
      '--min-file-size-mb',
      '80',
      '--json'
    ], runtime);
    const monitor = await runCli([
      'plan',
      'codex-session-monitor-install',
      '--threshold-gib',
      '9',
      '--growth-gib',
      '6',
      '--json'
    ], runtime);

    expect(image.exitCode).toBe(0);
    expect(monitor.exitCode).toBe(0);
    expect(received).toEqual([
      expect.objectContaining({
        action: 'codex-session-image-prune',
        actionOptions: { olderThanDays: 45, minFileSizeBytes: 80 * MIB }
      }),
      expect.objectContaining({
        action: 'codex-session-monitor-install',
        actionOptions: { thresholdBytes: 9 * GIB, growthThresholdBytes: 6 * GIB }
      })
    ]);
  });

  test('image apply passes a false image-loss confirmation and remains blocked without the second consent', async () => {
    let received: unknown;
    const result = await runCli(['apply', '--plan', 'plan-image', '--yes', '--json'], {
      commands: {
        applyPlan: async (options) => {
          received = options;
          return makeApplyResult('codex-session-image-prune', 'blocked', false, [
            'image loss confirmation required'
          ]);
        }
      }
    });

    expect(result.exitCode).toBe(3);
    expect(received).toMatchObject({
      planId: 'plan-image',
      confirmations: { imageLoss: false }
    });
    expect(JSON.parse(result.output).blockedReasons).toEqual(['image loss confirmation required']);
  });

  test('--accept-image-loss cannot substitute for the required --yes confirmation', async () => {
    let applyCalled = false;
    const result = await runCli([
      'apply', '--plan', 'plan-image', '--accept-image-loss', '--json'
    ], {
      commands: {
        applyPlan: async () => {
          applyCalled = true;
          throw new Error('apply must not run without --yes');
        }
      }
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Missing required confirmation: --yes');
    expect(applyCalled).toBe(false);
  });

  test('image apply succeeds only when both confirmations are present', async () => {
    let received: unknown;
    const result = await runCli([
      'apply', '--plan', 'plan-image', '--yes', '--accept-image-loss', '--json'
    ], {
      commands: {
        applyPlan: async (options) => {
          received = options;
          return makeApplyResult('codex-session-image-prune', 'ok', true);
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(received).toMatchObject({ confirmations: { imageLoss: true } });
  });

  test('--accept-image-loss is rejected by a non-image plan through action-matched confirmation', async () => {
    let received: unknown;
    const result = await runCli([
      'apply', '--plan', 'plan-sparkle', '--yes', '--accept-image-loss', '--json'
    ], {
      commands: {
        applyPlan: async (options) => {
          received = options;
          return makeApplyResult('codex-sparkle-clean', 'blocked', false, [
            'image loss confirmation does not match plan action'
          ]);
        }
      }
    });

    expect(result.exitCode).toBe(3);
    expect(received).toMatchObject({ confirmations: { imageLoss: true } });
    expect(JSON.parse(result.output).blockedReasons).toEqual([
      'image loss confirmation does not match plan action'
    ]);
  });
});

function privateHomePath(...segments: string[]): string {
  return ['', 'Users', 'example', ...segments].join('/');
}

function makeFixReport(): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
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

function makeImageScanResult(privatePath: string): CodexSessionImageScanResult {
  const pathCategory = '<home>/.codex/sessions/<session-file>';
  return {
    status: 'ok',
    contentRead: true,
    candidates: [{
      path: privatePath,
      pathCategory,
      sourceBytes: 4096,
      projectedBytes: 1024,
      occurrencesSeen: 3,
      imagesPrunable: 3,
      knownPlaceholders: 0,
      belowMinimum: 0,
      lines: 2,
      sourceSha256: 'a'.repeat(64),
      identity: {
        pathCategory,
        realpath: privatePath,
        dev: 1,
        ino: 2,
        mode: 0o100600,
        uid: 501,
        gid: 20,
        size: 4096,
        mtimeMs: 1,
        nlink: 1,
        exists: true,
        regularFile: true,
        symbolicLink: false
      }
    }],
    privateOutcomes: [{
      path: `${privatePath}.other`,
      pathCategory,
      status: 'blocked',
      code: 'unsafe-file'
    }],
    totals: {
      filesConsidered: 2,
      filesOpened: 2,
      filesSkippedBySize: 0,
      filesSkippedAfterRead: 0,
      filesBlocked: 1,
      sourceBytes: 4096,
      projectedBytes: 1024,
      reclaimableBytes: 3072,
      occurrencesSeen: 3,
      imagesPrunable: 3,
      knownPlaceholders: 0,
      belowMinimum: 0
    },
    blockedReasons: ['unsafe-file'],
    warnings: []
  };
}

function makeNativeStatus(privatePath: string): CodexNativeCompressionStatus {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    command: 'reclaim status codex-native-compression',
    status: 'ok',
    supported: true,
    featureStage: 'stable',
    defaultEnabled: false,
    configuredState: 'unknown',
    plainJsonlFiles: 10,
    compressedJsonlFiles: 2,
    warnings: [`review ${privatePath}`],
    nextActions: ['Use the official Codex CLI.']
  };
}

function makeMonitorResult(
  overrides: Partial<CodexSessionMonitorResult> = {}
): CodexSessionMonitorResult {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    command: 'monitor codex-sessions',
    status: 'ok',
    currentBytes: 8 * GIB,
    thresholdBytes: 8 * GIB,
    growthThresholdBytes: 5 * GIB,
    alert: true,
    statePersisted: false,
    notificationAttempted: false,
    warnings: [],
    ...overrides
  };
}

function makePlanSummary(action: MaintenancePlanAction): MaintenancePlanSummary {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    planId: `plan-${action}`,
    action,
    status: 'ready',
    createdAt: '2026-08-25T00:00:00.000Z',
    expiresAt: '2026-08-25T01:00:00.000Z',
    identityHash: 'a'.repeat(64),
    preview: {},
    blockedReasons: [],
    warnings: []
  };
}

function makeApplyResult(
  action: MaintenancePlanAction,
  status: ApplyPlanResult['status'],
  applied: boolean,
  blockedReasons: string[] = []
): ApplyPlanResult {
  return {
    status,
    planId: `plan-${action}`,
    action,
    applied,
    blockedReasons,
    warnings: []
  };
}
