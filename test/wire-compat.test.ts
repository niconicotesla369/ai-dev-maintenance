import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { PressureReport } from '../src/pressure/types.js';
import type { MaintenanceReport } from '../src/types.js';

describe('wire compatibility snapshots', () => {
  test('keeps doctor --json wire output stable', async () => {
    const result = await runCli(['doctor', '--json'], {
      commands: {
        runDoctor: async () => ({
          report: makeAggregateDoctorReport(),
          reportPath: '/tmp/aidm-wire-report.json'
        })
      }
    });

    expect(result.exitCode).toBe(0);
    await expectWireOutput('doctor-json.json', result.output);
  });

  test('keeps pressure --json wire output stable', async () => {
    const result = await runCli(['pressure', '--json'], {
      commands: {
        runPressureDoctor: async () => makePressureReport()
      }
    });

    expect(result.exitCode).toBe(0);
    await expectWireOutput('pressure-json.json', result.output);
  });

  test('keeps fix success human output stable', async () => {
    const result = await runCli(['fix', '--safe', '--yes'], {
      commands: {
        runFixSafe: async () => ({
          report: makeFixSuccessReport(),
          reportPath: '/tmp/aidm-wire-fix-success.json'
        })
      }
    });

    expect(result.exitCode).toBe(0);
    await expectWireOutput('fix-success.txt', result.output);
  });

  test('keeps fix blocked human output stable', async () => {
    const result = await runCli(['fix', '--safe', '--yes'], {
      commands: {
        runFixSafe: async () => ({
          report: makeFixBlockedReport(),
          reportPath: '/tmp/aidm-wire-fix-blocked.json'
        })
      }
    });

    expect(result.exitCode).toBe(3);
    await expectWireOutput('fix-blocked.txt', result.output);
  });

  test('keeps report --latest human output stable', async () => {
    const result = await runCli(['report', '--latest'], {
      commands: {
        latestReport: async () => ({
          report: makeAggregateDoctorReport(),
          path: '/tmp/aidm-wire-latest.json'
        })
      }
    });

    expect(result.exitCode).toBe(0);
    await expectWireOutput('report-latest.txt', result.output);
  });
});

async function expectWireOutput(fixtureName: string, actual: string): Promise<void> {
  const expected = await readFile(path.join('test/fixtures/wire', fixtureName), 'utf8');
  expect(actual).toBe(expected);
}

function makeAggregateDoctorReport(): MaintenanceReport {
  return {
    schemaVersion: 2,
    toolVersion: '0.4.1',
    generatedAt: '2026-07-03T00:00:00.000Z',
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: {
      kind: 'aggregate-ai-tools',
      pathCategory: '<home>/ai-tool-state'
    },
    findings: {
      targetState: {
        exists: true,
        fixable: true,
        blockers: [],
        main: {
          pathCategory: 'codex-log-db-main',
          exists: true,
          regularFile: true,
          symbolicLink: false,
          size: 48_930_816
        },
        wal: {
          pathCategory: 'codex-log-db-wal',
          exists: true,
          regularFile: true,
          symbolicLink: false,
          size: 2_936_012
        },
        shm: {
          pathCategory: 'codex-log-db-shm',
          exists: true,
          regularFile: true,
          symbolicLink: false,
          size: 32_768
        }
      },
      fixReadiness: {
        safe: false,
        reasons: ['target database is open by a process']
      },
      warnings: []
    },
    metrics: {},
    blockedReasons: [],
    providers: [
      makeProvider('codex', 'Codex', 46.7, 0, 0, 46.7),
      makeProvider('claude-code', 'Claude Code', 112.2, 0, 56.0, 56.2),
      makeProvider('cursor', 'Cursor', 582.7, 137.7, 0, 445.0)
    ],
    totals: {
      totalBytes: mib(741.6),
      safeReclaimableBytes: mib(137.7),
      confirmBytes: mib(56.0),
      privateBytes: mib(547.8)
    }
  };
}

function makeFixSuccessReport(): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: '0.4.1',
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
      beforeWalBytes: 5_242_880,
      afterWalBytes: 0,
      reclaimedBytes: 5_242_880
    },
    blockedReasons: []
  };
}

function makeFixBlockedReport(): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: '0.4.1',
    generatedAt: '2026-07-03T00:00:00.000Z',
    command: 'fix --safe',
    status: 'blocked',
    redacted: true,
    target: {
      kind: 'default-codex-log-db',
      pathCategory: '<home>/.codex/logs_2.sqlite'
    },
    findings: {},
    metrics: {},
    blockedReasons: ['target database is open by a process'],
    nextSafeAction: 'Close AI coding tools, verify the target path, then run doctor again.'
  };
}

function makePressureReport(): PressureReport {
  return {
    schemaVersion: 2,
    toolVersion: '0.4.1',
    generatedAt: '2026-07-03T00:00:00.000Z',
    command: 'pressure',
    status: 'ok',
    redacted: true,
    platform: 'darwin',
    totals: {
      aiCpuPercent: 54.2,
      aiCpuCapacityPercent: 6.8,
      aiRssBytes: mib(458.7),
      aiProcessCount: 5,
      otherCpuPercent: 119.4,
      otherCpuCapacityPercent: 14.9,
      otherRssBytes: mib(514.8),
      otherProcessCount: 20,
      processCount: 25,
      logicalCpuCount: 8
    },
    pressureLevel: {
      overall: 'high',
      cpu: 'ok',
      memory: 'ok',
      disk: 'high',
      reasons: ['disk pressure is high']
    },
    memory: {
      freePercent: 27,
      pagesFree: 1_000_000,
      swapouts: 0
    },
    disk: {
      availableBytes: mib(17_500),
      capacityPercent: 93
    },
    processes: [
      {
        pid: 11767,
        ppid: 1,
        provider: 'codex',
        category: 'app',
        displayName: 'Codex',
        cpuPercent: 22.5,
        memoryPercent: 2.0,
        rssBytes: mib(65.1),
        commandSummary: 'Codex'
      },
      {
        pid: 485,
        ppid: 1,
        provider: 'other',
        category: 'system',
        displayName: 'WindowServer',
        cpuPercent: 40.9,
        memoryPercent: 1.0,
        rssBytes: mib(80),
        commandSummary: 'WindowServer'
      }
    ],
    warnings: [],
    nextActions: ['Run doctor to inspect disk buckets before deleting anything.']
  };
}

function makeProvider(
  id: string,
  displayName: string,
  totalMiB: number,
  safeMiB: number,
  confirmMiB: number,
  privateMiB: number
): NonNullable<MaintenanceReport['providers']>[number] {
  return {
    id,
    displayName,
    present: true,
    totalBytes: mib(totalMiB),
    buckets: {
      safeReclaimableBytes: mib(safeMiB),
      confirmBytes: mib(confirmMiB),
      privateBytes: mib(privateMiB)
    },
    entries: [],
    advisories: []
  };
}

function mib(value: number): number {
  return Math.round(value * 1024 * 1024);
}
