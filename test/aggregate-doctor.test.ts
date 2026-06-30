import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { renderReport } from '../src/cli.js';
import { runDoctor } from '../src/doctor.js';
import { sanitizeReportForOutput } from '../src/reports.js';
import type { MaintenanceReport } from '../src/types.js';

describe('aggregate read-only doctor', () => {
  test('builds a schema v2 report with provider buckets and totals', async () => {
    const home = await makeFixtureHome();
    try {
      const { report, reportPath } = await runDoctor({
        platform: 'darwin',
        env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') },
        persistReport: false
      });

      expect(reportPath).toBeUndefined();
      expect(report.schemaVersion).toBe(2);
      expect(report.command).toBe('doctor');
      expect(report.target).toEqual({
        kind: 'aggregate-ai-tools',
        pathCategory: 'ai-tools'
      });
      expect(report.providers?.map((provider) => provider.id)).toEqual(['codex', 'claude-code', 'cursor']);
      expect(report.totals).toEqual({
        totalBytes: 87,
        safeReclaimableBytes: 20,
        confirmBytes: 16,
        privateBytes: 51
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('renders the three-bucket aggregate doctor summary', () => {
    const output = renderReport(makeAggregateReport());

    expect(output).toContain('AI tools        3 detected');
    expect(output).toContain('Total state     67 B');
    expect(output).toContain('Safe reclaimable 20 B');
    expect(output).toContain('Private/danger  31 B (never auto-touched)');
    expect(output).toContain('Codex           7 B');
    expect(output).toContain('Claude Code     21 B');
    expect(output).toContain('Cursor          39 B');
    expect(output).toContain('state.vscdb');
    expect(output).toContain('never');
    expect(output).not.toContain('Safe reclaimable20 B');
    expect(output).not.toContain('Fix readiness');
  });

  test('sanitizes schema v2 providers and totals before output', () => {
    const rawPath = ['', 'Users', 'example', '.claude', 'projects'].join('/');
    const report: MaintenanceReport = {
      ...makeAggregateReport(),
      providers: [{
        id: 'claude-code',
        displayName: 'Claude Code',
        present: true,
        totalBytes: 1,
        buckets: {
          safeReclaimableBytes: 0,
          confirmBytes: 0,
          privateBytes: 1
        },
        entries: [{
          category: 'session',
          pathCategory: rawPath,
          bytes: 1,
          reclaimability: 'never',
          note: `raw path ${rawPath}`,
          warnings: [{
            code: 'read_error',
            pathCategory: rawPath,
            message: `failed at ${rawPath}`,
            realpath: rawPath,
            stdout: rawPath
          } as never]
        }],
        advisories: []
      }]
    };

    const sanitized = JSON.stringify(sanitizeReportForOutput(report));

    expect(sanitized).toContain('"schemaVersion":2');
    expect(sanitized).toContain('"providers"');
    expect(sanitized).toContain('"totals"');
    expect(sanitized).toContain('<home>/.claude/projects');
    expect(sanitized).not.toContain(rawPath);
    expect(sanitized).not.toMatch(/"realpath"|"stdout"/);
  });
});

async function makeFixtureHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-aggregate-home-'));
  await mkdir(path.join(home, '.codex'), { recursive: true });
  await mkdir(path.join(home, '.claude', 'projects', 'workspace'), { recursive: true });
  await mkdir(path.join(home, '.claude', 'debug'), { recursive: true });
  await mkdir(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'), { recursive: true });
  await mkdir(path.join(home, 'Library', 'Application Support', 'Cursor', 'Cache'), { recursive: true });
  await mkdir(path.join(home, 'Library', 'Application Support', 'Cursor', 'CachedData'), { recursive: true });
  await mkdir(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage', 'workspace'), { recursive: true });
  await writeFile(path.join(home, '.codex', 'logs_2.sqlite'), 'codexdb');
  await writeFile(path.join(home, '.claude', 'projects', 'workspace', 'chat.jsonl'), 'private chat');
  await writeFile(path.join(home, '.claude', 'debug', 'debug.log'), 'debug log');
  await writeFile(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), 'conversation history');
  await writeFile(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb.backup'), 'conversation backup');
  await writeFile(path.join(home, 'Library', 'Application Support', 'Cursor', 'Cache', 'cache.bin'), 'cache');
  await writeFile(path.join(home, 'Library', 'Application Support', 'Cursor', 'CachedData', 'cached.bin'), 'cached');
  await writeFile(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage', 'workspace', 'state.json'), 'workspace');
  return home;
}

function makeAggregateReport(): MaintenanceReport {
  return {
    schemaVersion: 2,
    toolVersion: '0.2.4',
    generatedAt: '2026-01-01T00:00:00.000Z',
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
    providers: [
      provider('codex', 'Codex', 7, 0, 7, 0, [
        entry('log', '<home>/.codex/logs_2.sqlite', 7, 'confirm')
      ]),
      provider('claude-code', 'Claude Code', 21, 9, 0, 12, [
        entry('log', '<home>/.claude/debug', 9, 'safe'),
        entry('session', '<home>/.claude/projects', 12, 'never')
      ]),
      provider('cursor', 'Cursor', 39, 11, 9, 19, [
        entry('cache', '<home>/Library/Application Support/Cursor/Cache', 5, 'safe'),
        entry('cache', '<home>/Library/Application Support/Cursor/CachedData', 6, 'safe'),
        entry('session', '<home>/Library/Application Support/Cursor/User/workspaceStorage', 9, 'confirm'),
        entry('appdb', '<home>/Library/Application Support/Cursor/User/globalStorage/state.vscdb', 19, 'never')
      ])
    ],
    totals: {
      totalBytes: 67,
      safeReclaimableBytes: 20,
      confirmBytes: 16,
      privateBytes: 31
    }
  };
}

function provider(
  id: string,
  displayName: string,
  totalBytes: number,
  safeReclaimableBytes: number,
  confirmBytes: number,
  privateBytes: number,
  entries: NonNullable<MaintenanceReport['providers']>[number]['entries']
): NonNullable<MaintenanceReport['providers']>[number] {
  return {
    id,
    displayName,
    present: true,
    totalBytes,
    buckets: { safeReclaimableBytes, confirmBytes, privateBytes },
    entries,
    advisories: []
  };
}

function entry(
  category: NonNullable<MaintenanceReport['providers']>[number]['entries'][number]['category'],
  pathCategory: string,
  bytes: number,
  reclaimability: NonNullable<MaintenanceReport['providers']>[number]['entries'][number]['reclaimability']
): NonNullable<MaintenanceReport['providers']>[number]['entries'][number] {
  return { category, pathCategory, bytes, reclaimability };
}
