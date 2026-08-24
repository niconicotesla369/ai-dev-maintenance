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
        persistReport: false,
        statfs: fixtureStatfs
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
      expect(report.metrics.volume).toEqual({
        totalBytes: 4_096_000,
        usedBytes: 3_686_400,
        availableBytes: 204_800,
        capacityPercent: 94.7,
        trackedStatePercentOfUsedBytes: 0
      });
      expect(report.findings.coverage).toEqual({
        complete: true,
        trackedStateIsLowerBound: false,
        warnings: [{
          code: 'tracked-state-gap',
          message: 'Tracked AI-tool state is under 5% of used volume; inspect other System Data sources before attributing disk pressure to these providers.'
        }]
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('next safe action directs agents through plan and human apply', async () => {
    const home = await makeFixtureHome();
    try {
      const { report } = await runDoctor({
        platform: 'darwin',
        env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') },
        persistReport: false
      });

      expect(report.nextSafeAction).toBe('Review tracked provider buckets and coverage warnings. Dry run: aidm cursor clean --safe. To clean, create a plan with "aidm plan cursor-clean --json" and have a human run "aidm apply --plan <planId> --yes".');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('retains provider results when statfs throws', async () => {
    const home = await makeFixtureHome();
    try {
      const { report } = await runDoctor({
        platform: 'darwin',
        env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') },
        persistReport: false,
        statfs: async () => { throw new Error('fixture statfs failure'); }
      });

      expect(report.status).toBe('partial');
      expect(report.providers?.map((provider) => provider.id)).toEqual(['codex', 'claude-code', 'cursor']);
      expect(report.totals?.totalBytes).toBe(87);
      expect(report.metrics).not.toHaveProperty('volume');
      expect(report.findings.coverage).toEqual({
        complete: false,
        trackedStateIsLowerBound: false,
        warnings: [{
          code: 'volume-usage-unavailable',
          message: 'Volume usage context is unavailable.'
        }]
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('treats invalid statfs byte arithmetic as unavailable volume usage', async () => {
    const home = await makeFixtureHome();
    try {
      const { report } = await runDoctor({
        platform: 'darwin',
        env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') },
        persistReport: false,
        statfs: async () => ({ bsize: 4_096, blocks: 100, bfree: 101, bavail: 1 })
      });

      expect(report.status).toBe('partial');
      expect(report.metrics).not.toHaveProperty('volume');
      expect(report.findings.coverage).toEqual({
        complete: false,
        trackedStateIsLowerBound: false,
        warnings: [{
          code: 'volume-usage-unavailable',
          message: 'Volume usage context is unavailable.'
        }]
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('omits capacity percent when the occupied-volume denominator is zero', async () => {
    const home = await makeFixtureHome();
    try {
      const { report } = await runDoctor({
        platform: 'darwin',
        env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') },
        persistReport: false,
        statfs: async () => ({ bsize: 4_096, blocks: 100, bfree: 100, bavail: 0 })
      });

      expect(report.metrics.volume).toEqual({
        totalBytes: 409_600,
        usedBytes: 0,
        availableBytes: 0
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('omits tracked-state percent when the used-byte denominator is zero', async () => {
    const home = await makeFixtureHome();
    try {
      const { report } = await runDoctor({
        platform: 'darwin',
        env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') },
        persistReport: false,
        statfs: async () => ({ bsize: 4_096, blocks: 100, bfree: 100, bavail: 50 })
      });

      expect(report.metrics.volume).toEqual({
        totalBytes: 409_600,
        usedBytes: 0,
        availableBytes: 204_800,
        capacityPercent: 0
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('marks deep Codex state as a lower bound', async () => {
    const home = await makeFixtureHome();
    try {
      await makeDeepCodexSession(home);
      const { report } = await runDoctor({
        platform: 'darwin',
        env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex') },
        persistReport: false,
        statfs: async () => ({ bsize: 4_096, blocks: 1_000, bfree: 100, bavail: 900 })
      });

      expect(report.status).toBe('partial');
      expect(report.findings.coverage).toMatchObject({
        complete: false,
        trackedStateIsLowerBound: true
      });
      expect(coverageWarnings(report)).toEqual([{
        code: 'scan-truncated',
        message: 'Tracked state is a lower bound because one or more scans were incomplete.'
      }]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('renders the three-bucket aggregate doctor summary', () => {
    const output = renderReport(makeAggregateReport());

    expect(output).toContain('AI tools        3 detected');
    expect(output).toContain('Tracked state   67 B');
    expect(output).toContain('Volume used     94.7%');
    expect(output).toContain('Tracked share   <0.1% of used volume');
    expect(output).toContain('Warning         Tracked AI-tool state is under 5% of used volume');
    expect(output).not.toContain('Total state');
    expect(output).toContain('Safe reclaimable 20 B');
    expect(output).toContain('Private/danger  31 B (never auto-touched)');
    expect(output).toContain('Codex           7 B');
    expect(output).toContain('Claude Code     21 B');
    expect(output).toContain('Cursor          39 B');
    expect(output).toContain('state.vscdb');
    expect(output).toContain('Cache           5 B safe (lower bound)');
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

const fixtureStatfs = async () => ({
  bsize: 4_096,
  blocks: 1_000,
  bfree: 100,
  bavail: 50
});

async function makeDeepCodexSession(home: string): Promise<void> {
  const nested = path.join(home, '.codex', 'sessions', ...Array.from({ length: 33 }, (_, index) => `level-${index}`));
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, 'session.jsonl'), 'deep session');
}

function coverageWarnings(report: MaintenanceReport): Array<{ code: string; message: string }> {
  const coverage = report.findings.coverage;
  if (!isRecord(coverage) || !Array.isArray(coverage.warnings)) return [];
  return coverage.warnings.flatMap((warning) => {
    if (!isRecord(warning) || typeof warning.code !== 'string' || typeof warning.message !== 'string') return [];
    return [{ code: warning.code, message: warning.message }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function makeAggregateReport(): MaintenanceReport {
  return {
    schemaVersion: 2,
    toolVersion: '0.3.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: {
      kind: 'aggregate-ai-tools',
      pathCategory: 'ai-tools'
    },
    findings: {
      coverage: {
        warnings: [{
          code: 'tracked-state-gap',
          message: 'Tracked AI-tool state is under 5% of used volume; inspect other System Data sources before attributing disk pressure to these providers.'
        }]
      }
    },
    metrics: {
      volume: {
        totalBytes: 4_096_000,
        usedBytes: 3_686_400,
        availableBytes: 204_800,
        capacityPercent: 94.7,
        trackedStatePercentOfUsedBytes: 0
      }
    },
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
        entry('cache', '<home>/Library/Application Support/Cursor/Cache', 5, 'safe', true),
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
  reclaimability: NonNullable<MaintenanceReport['providers']>[number]['entries'][number]['reclaimability'],
  sizeTruncated = false
): NonNullable<MaintenanceReport['providers']>[number]['entries'][number] {
  return { category, pathCategory, bytes, reclaimability, ...(sizeTruncated ? { sizeTruncated: true } : {}) };
}
