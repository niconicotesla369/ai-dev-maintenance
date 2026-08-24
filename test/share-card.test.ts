import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import { renderPressureShareCard, renderShareCard } from '../src/share-card.js';
import type { PressureReport } from '../src/pressure/types.js';
import type { MaintenanceReport } from '../src/types.js';
import { scanPublicText } from '../scripts/public-hygiene.mjs';

describe('doctor share card', () => {
  test('renders only allowlisted public fields', () => {
    const report = makeAggregateReport({
      generatedAt: '2026-07-03T12:34:56.789Z',
      findings: {
        rawPath: ['', 'Users', 'alice-example', 'private', 'project'].join('/'),
        warning: `pid 12345 used ${['', 'Users', 'alice-example', '.codex', 'logs_2.sqlite'].join('/')}`,
        processName: 'Chrome Helper'
      },
      blockedReasons: ['target database open by pid 12345']
    });

    const output = renderShareCard(report);

    expect(output).toContain('AIDM SHARE CARD');
    expect(output).toContain('Version');
    expect(output).toContain('v0.5.0');
    expect(output).toContain('Date');
    expect(output).toContain('2026-07-03');
    expect(output).toContain('Codex');
    expect(output).toContain('Claude Code');
    expect(output).toContain('Cursor');
    expect(output).toContain('Tracked state');
    expect(output).not.toContain('Total state');
    expect(output).toContain('Safe reclaimable');
    expect(output).toContain('Review first');
    expect(output).toContain('Private danger');
    expect(output).toContain('Private danger buckets are never auto-touched.');
    expect(output).toContain('npx --yes ai-dev-maintenance@0.5.0');

    expect(output).not.toContain('/Users');
    expect(output).not.toContain('<home>');
    expect(output).not.toContain('pid');
    expect(output).not.toContain('12345');
    expect(output).not.toContain('Chrome Helper');
    expect(output).not.toContain('12:34');
    expect(output).not.toContain('T12');
    expect(output).not.toContain('blocked');
    expect(output).not.toContain('warning');
    expect(output).not.toContain('/');
    expect(scanPublicText(output, 'share-card')).toEqual([]);
  });

  test('doctor --share does not persist reports and rejects json output', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await runCli(['doctor', '--share'], {
      commands: {
        runDoctor: async (options) => {
          calls.push(options as Record<string, unknown>);
          return { report: makeAggregateReport(), reportPath: '/tmp/should-not-print.json' };
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AIDM SHARE CARD');
    expect(result.output).not.toContain('/tmp/should-not-print.json');
    expect(calls).toEqual([{ json: false, showPaths: false, persistReport: false }]);

    calls.length = 0;
    const json = await runCli(['doctor', '--share', '--json'], {
      commands: {
        runDoctor: async (options) => {
          calls.push(options as Record<string, unknown>);
          return { report: makeAggregateReport(), reportPath: '/tmp/report.json' };
        }
      }
    });

    expect(json.exitCode).toBe(2);
    expect(json.output).toContain('doctor --share cannot be combined with --json');
    expect(calls).toEqual([]);
  });
});

describe('pressure share card', () => {
  test('renders only allowlisted public pressure fields', () => {
    const report = makePressureReport({
      generatedAt: '2026-07-03T12:34:56.789Z',
      warnings: [
        `pid 12345 used ${['', 'Users', 'alice-example', '.codex', 'logs_2.sqlite'].join('/')}`
      ],
      nextActions: [
        'Run doctor to inspect disk buckets before deleting anything.',
        `Open ${['', 'Users', 'alice-example', 'private'].join('/')}`
      ],
      processes: [
        {
          pid: 12345,
          ppid: 1,
          provider: 'codex',
          category: 'app',
          displayName: 'Secret Codex Helper',
          cpuPercent: 25,
          memoryPercent: 4,
          rssBytes: 128 * 1024 * 1024,
          commandSummary: `node ${['', 'Users', 'alice-example', 'project', 'index.js'].join('/')}`
        }
      ]
    });

    const output = renderPressureShareCard(report);

    expect(output).toContain('AIDM PRESSURE CARD');
    expect(output).toContain('Version');
    expect(output).toContain('v0.5.0');
    expect(output).toContain('Date');
    expect(output).toContain('2026-07-03');
    expect(output).toContain('Pressure');
    expect(output).toContain('HIGH');
    expect(output).toContain('AI CPU');
    expect(output).toContain('6.3% cap');
    expect(output).toContain('Other CPU');
    expect(output).toContain('20.1% cap');
    expect(output).toContain('AI RSS');
    expect(output).toContain('Other RSS');
    expect(output).toContain('Signals');
    expect(output).toContain('Disk pressure is high');
    expect(output).toContain('Next actions');
    expect(output).toContain('Run doctor to inspect disk buckets before deleting anything.');
    expect(output).toContain('npx --yes ai-dev-maintenance@0.5.0 pressure');

    expect(output).not.toContain('/Users');
    expect(output).not.toContain('<home>');
    expect(output).not.toContain('pid');
    expect(output).not.toContain('12345');
    expect(output).not.toContain('Secret Codex Helper');
    expect(output).not.toContain('index.js');
    expect(output).not.toContain('12:34');
    expect(output).not.toContain('T12');
    expect(output).not.toContain('warning');
    expect(output).not.toContain('/');
    expect(scanPublicText(output, 'pressure-share-card')).toEqual([]);
  });

  test('pressure --share is read-only and rejects json output', async () => {
    const calls: string[] = [];
    const result = await runCli(['pressure', '--share'], {
      commands: {
        runPressureDoctor: async () => {
          calls.push('pressure');
          return makePressureReport();
        }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AIDM PRESSURE CARD');
    expect(result.output).not.toContain('What is using CPU?');
    expect(calls).toEqual(['pressure']);

    calls.length = 0;
    const json = await runCli(['pressure', '--share', '--json'], {
      commands: {
        runPressureDoctor: async () => {
          calls.push('pressure');
          return makePressureReport();
        }
      }
    });

    expect(json.exitCode).toBe(2);
    expect(json.output).toContain('pressure --share cannot be combined with --json');
    expect(calls).toEqual([]);
  });
});

function makeAggregateReport(overrides: Partial<MaintenanceReport> = {}): MaintenanceReport {
  return {
    schemaVersion: 2,
    toolVersion: '0.5.0',
    generatedAt: '2026-07-03T00:00:00.000Z',
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: {
      kind: 'aggregate-ai-tools',
      pathCategory: '<home>'
    },
    findings: {},
    metrics: {},
    blockedReasons: [],
    providers: [
      makeProvider('codex', 'Codex', true, 12_345, 2_048, 1_024, 9_273),
      makeProvider('claude-code', 'Claude Code', true, 23_456, 4_096, 2_048, 17_312),
      makeProvider('cursor', 'Cursor', false, 0, 0, 0, 0)
    ],
    totals: {
      totalBytes: 35_801,
      safeReclaimableBytes: 6_144,
      confirmBytes: 3_072,
      privateBytes: 26_585
    },
    ...overrides
  };
}

function makeProvider(
  id: string,
  displayName: string,
  present: boolean,
  totalBytes: number,
  safeReclaimableBytes: number,
  confirmBytes: number,
  privateBytes: number
) {
  return {
    id,
    displayName,
    present,
    totalBytes,
    buckets: {
      safeReclaimableBytes,
      confirmBytes,
      privateBytes
    },
    entries: [],
    advisories: []
  };
}

function makePressureReport(overrides: Partial<PressureReport> = {}): PressureReport {
  return {
    schemaVersion: 2,
    toolVersion: '0.5.0',
    generatedAt: '2026-07-03T00:00:00.000Z',
    command: 'pressure',
    status: 'ok',
    redacted: true,
    platform: 'darwin',
    totals: {
      logicalCpuCount: 8,
      aiCpuPercent: 50.5,
      aiCpuCapacityPercent: 6.3125,
      aiRssBytes: 458_700_000,
      aiProcessCount: 4,
      otherCpuPercent: 160.6,
      otherCpuCapacityPercent: 20.075,
      otherRssBytes: 514_800_000,
      otherProcessCount: 21,
      processCount: 25
    },
    pressureLevel: {
      overall: 'high',
      cpu: 'ok',
      memory: 'ok',
      disk: 'high',
      reasons: ['disk pressure is high', 'non-AI process pressure is elevated']
    },
    memory: {
      freePercent: 27,
      pagesFree: 524288,
      swapouts: 0
    },
    disk: {
      availableBytes: 18 * 1024 * 1024 * 1024,
      capacityPercent: 93
    },
    processes: [],
    warnings: [],
    nextActions: ['Run doctor to inspect disk buckets before deleting anything.'],
    ...overrides
  };
}
