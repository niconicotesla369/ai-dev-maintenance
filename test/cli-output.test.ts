import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { renderReport, runCli, shouldShowBanner } from '../src/cli.js';
import { runCodexDoctor } from '../src/doctor.js';
import type { MaintenancePlanSummary } from '../src/plan.js';
import type { CodexSessionImageScanResult } from '../src/reclaim/codex-session-images.js';
import type { CodexSessionMonitorNotification, CodexSessionMonitorResult } from '../src/monitor/codex-sessions.js';
import type { MaintenanceReport } from '../src/types.js';
import { TOOL_VERSION } from '../src/version.js';

const GIB = 1024 ** 3;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('human CLI output', () => {
  test('does not block fix readiness on Codex advisory process alone', () => {
    const output = renderReport(makeDoctorReport({
      findings: {
        openHandles: { usable: true, openHandles: false },
        knownCodexProcessExists: true
      }
    }));

    expect(output).toContain('Fix readiness   ready');
    expect(output).not.toContain('Reason          known Codex process is running');
    expect(output).not.toContain('Blocked reasons: none');
    expect(output).not.toContain('Safe to run fix --safe --yes');
  });

  test('shows ready fix action and human-readable target sizes', () => {
    const output = renderReport(makeDoctorReport({
      findings: {
        targetState: {
          main: { size: 48_930_816 },
          wal: { size: 5_496_112 },
          shm: { size: 1_048_576 }
        },
        openHandles: { usable: true, openHandles: false },
        knownCodexProcessExists: false
      }
    }));

    expect(output).toContain('Fix readiness   ready');
    expect(output).toContain(`Next            npm exec --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- fix --safe --yes`);
    expect(output).toContain('Main DB         46.7 MiB');
    expect(output).toContain('WAL             5.2 MiB');
    expect(output).toContain('SHM             1.0 MiB');
    expect(output).not.toContain('48930816');
    expect(output).not.toContain('5496112');
  });

  test('can include a small banner for human output only', () => {
    const report = makeDoctorReport({
      findings: {
        openHandles: { usable: true, openHandles: false },
        knownCodexProcessExists: false
      }
    });

    expect(renderReport(report, undefined, false, { banner: true })).toMatch(/^AI DEV MAINTENANCE\nCodex log doctor\n\n/);
    expect(renderReport(report, undefined, false, { banner: false })).not.toContain('AI DEV MAINTENANCE');
  });

  test('show paths displays the local report path only in human output', () => {
    const reportPath = path.join(os.tmpdir(), 'aidm-report.json');
    const report = makeDoctorReport({
      findings: {
        openHandles: { usable: true, openHandles: false },
        knownCodexProcessExists: false
      }
    });

    expect(renderReport(report, reportPath, false)).toContain('Report          <absolute-path>');
    expect(renderReport(report, reportPath, true)).toContain(`Report          ${reportPath}`);
  });

  test('does not show doctor-only fix readiness on fix reports', () => {
    const output = renderReport({
      schemaVersion: 1,
      toolVersion: TOOL_VERSION,
      generatedAt: '2026-01-01T00:00:00.000Z',
      command: 'fix --safe',
      status: 'ok',
      redacted: true,
      target: {
        kind: 'default-codex-log-db',
        pathCategory: '<home>/.codex/logs_2.sqlite'
      },
      findings: {},
      metrics: {
        beforeWalBytes: 5_242_880,
        afterWalBytes: 0,
        reclaimedBytes: 5_242_880
      },
      blockedReasons: []
    });

    expect(output).toContain('Diagnosis       ok');
    expect(output).toContain('Changed         private backup + WAL cleanup');
    expect(output).toContain('Reclaimed       5.0 MiB');
    expect(output).not.toContain('Fix readiness');
    expect(output).not.toContain('not a doctor report');
  });

  test('labels folded WAL honestly and shows the measured net change and backup when recorded', () => {
    const output = renderReport({
      schemaVersion: 1,
      toolVersion: '0.6.0',
      generatedAt: '2026-09-29T00:00:00.000Z',
      command: 'fix --safe',
      status: 'ok',
      redacted: true,
      target: { kind: 'default-codex-log-db', pathCategory: '<home>/.codex/logs_2.sqlite' },
      findings: {},
      metrics: {
        beforeWalBytes: 801_706_712,
        afterWalBytes: 0,
        reclaimedBytes: 801_706_712,
        beforeMainBytes: 48_930_816,
        afterMainBytes: 797_044_736,
        targetNetDeltaBytes: -53_592_792,
        backupBytes: 797_044_736
      },
      blockedReasons: []
    });

    expect(output).toContain('WAL folded      764.6 MiB');
    expect(output).toContain('DB+WAL change   -51.1 MiB');
    expect(output).toContain('Backup kept     760.1 MiB');
    expect(output).not.toContain('Reclaimed');
  });

  test('suppresses banner for JSON, CI, NO_COLOR, no-banner flag, and non-TTY output', () => {
    expect(shouldShowBanner({ json: true, noBanner: false, ci: false, noColor: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: true, ci: false, noColor: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: true, noColor: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: true, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: false, isTty: false })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: false, isTty: true })).toBe(true);
  });

  test('puts a local content-reading disclosure before human image-scan results', async () => {
    const privatePath = privateHomePath('.codex', 'sessions', 'rollout-private.jsonl');
    const result = await runCli(['reclaim', 'scan', 'codex-session-images'], {
      commands: {
        scanCodexSessionImages: async () => makeImageScanResult(privatePath)
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/^Content access\s+Reads candidate Codex session JSONL contents locally;/);
    expect(result.output).toContain('no session content is printed or uploaded');
    expect(result.output).toContain('Reclaimable');
    expect(result.output).toContain('3.0 KiB');
    expect(result.output).not.toContain(privatePath);
  });

  test('labels image-prune plans as irreversible and names both confirmations', async () => {
    const result = await runCli(['plan', 'codex-session-image-prune'], {
      commands: {
        createPlan: async () => makeImagePlanSummary()
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Irreversible image loss');
    expect(result.output).toContain('--yes');
    expect(result.output).toContain('--accept-image-loss');
  });

  test.each([
    ['codex-session-image-prune', { reclaimedBytes: 13 * GIB, volumeFreeDeltaBytes: 12 * GIB, imagesStripped: 23_848 }],
    ['codex-sparkle-clean', { deletedBytes: 6 * GIB, volumeFreeDeltaBytes: -1 * GIB, deletedEntries: 4 }]
  ] as const)('renders actual reclaimed and volume free deltas after %s apply', async (action, actionResult) => {
    const result = await runCli(['apply', '--plan', `plan-${action}`, '--yes', ...(action === 'codex-session-image-prune' ? ['--accept-image-loss'] : [])], {
      commands: {
        applyPlan: async () => ({
          status: 'ok',
          planId: `plan-${action}`,
          action,
          applied: true,
          blockedReasons: [],
          warnings: [],
          result: { status: 'ok', changed: true, blockedReasons: [], warnings: [], ...actionResult }
        })
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(action === 'codex-session-image-prune' ? '13.0 GiB' : '6.0 GiB');
    expect(result.output).toContain(action === 'codex-session-image-prune' ? '12.0 GiB' : '-1.0 GiB');
    expect(result.output).toContain('Free-space delta');
  });

  test('runs the hidden scheduler only as a persistent metadata monitor with fixed notification wiring', async () => {
    let monitorOptions: Record<string, unknown> | undefined;
    let notification: CodexSessionMonitorNotification | undefined;
    const result = await runCli([
      '__scheduled-monitor',
      'codex-sessions',
      '--threshold-bytes',
      String(8 * GIB),
      '--growth-threshold-bytes',
      String(5 * GIB)
    ], {
      env: { HOME: privateHomePath() },
      commands: {
        measureCodexSessionState: async (options) => {
          monitorOptions = options as unknown as Record<string, unknown>;
          const candidate: CodexSessionMonitorNotification = {
            currentBytes: 9 * GIB,
            thresholdBytes: 8 * GIB,
            growthThresholdBytes: 5 * GIB,
            measurementComplete: true
          };
          const delivered = await options?.notificationSender?.(candidate);
          return makeMonitorResult({
            statePersisted: true,
            notificationAttempted: true,
            notificationDelivered: delivered
          });
        },
        sendCodexSessionMonitorNotification: async (candidate) => {
          notification = candidate;
          return true;
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(monitorOptions).toMatchObject({
      thresholdBytes: 8 * GIB,
      growthThresholdBytes: 5 * GIB,
      persistState: true,
      notify: true
    });
    expect(notification).toMatchObject({ currentBytes: 9 * GIB, measurementComplete: true });
    expect(JSON.parse(result.output)).toMatchObject({
      statePersisted: true,
      notificationAttempted: true,
      notificationDelivered: true
    });
  });
});

describe('doctor fix readiness report field', () => {
  test('adds machine-readable fix readiness to doctor reports', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'ai-dev-maintenance-codex-home-'));
    tempDirs.push(codexHome);

    const { report } = await runCodexDoctor({
      platform: 'darwin',
      env: { ...process.env, CODEX_HOME: codexHome }
    });

    expect(report.findings.fixReadiness).toEqual({
      safe: expect.any(Boolean),
      reasons: expect.any(Array)
    });
  });
});

describe('public docs for v0.3.0 UX', () => {
  test('readmes document the short npx path and pinned safe path', async () => {
    const readmes = [
      await readFile('README.md', 'utf8'),
      await readFile('README.ja.md', 'utf8')
    ].join('\n');

    expect(readmes).toContain(`npx --yes ai-dev-maintenance@${TOOL_VERSION}`);
    expect(readmes).toContain(`npm exec --yes --ignore-scripts ai-dev-maintenance@${TOOL_VERSION} -- doctor --show-paths`);
    expect(readmes).toContain('Codex / Claude Code / Cursor');
    expect(readmes).toContain('cursor clean --safe --yes');
    expect(readmes).toContain('aidm logo');
    expect(readmes).toContain('target log database is still open');
  });
});

function makeDoctorReport(overrides: Partial<MaintenanceReport>): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: {
      kind: 'default-codex-log-db',
      pathCategory: '<home>/.codex/logs_2.sqlite'
    },
    findings: {},
    metrics: {},
    blockedReasons: [],
    ...overrides
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
      lines: 1,
      sourceSha256: 'a'.repeat(64),
      identity: {
        pathCategory,
        realpath: privatePath,
        exists: true,
        regularFile: true,
        symbolicLink: false
      }
    }],
    privateOutcomes: [],
    totals: {
      filesConsidered: 1,
      filesOpened: 1,
      filesSkippedBySize: 0,
      filesSkippedAfterRead: 0,
      filesBlocked: 0,
      sourceBytes: 4096,
      projectedBytes: 1024,
      reclaimableBytes: 3072,
      occurrencesSeen: 3,
      imagesPrunable: 3,
      knownPlaceholders: 0,
      belowMinimum: 0
    },
    blockedReasons: [],
    warnings: []
  };
}

function makeImagePlanSummary(): MaintenancePlanSummary {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    planId: 'plan-image',
    action: 'codex-session-image-prune',
    status: 'ready',
    createdAt: '2026-08-25T00:00:00.000Z',
    expiresAt: '2026-08-25T01:00:00.000Z',
    identityHash: 'a'.repeat(64),
    preview: {
      imagesPrunable: 23_848,
      reclaimableBytes: 13 * GIB,
      contentRead: true,
      irreversible: true
    },
    blockedReasons: [],
    warnings: []
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
    currentBytes: 9 * GIB,
    thresholdBytes: 8 * GIB,
    growthThresholdBytes: 5 * GIB,
    alert: true,
    statePersisted: false,
    notificationAttempted: false,
    warnings: [],
    ...overrides
  };
}

function privateHomePath(...segments: string[]): string {
  return ['', 'Users', 'example', ...segments].join('/');
}
