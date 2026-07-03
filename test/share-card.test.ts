import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import { renderShareCard } from '../src/share-card.js';
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
    expect(output).toContain('v0.3.1');
    expect(output).toContain('Date');
    expect(output).toContain('2026-07-03');
    expect(output).toContain('Codex');
    expect(output).toContain('Claude Code');
    expect(output).toContain('Cursor');
    expect(output).toContain('Total state');
    expect(output).toContain('Safe reclaimable');
    expect(output).toContain('Review first');
    expect(output).toContain('Private danger');
    expect(output).toContain('Private danger buckets are never auto-touched.');
    expect(output).toContain('npx --yes ai-dev-maintenance@0.3.1');

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

function makeAggregateReport(overrides: Partial<MaintenanceReport> = {}): MaintenanceReport {
  return {
    schemaVersion: 2,
    toolVersion: '0.3.1',
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
