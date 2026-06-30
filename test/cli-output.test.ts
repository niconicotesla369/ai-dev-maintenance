import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { renderReport, shouldShowBanner } from '../src/cli.js';
import { runCodexDoctor } from '../src/doctor.js';
import type { MaintenanceReport } from '../src/types.js';

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
    expect(output).toContain('Next            npm exec --ignore-scripts ai-dev-maintenance@0.2.2 -- fix --safe --yes');
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
      toolVersion: '0.2.2',
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

  test('suppresses banner for JSON, CI, NO_COLOR, no-banner flag, and non-TTY output', () => {
    expect(shouldShowBanner({ json: true, noBanner: false, ci: false, noColor: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: true, ci: false, noColor: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: true, noColor: false, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: true, isTty: true })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: false, isTty: false })).toBe(false);
    expect(shouldShowBanner({ json: false, noBanner: false, ci: false, noColor: false, isTty: true })).toBe(true);
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

describe('public docs for v0.2.2 UX', () => {
  test('readmes document the short npx path and pinned safe path', async () => {
    const readmes = [
      await readFile('README.md', 'utf8'),
      await readFile('README.ja.md', 'utf8')
    ].join('\n');

    expect(readmes).toContain('npx --yes ai-dev-maintenance@0.2.2');
    expect(readmes).toContain('npm exec --yes --ignore-scripts ai-dev-maintenance@0.2.2 -- doctor --show-paths');
    expect(readmes).toContain('Codex / Claude Code / Cursor');
    expect(readmes).toContain('cursor clean --safe --yes');
    expect(readmes).toContain('aidm logo');
    expect(readmes).toContain('target log database is still open');
  });
});

function makeDoctorReport(overrides: Partial<MaintenanceReport>): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: '0.2.2',
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
