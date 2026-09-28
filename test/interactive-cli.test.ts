import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { ApplyPlanResult, MaintenancePlanSummary } from '../src/plan.js';
import type { ReclaimAction, ReclaimMeasurer, ReclaimRunRecord } from '../src/reclaim-run.js';
import type { MaintenanceReport } from '../src/types.js';

// A home that cannot exist, so a missed stub can never reach the real HOME.
const ENV = { HOME: '/nonexistent/aidm-interactive-test-home' };
const SAVED_PATH = '<home>/.ai-dev-maintenance/reclaim-runs/reclaim-run-test.json';

type Harness = {
  doctorReports?: MaintenanceReport[];
  plans?: Partial<Record<ReclaimAction, Partial<MaintenancePlanSummary>>>;
  apply?: Partial<Record<ReclaimAction, ApplyPlanResult | Error>>;
  targetBytes?: Partial<Record<ReclaimAction, Array<number | null>>>;
  appDataBytes?: Array<number | null>;
  volumeBytes?: Array<number | null>;
  saveError?: Error;
};

function guided(harness: Harness = {}) {
  const calls = { doctor: [] as Array<boolean | undefined>, plans: [] as ReclaimAction[], applied: [] as ReclaimAction[] };
  const records: ReclaimRunRecord[] = [];
  const doctorReports = harness.doctorReports ?? [readyDoctor()];
  const queues = {
    'codex-fix': [...(harness.targetBytes?.['codex-fix'] ?? [0, 0])],
    'cursor-clean': [...(harness.targetBytes?.['cursor-clean'] ?? [0, 0])]
  };
  const appData = [...(harness.appDataBytes ?? [0, 0])];
  const volume = [...(harness.volumeBytes ?? [1_000, 1_000])];
  const measurer: ReclaimMeasurer = {
    targetBytes: async (action) => queues[action].shift() ?? null,
    appDataBytes: async () => appData.shift() ?? null,
    volumeAvailableBytes: async () => volume.shift() ?? null
  };
  const commands = {
    runDoctor: async (options?: { persistReport?: boolean }) => {
      calls.doctor.push(options?.persistReport);
      const report = doctorReports[Math.min(calls.doctor.length - 1, doctorReports.length - 1)];
      return { report, reportPath: '/tmp/report.json' };
    },
    createPlan: async (options: { action: string }) => {
      const action = options.action as ReclaimAction;
      calls.plans.push(action);
      return planSummary(action, harness.plans?.[action]);
    },
    applyPlan: async (options: { planId: string }) => {
      const action = options.planId.replace('plan-test-', '') as ReclaimAction;
      calls.applied.push(action);
      const result = harness.apply?.[action] ?? applyResult(action, 'ok');
      if (result instanceof Error) throw result;
      return result;
    },
    createReclaimMeasurer: () => measurer,
    writeReclaimRunRecord: async (record: ReclaimRunRecord) => {
      if (harness.saveError) throw harness.saveError;
      records.push(record);
      return SAVED_PATH;
    },
    runFixSafe: async () => {
      throw new Error('guided mode must not call fix directly');
    }
  };
  return { commands: commands as never, calls, records };
}

describe('guided reclaim CLI', () => {
  test('shows every candidate with estimate, reason, impact, and protected data before asking', async () => {
    const harness = guided({ plans: { 'cursor-clean': { preview: { targetCount: 3, reclaimableBytes: 620_000 } } } });

    const result = await runCli(['--plain'], { env: ENV, io: memoryIo('n\nn\n', true, 100), commands: harness.commands });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AIDM SAFE RECLAIM');
    expect(result.output).toContain('Always protected:\n  chats, session history, settings, sign-ins, workspace state, code, Git.');
    expect(result.output).toContain('Nothing changes until you approve each item.');
    expect(result.output).toContain('[1] Codex log database WAL  ready');
    expect(result.output).toContain('Estimate      none: 5.0 MiB WAL is folded into the DB, not deleted');
    expect(result.output).toContain('Impact        private backup (~51.7 MiB) kept first; rows kept');
    expect(result.output).toContain('[2] Cursor caches and logs  ready');
    expect(result.output).toContain('Estimate      605.5 KiB in 3 cache/log folders');
    expect(result.output).toContain('Impact        Cursor must be closed; rebuilt on next launch');
    expect(result.output).toContain('Reclaim Codex log database WAL? [y/N]');
    expect(result.output).toContain('Reclaim Cursor caches and logs? [y/N]');
    expect(result.output).toContain('No cleanup was run. Nothing was changed.');
    expect(harness.calls.applied).toEqual([]);
    expect(harness.records).toEqual([]);
  });

  test('applies only approved items, measures before and after, and saves exactly one record', async () => {
    const harness = guided({
      plans: { 'cursor-clean': { preview: { targetCount: 3, reclaimableBytes: 620_000 } } },
      apply: { 'cursor-clean': applyResult('cursor-clean', 'partial', ['some Cursor cleanup entries could not be removed']) },
      targetBytes: { 'cursor-clean': [620_000, 70_000] },
      appDataBytes: [1_000, 1_500],
      volumeBytes: [10_000_000, 10_600_000]
    });

    const result = await runCli([], { env: ENV, io: memoryIo('n\ny\n', true, 100), commands: harness.commands });

    expect(harness.calls.applied).toEqual(['cursor-clean']);
    expect(harness.records).toHaveLength(1);
    const [record] = harness.records;
    expect(record).toMatchObject({
      command: 'reclaim-run',
      status: 'partial',
      units: 'bytes',
      items: [{
        action: 'cursor-clean',
        outcome: 'partial',
        estimateBytes: 620_000,
        target: { beforeBytes: 620_000, afterBytes: 70_000, deltaBytes: -550_000 },
        reasons: ['some Cursor cleanup entries could not be removed']
      }],
      totals: { appliedItems: 1, excludedItems: 0, appliedTargetDeltaBytes: -550_000 },
      managedState: { beforeBytes: 621_000, afterBytes: 71_500, deltaBytes: -549_500 },
      volume: { beforeBytes: 10_000_000, afterBytes: 10_600_000, deltaBytes: 600_000, attributedToAidm: false }
    });
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('[1] Cursor caches and logs  partially done');
    expect(result.output).toContain('Target        605.5 KiB -> 68.4 KiB (-537.1 KiB)');
    expect(result.output).toContain('Volume free: whole volume; not attributed to AIDM.');
    expect(result.output).toContain(`Saved           ${SAVED_PATH}`);
    expect(result.output).toContain('View            aidm report --latest --html');
  });

  test('reports a WAL fold by its measured net change, not by the WAL size', async () => {
    const harness = guided({
      plans: { 'cursor-clean': { preview: { targetCount: 0, reclaimableBytes: 0 } } },
      targetBytes: { 'codex-fix': [8_274_296, 8_220_672] },
      appDataBytes: [0, 8_221_189]
    });

    const result = await runCli([], { env: ENV, io: memoryIo('y\n', true, 100), commands: harness.commands });

    expect(result.exitCode).toBe(0);
    expect(harness.records[0]).toMatchObject({
      status: 'ok',
      items: [{ action: 'codex-fix', outcome: 'ok', estimateBytes: null, estimateNote: 'wal-folds-into-database' }],
      totals: { appliedTargetDeltaBytes: -53_624 },
      managedState: { deltaBytes: 8_167_565 }
    });
    expect(result.output).toMatch(/Target change {3}-52\.4 KiB\s/);
    expect(result.output).toContain('Managed state   7.9 MiB -> 15.7 MiB (+7.8 MiB)');
    expect(result.output).not.toContain('Reclaim Cursor caches and logs?');
  });

  test('never adds blocked or unknown outcomes to the totals', async () => {
    const harness = guided({
      plans: { 'cursor-clean': { preview: { targetCount: 3, reclaimableBytes: 620_000 } } },
      apply: {
        'codex-fix': applyResult('codex-fix', 'blocked', ['target database is open by a process']),
        'cursor-clean': new Error('synthetic engine crash')
      },
      targetBytes: { 'codex-fix': [8_000, 8_000], 'cursor-clean': [620_000, 300_000] }
    });

    const result = await runCli([], { env: ENV, io: memoryIo('y\ny\n', true, 100), commands: harness.commands });

    expect(result.exitCode).toBe(3);
    expect(harness.records[0]).toMatchObject({
      status: 'partial',
      items: [
        { action: 'codex-fix', outcome: 'blocked', target: { deltaBytes: 0 } },
        { action: 'cursor-clean', outcome: 'unknown', target: { deltaBytes: -320_000 } }
      ],
      totals: { appliedItems: 0, excludedItems: 2, appliedTargetDeltaBytes: 0 }
    });
    expect(result.output).toContain('stopped; nothing changed');
    expect(result.output).toContain('result unknown');
    expect(result.output).toContain('apply outcome is unknown: synthetic engine crash');
  });

  test('keeps unmeasurable values as not measurable instead of zero', async () => {
    const harness = guided({
      plans: { 'cursor-clean': { preview: { targetCount: 1, reclaimableBytes: 5_000 } } },
      doctorReports: [doctor({ wal: 0, openHandles: false })],
      targetBytes: { 'cursor-clean': [5_000, null] }
    });

    const result = await runCli([], { env: ENV, io: memoryIo('y\n', true, 100), commands: harness.commands });

    expect(harness.records[0]).toMatchObject({
      items: [{ target: { beforeBytes: 5_000, afterBytes: null, deltaBytes: null } }],
      totals: { appliedTargetDeltaBytes: null },
      managedState: { afterBytes: null, deltaBytes: null }
    });
    expect(result.output).toContain('Target        not measurable');
    expect(result.output).toContain('Target change   not measurable');
  });

  test('pauses a Codex candidate while its database is open and changes nothing', async () => {
    const harness = guided({
      doctorReports: [doctor({ wal: 5_242_880, openHandles: true })],
      plans: { 'cursor-clean': { preview: { targetCount: 0, reclaimableBytes: 0 } } }
    });

    const result = await runCli([], { env: ENV, io: memoryIo('2\n', true, 100), commands: harness.commands });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('[1] Codex log database WAL  paused for safety');
    expect(result.output).toContain('Reason        target database is open by a process');
    expect(result.output).toContain('[2] Cursor caches and logs  nothing to reclaim');
    expect(result.output).toContain('Nothing can be reclaimed right now. Nothing was changed.');
    expect(result.output).toContain('[1] Re-check');
    expect(result.output).toContain('No cleanup was run.');
    expect(harness.calls.applied).toEqual([]);
    expect(harness.records).toEqual([]);
  });

  test('keeps a blocked Cursor plan out of the approval prompts', async () => {
    const harness = guided({
      doctorReports: [doctor({ wal: 0, openHandles: false })],
      plans: {
        'cursor-clean': {
          status: 'blocked',
          preview: { targetCount: 1, reclaimableBytes: 5_000 },
          blockedReasons: ['unsafe Cursor cleanup target: symbolic link']
        }
      }
    });

    const result = await runCli([], { env: ENV, io: memoryIo('2\n', true, 100), commands: harness.commands });

    expect(result.output).toContain('Reason        unsafe Cursor cleanup target: symbolic link');
    expect(result.output).not.toContain('Reclaim Cursor caches and logs?');
    expect(harness.calls.applied).toEqual([]);
  });

  test('reports a record that could not be saved instead of hiding it', async () => {
    const harness = guided({
      plans: { 'cursor-clean': { preview: { targetCount: 0, reclaimableBytes: 0 } } },
      targetBytes: { 'codex-fix': [10, 5] },
      saveError: new Error('disk full')
    });

    const result = await runCli([], { env: ENV, io: memoryIo('y\n', true, 100), commands: harness.commands });

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('Result record could not be saved: disk full');
    expect(result.output).not.toContain('aidm report --latest --html');
  });

  test('wait mode polls until the database is released, then asks for approval', async () => {
    const harness = guided({
      doctorReports: [doctor({ wal: 5_242_880, openHandles: true }), readyDoctor()],
      plans: { 'cursor-clean': { preview: { targetCount: 0, reclaimableBytes: 0 } } },
      targetBytes: { 'codex-fix': [10, 5] }
    });

    const result = await runCli(['--wait', '--wait-timeout', '1'], {
      env: ENV,
      io: memoryIo('y\n', true, 100),
      sleep: async () => undefined,
      now: ticker(),
      commands: harness.commands
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Waiting for Codex to release its log database. AIDM will not force close Codex.');
    expect(result.output).toContain('Database released.');
    expect(harness.calls.doctor[0]).not.toBe(false);
    expect(harness.calls.doctor).toContain(false);
    expect(harness.calls.applied).toEqual(['codex-fix']);
  });

  test('wait timeout offers a safe exit without applying anything', async () => {
    const harness = guided({
      doctorReports: [doctor({ wal: 5_242_880, openHandles: true })],
      plans: { 'cursor-clean': { preview: { targetCount: 0, reclaimableBytes: 0 } } }
    });

    const result = await runCli(['--wait', '--wait-timeout', '0.01'], {
      env: ENV,
      io: memoryIo('2\n', true),
      sleep: async () => undefined,
      now: ticker(),
      commands: harness.commands
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Wait timed out. Nothing was changed.');
    expect(result.output).toContain('[2] Quit');
    expect(result.output).toContain('No cleanup was run.');
    expect(harness.calls.applied).toEqual([]);
  });

  test('no-banner suppresses the banner without disabling interaction', async () => {
    const harness = guided();

    const result = await runCli(['--no-banner'], { env: ENV, io: memoryIo('n\nn\n', true, 100), commands: harness.commands });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('AAAAA   III  DDDD');
    expect(result.output).toContain('Reclaim Codex log database WAL? [y/N]');
  });

  test('plain mode prints the banner and sections without ANSI color or boxes', async () => {
    const harness = guided();

    const result = await runCli(['--plain'], { env: ENV, io: memoryIo('n\nn\n', true, 100), commands: harness.commands });

    expect(result.output).toContain('AAAAA   III  DDDD');
    expect(result.output).not.toContain('\u001b[');
    expect(result.output).toContain('AIDM SAFE RECLAIM\n');
    expect(result.output).toContain('WHAT CAN BE RECLAIMED\n');
  });
});

describe('non-guided entry points', () => {
  test('no-arg non-TTY use falls back to static doctor output', async () => {
    const harness = guided();

    const result = await runCli([], { env: ENV, io: memoryIo('', false), commands: harness.commands });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Fix readiness   ready');
    expect(result.output).not.toContain('Reclaim ');
    expect(harness.calls.plans).toEqual([]);
  });

  test('no-interactive flag keeps no-arg TTY use on static doctor output', async () => {
    const harness = guided();

    const result = await runCli(['--no-interactive'], { env: ENV, io: memoryIo('y\n', true), commands: harness.commands });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Fix readiness   ready');
    expect(harness.calls.plans).toEqual([]);
  });

  test('logo command is display-only and does not diagnose or plan', async () => {
    const harness = guided();

    const result = await runCli(['logo'], { env: ENV, io: memoryIo('', true, 100), commands: harness.commands });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('AAAAA   III  DDDD');
    expect(result.output).toContain('AI Dev Maintenance');
    expect(harness.calls.doctor).toEqual([]);
    expect(harness.calls.plans).toEqual([]);
  });

  test('leading plain flag still routes to logo without diagnosing', async () => {
    const harness = guided();

    const result = await runCli(['--plain', 'logo'], { env: ENV, io: memoryIo('', true, 100), commands: harness.commands });

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('\u001b[');
    expect(harness.calls.doctor).toEqual([]);
  });

  test('json output never enters guided mode', async () => {
    const harness = guided();

    const result = await runCli(['doctor', '--json'], { env: ENV, io: memoryIo('y\n', true), commands: harness.commands });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/^\{/);
    expect(harness.calls.plans).toEqual([]);
  });
});

function memoryIo(input: string, isTty: boolean, columns = 80) {
  return { input, isInputTty: isTty, isOutputTty: isTty, columns };
}

function ticker(): () => number {
  let tick = 0;
  return () => tick++ * 1_000;
}

function readyDoctor(): MaintenanceReport {
  return doctor({ wal: 5_242_880, openHandles: false });
}

function doctor(state: { wal: number; openHandles: boolean }): MaintenanceReport {
  return {
    schemaVersion: 1,
    toolVersion: '0.6.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    command: 'doctor',
    status: 'ok',
    redacted: true,
    target: { kind: 'default-codex-log-db', pathCategory: '<home>/.codex/logs_2.sqlite' },
    findings: {
      targetState: { main: { size: 48_930_816 }, wal: { size: state.wal }, shm: { size: 32_768 } },
      openHandles: { usable: true, openHandles: state.openHandles },
      knownCodexProcessExists: false
    },
    metrics: {},
    blockedReasons: []
  };
}

function planSummary(action: ReclaimAction, overrides: Partial<MaintenancePlanSummary> = {}): MaintenancePlanSummary {
  return {
    schemaVersion: 1,
    toolVersion: '0.6.0',
    planId: `plan-test-${action}`,
    action,
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:15:00.000Z',
    identityHash: 'hash',
    preview: action === 'codex-fix' ? { walBytes: 5_242_880 } : { targetCount: 1, reclaimableBytes: 1_000 },
    blockedReasons: [],
    warnings: [],
    ...overrides
  };
}

function applyResult(action: ReclaimAction, status: ApplyPlanResult['status'], blockedReasons: string[] = []): ApplyPlanResult {
  return {
    status,
    planId: `plan-test-${action}`,
    action,
    applied: status !== 'blocked',
    blockedReasons,
    warnings: []
  };
}
