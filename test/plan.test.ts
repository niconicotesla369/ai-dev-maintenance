import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import { applyMaintenancePlan, createMaintenancePlan } from '../src/plan.js';

describe('plan/apply privacy and safety', () => {
  test('plan codex-fix --json omits raw identity while private plan stores it', async () => {
    const home = await makeHome();
    try {
      const codexDir = path.join(home, '.codex');
      await mkdir(codexDir, { mode: 0o700 });
      await writeFile(path.join(codexDir, 'logs_2.sqlite'), 'sqlite', { mode: 0o600 });

      const result = await runCli(['plan', 'codex-fix', '--json'], {
        env: { ...process.env, HOME: home },
        io: { isInputTty: false, isOutputTty: false }
      });

      expect(result.exitCode).toBe(0);
      const outputText = result.output;
      expect(outputText).not.toContain(home);
      expect(outputText).not.toContain('"targetIdentity"');
      expect(outputText).not.toContain('"dev"');
      expect(outputText).not.toContain('"ino"');
      expect(outputText).not.toContain('"uid"');
      expect(outputText).not.toContain('"gid"');
      expect(outputText).not.toContain('"mode"');
      const output = JSON.parse(outputText);
      expect(output).toMatchObject({
        action: 'codex-fix',
        status: 'ready',
        planId: expect.stringMatching(/^plan-/),
        identityHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      });

      const planText = await readOnlyPlanFile(home, output.planId);
      expect(planText).toContain('"targetIdentity"');
      expect(planText).toContain('"dev"');
      expect(planText).toContain('"identityHash"');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('apply requires --yes before reading a plan', async () => {
    const result = await runCli(['apply', '--plan', 'plan-test']);

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Missing required confirmation: --yes');
  });

  test('apply blocks expired plans without running the cleanup engine', async () => {
    const home = await makeHome();
    let cleanupCalls = 0;
    try {
      await makeCursorCache(home, 'cache');
      const created = await createMaintenancePlan({
        action: 'cursor-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'expired'
      });

      const result = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:16:00.000Z'),
        runCursorSafeCleanup: async () => {
          cleanupCalls += 1;
          throw new Error('cleanup must not run');
        }
      });

      expect(result.status).toBe('blocked');
      expect(result.blockedReasons).toContain('plan expired');
      expect(cleanupCalls).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('apply blocks replay after a successful apply', async () => {
    const home = await makeHome();
    try {
      await makeCursorCache(home, 'cache');
      const created = await createMaintenancePlan({
        action: 'cursor-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'replay'
      });

      const first = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        runCursorSafeCleanup: async () => cursorCleanupResult('ok')
      });
      const second = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:02:00.000Z'),
        runCursorSafeCleanup: async () => {
          throw new Error('cleanup must not run twice');
        }
      });

      expect(first.status).toBe('ok');
      expect(JSON.stringify(first)).not.toContain('/private/path/not/exposed');
      expect(JSON.stringify(first)).not.toContain('"path"');
      expect(second.status).toBe('blocked');
      expect(second.blockedReasons).toContain('plan was already applied');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('apply blocks an unknown persisted action before running an engine', async () => {
    const home = await makeHome();
    let cleanupCalls = 0;
    try {
      await makeCursorCache(home, 'cache');
      const created = await createMaintenancePlan({
        action: 'cursor-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'badaction'
      });
      await mutatePrivatePlan(home, created.planId, (plan) => {
        plan.action = 'totally-invalid';
      });

      const result = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        runCursorSafeCleanup: async () => {
          cleanupCalls += 1;
          throw new Error('cleanup must not run');
        }
      });

      expect(result.status).toBe('blocked');
      expect(result.blockedReasons).toContain('unknown plan action');
      expect(cleanupCalls).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('apply blocks an invalid persisted expiry before running an engine', async () => {
    const home = await makeHome();
    let cleanupCalls = 0;
    try {
      await makeCursorCache(home, 'cache');
      const created = await createMaintenancePlan({
        action: 'cursor-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'badexpiry'
      });
      await mutatePrivatePlan(home, created.planId, (plan) => {
        plan.expiresAt = 'not-a-date';
      });

      const result = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        runCursorSafeCleanup: async () => {
          cleanupCalls += 1;
          throw new Error('cleanup must not run');
        }
      });

      expect(result.status).toBe('blocked');
      expect(result.blockedReasons).toContain('invalid plan expiry');
      expect(cleanupCalls).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('creating a plan prunes expired private plan files', async () => {
    const home = await makeHome();
    try {
      await makeCursorCache(home, 'cache');
      await writeSyntheticPlan(home, 'plan-2026-07-02T00-00-00-000Z-old');
      await writeSyntheticPlan(home, 'plan-2026-07-02T00-01-00-000Z-oldapplied', '.applied');

      const created = await createMaintenancePlan({
        action: 'cursor-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'current'
      });

      const entries = await listPlanEntries(home);
      expect(entries).toContain(`${created.planId}.json`);
      expect(entries).not.toContain('plan-2026-07-02T00-00-00-000Z-old.json');
      expect(entries).not.toContain('plan-2026-07-02T00-01-00-000Z-oldapplied.json.applied');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('creating a plan keeps only the newest ten private plan files', async () => {
    const home = await makeHome();
    try {
      await makeCursorCache(home, 'cache');
      for (let index = 0; index < 12; index += 1) {
        await writeSyntheticPlan(home, `plan-2026-07-04T00-${String(index).padStart(2, '0')}-00-000Z-recent${index}`);
      }

      const created = await createMaintenancePlan({
        action: 'cursor-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:20:00.000Z'),
        randomSuffix: () => 'newest'
      });

      const entries = await listPlanEntries(home);
      expect(entries).toContain(`${created.planId}.json`);
      expect(entries).toHaveLength(10);
      expect(entries).not.toContain('plan-2026-07-04T00-00-00-000Z-recent0.json');
      expect(entries).not.toContain('plan-2026-07-04T00-01-00-000Z-recent1.json');
      expect(entries).not.toContain('plan-2026-07-04T00-02-00-000Z-recent2.json');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('apply treats a successful codex fix report as applied', async () => {
    const home = await makeHome();
    try {
      const codexDir = path.join(home, '.codex');
      await mkdir(codexDir, { mode: 0o700 });
      await writeFile(path.join(codexDir, 'logs_2.sqlite'), 'sqlite', { mode: 0o600 });
      const created = await createMaintenancePlan({
        action: 'codex-fix',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'codex'
      });

      const result = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        runFixSafe: async () => ({
          report: {
            schemaVersion: 1,
            toolVersion: '0.4.0-beta.1',
            generatedAt: '2026-07-04T00:01:00.000Z',
            command: 'fix --safe',
            status: 'ok',
            redacted: true,
            target: {
              kind: 'default-codex-log-db',
              pathCategory: '<home>/.codex/logs_2.sqlite'
            },
            findings: {},
            metrics: {},
            blockedReasons: []
          }
        })
      });

      expect(result.status).toBe('ok');
      expect(result.applied).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('apply blocks identity drift before running the cleanup engine', async () => {
    const home = await makeHome();
    let cleanupCalls = 0;
    try {
      const cacheFile = await makeCursorCache(home, 'before');
      const created = await createMaintenancePlan({
        action: 'cursor-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'drift'
      });
      await writeFile(cacheFile, 'after');

      const result = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        runCursorSafeCleanup: async () => {
          cleanupCalls += 1;
          throw new Error('cleanup must not run');
        }
      });

      expect(result.status).toBe('blocked');
      expect(result.blockedReasons).toContain('plan identity drifted');
      expect(cleanupCalls).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-plan-home-'));
  await chmod(home, 0o700);
  return home;
}

async function makeCursorCache(home: string, content: string): Promise<string> {
  const cacheDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'Cache');
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(path.join(home, 'Library'), 0o700);
  await chmod(path.join(home, 'Library', 'Application Support'), 0o700);
  await chmod(path.join(home, 'Library', 'Application Support', 'Cursor'), 0o700);
  await chmod(cacheDir, 0o700);
  const file = path.join(cacheDir, 'cache.bin');
  await writeFile(file, content, { mode: 0o600 });
  return file;
}

async function readOnlyPlanFile(home: string, planId: string): Promise<string> {
  const planDir = path.dirname(privatePlanPath(home, planId));
  const entries = await readdir(planDir);
  expect(entries).toContain(`${planId}.json`);
  return await readFile(privatePlanPath(home, planId), 'utf8');
}

async function mutatePrivatePlan(
  home: string,
  planId: string,
  mutate: (plan: Record<string, unknown>) => void
): Promise<void> {
  const file = privatePlanPath(home, planId);
  const plan = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  mutate(plan);
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
}

function privatePlanPath(home: string, planId: string): string {
  return path.join(home, '.ai-dev-maintenance', 'plans', `${planId}.json`);
}

async function writeSyntheticPlan(home: string, planId: string, suffix = ''): Promise<void> {
  const dir = path.join(home, '.ai-dev-maintenance', 'plans');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(path.join(home, '.ai-dev-maintenance'), 0o700);
  await chmod(dir, 0o700);
  await writeFile(path.join(dir, `${planId}.json${suffix}`), '{}\n', { mode: 0o600 });
}

async function listPlanEntries(home: string): Promise<string[]> {
  return (await readdir(path.join(home, '.ai-dev-maintenance', 'plans'))).sort();
}

function cursorCleanupResult(status: 'ok' | 'blocked') {
  return {
    status,
    mode: status === 'ok' ? 'cleanup' as const : 'dry-run' as const,
    reclaimableBytes: 5,
    deletedBytes: status === 'ok' ? 5 : 0,
    deletedEntries: status === 'ok' ? 1 : 0,
    targets: [{
      path: '/private/path/not/exposed',
      pathCategory: '<home>/Library/Application Support/Cursor/Cache',
      bytes: 5,
      note: 'cache data'
    }],
    blockedReasons: status === 'ok' ? [] : ['blocked'],
    warnings: []
  };
}
