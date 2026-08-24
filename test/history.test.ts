import { chmod, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import { buildHistoryReport, renderHistoryReport } from '../src/history.js';
import type { HistoryReport } from '../src/history.js';
import type { MaintenanceReport, ProviderReport } from '../src/types.js';

describe('history report', () => {
  test('builds daily growth series from saved aggregate doctor reports', async () => {
    const reportsDir = await makePrivateReportsDir();
    try {
      await writeReportFixture(reportsDir, 'report-1.json', aggregateReport('2026-07-01T10:00:00.000Z', 100, 10));
      await writeReportFixture(reportsDir, 'report-2.json', aggregateReport('2026-07-02T10:00:00.000Z', 130, 20));
      await writeReportFixture(reportsDir, 'report-3.json', aggregateReport('2026-07-03T10:00:00.000Z', 160, 30));

      const report = await buildHistoryReport({ reportsDir, now: new Date('2026-07-04T00:00:00.000Z') });

      expect(report.status).toBe('ok');
      expect(report.dataPoints).toBe(3);
      expect(report.totals).toMatchObject({
        firstBytes: 100,
        lastBytes: 160,
        deltaBytes: 60,
        bytesPerDay: 30
      });
      expect(report.providers.find((provider) => provider.id === 'codex')?.points).toEqual([
        { date: '2026-07-01', totalBytes: 10 },
        { date: '2026-07-02', totalBytes: 20 },
        { date: '2026-07-03', totalBytes: 30 }
      ]);
    } finally {
      await rm(reportsDir, { recursive: true, force: true });
    }
  });

  test('keeps the latest aggregate doctor report per day and skips unsupported reports', async () => {
    const reportsDir = await makePrivateReportsDir();
    try {
      await writeReportFixture(reportsDir, 'report-schema-1.json', {
        ...aggregateReport('2026-07-01T09:00:00.000Z', 1, 1),
        schemaVersion: 1,
        providers: undefined,
        totals: undefined
      });
      await writeReportFixture(reportsDir, 'report-day-old.json', aggregateReport('2026-07-02T09:00:00.000Z', 100, 10));
      await writeReportFixture(reportsDir, 'report-day-new.json', aggregateReport('2026-07-02T18:00:00.000Z', 140, 14));

      const report = await buildHistoryReport({ reportsDir, now: new Date('2026-07-04T00:00:00.000Z') });

      expect(report.dataPoints).toBe(1);
      expect(report.totals.lastBytes).toBe(140);
      expect(report.providers[0]?.points).toEqual([{ date: '2026-07-02', totalBytes: 14 }]);
      expect(report.warnings).toContain('Skipped 1 report that was not aggregate doctor schema v2.');
    } finally {
      await rm(reportsDir, { recursive: true, force: true });
    }
  });

  test('uses plural grammar when multiple unsupported reports are skipped', async () => {
    const reportsDir = await makePrivateReportsDir();
    try {
      await writeReportFixture(reportsDir, 'report-schema-1.json', {
        ...aggregateReport('2026-07-01T09:00:00.000Z', 1, 1),
        schemaVersion: 1,
        providers: undefined,
        totals: undefined
      });
      await writeReportFixture(reportsDir, 'report-pressure.json', {
        ...aggregateReport('2026-07-01T10:00:00.000Z', 1, 1),
        command: 'pressure'
      });

      const report = await buildHistoryReport({ reportsDir, now: new Date('2026-07-04T00:00:00.000Z') });

      expect(report.warnings).toContain('Skipped 2 reports that were not aggregate doctor schema v2.');
    } finally {
      await rm(reportsDir, { recursive: true, force: true });
    }
  });

  test('renders a compact human history summary', async () => {
    const report: HistoryReport = {
      schemaVersion: 1,
      toolVersion: '0.4.1',
      generatedAt: '2026-07-04T00:00:00.000Z',
      command: 'history',
      status: 'ok',
      redacted: true,
      windowDays: 30,
      dataPoints: 3,
      providers: [{
        id: 'codex',
        displayName: 'Codex',
        points: [
          { date: '2026-07-01', totalBytes: 10 },
          { date: '2026-07-02', totalBytes: 20 },
          { date: '2026-07-03', totalBytes: 40 }
        ],
        firstBytes: 10,
        lastBytes: 40,
        deltaBytes: 30,
        bytesPerDay: 15,
        sparkline: '▁▃█'
      }],
      totals: {
        firstBytes: 100,
        lastBytes: 160,
        deltaBytes: 60,
        bytesPerDay: 30,
        sparkline: '▁▄█'
      },
      warnings: [],
      nextActions: []
    };

    const output = renderHistoryReport(report);

    expect(output).toContain('AIDM HISTORY');
    expect(output).toContain('Data points     3');
    expect(output).toContain('Tracked state');
    expect(output).not.toContain('Total state');
    expect(output).toContain('Codex');
    expect(output).toContain('▁▃█');
  });

  test('history --json prints a single JSON document', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-history-home-'));
    const reportsDir = path.join(home, '.ai-dev-maintenance', 'reports');
    try {
      await mkdir(reportsDir, { recursive: true, mode: 0o700 });
      await chmod(path.join(home, '.ai-dev-maintenance'), 0o700);
      await chmod(reportsDir, 0o700);
      await writeReportFixture(reportsDir, 'report-2026-07-03T10-00-00-000Z.json', aggregateReport('2026-07-03T10:00:00.000Z', 100, 10));

      const result = await runCli(['history', '--json'], {
        env: { ...process.env, HOME: home },
        io: { isInputTty: false, isOutputTty: false }
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain('AIDM HISTORY');
      const parsed = JSON.parse(result.output);
      expect(parsed).toMatchObject({
        command: 'history',
        dataPoints: 1,
        redacted: true
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function makePrivateReportsDir(): Promise<string> {
  const appData = await mkdtemp(path.join(os.tmpdir(), 'aidm-history-appdata-'));
  const reportsDir = path.join(appData, 'reports');
  await mkdir(reportsDir, { mode: 0o700 });
  await chmod(appData, 0o700);
  return reportsDir;
}

async function writeReportFixture(dir: string, name: string, report: MaintenanceReport): Promise<void> {
  await writeFile(path.join(dir, name), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function aggregateReport(generatedAt: string, totalBytes: number, codexBytes: number): MaintenanceReport {
  const codex = provider('codex', 'Codex', codexBytes);
  const cursor = provider('cursor', 'Cursor', totalBytes - codexBytes);
  return {
    schemaVersion: 2,
    toolVersion: '0.4.1',
    generatedAt,
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: {
      kind: 'aggregate-ai-tools',
      pathCategory: 'ai-tools'
    },
    findings: {},
    metrics: {},
    blockedReasons: [],
    providers: [codex, cursor],
    totals: {
      totalBytes,
      safeReclaimableBytes: 0,
      confirmBytes: 0,
      privateBytes: totalBytes
    }
  };
}

function provider(id: string, displayName: string, totalBytes: number): ProviderReport {
  return {
    id,
    displayName,
    present: true,
    totalBytes,
    buckets: {
      safeReclaimableBytes: 0,
      confirmBytes: 0,
      privateBytes: totalBytes
    },
    entries: [],
    advisories: []
  };
}
