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

  test('apply rejects a structurally malformed private plan before dispatch', async () => {
    const home = await makeHome();
    let cleanupCalls = 0;
    try {
      await makeCursorCache(home, 'cache');
      const created = await createMaintenancePlan({
        action: 'cursor-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'malformed'
      });
      await mutatePrivatePlan(home, created.planId, (plan) => {
        plan.status = 'blocked';
        plan.blockedReasons = 'not-an-array';
        plan.warnings = { unexpected: true };
      });

      const result = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        runCursorSafeCleanup: async () => {
          cleanupCalls += 1;
          throw new Error('malformed plan must not dispatch');
        }
      });

      expect(result).toMatchObject({
        status: 'blocked',
        applied: false,
        blockedReasons: ['plan file is unreadable'],
        warnings: []
      });
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
            toolVersion: '0.5.0',
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

  test('plans and applies exact Sparkle targets through injected dependencies', async () => {
    const home = await makeHome();
    const targetPath = path.join(home, 'Library', 'Caches', 'com.openai.codex', 'Installation', 'old');
    let collectCalls = 0;
    let runnerCalls = 0;
    try {
      const dependencies = {
        planCodexSparkleCleanup: async () => {
          collectCalls += 1;
          return syntheticSparklePlan(targetPath);
        },
        runCodexSparkleCleanup: async (options: { expectedTargets: Array<{ path: string }> }) => {
          runnerCalls += 1;
          expect(options.expectedTargets.map((target) => target.path)).toEqual([targetPath]);
          return {
            status: 'partial' as const,
            changed: true,
            deletedBytes: 4096,
            deletedEntries: 1,
            blockedReasons: ['later-target-blocked'],
            warnings: []
          };
        }
      };
      const createdAt = new Date('2026-07-04T00:00:00.000Z');
      const created = await createMaintenancePlan({
        action: 'codex-sparkle-clean',
        env: { ...process.env, HOME: home },
        now: createdAt,
        randomSuffix: () => 'sparkle',
        dependencies
      });

      expect(created.status).toBe('ready');
      expect(Date.parse(created.expiresAt) - createdAt.getTime()).toBe(15 * 60 * 1000);
      expect(created.preview).toMatchObject({ targetCount: 1, reclaimableBytes: 8192 });
      expect(JSON.stringify(created)).not.toContain(targetPath);
      expect(await readOnlyPlanFile(home, created.planId)).toContain(targetPath);

      const applied = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        dependencies
      });
      const replay = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:02:00.000Z'),
        dependencies
      });

      expect(applied).toMatchObject({
        status: 'partial',
        action: 'codex-sparkle-clean',
        applied: true,
        blockedReasons: ['later-target-blocked']
      });
      expect(JSON.stringify(applied)).not.toContain(targetPath);
      expect(replay.blockedReasons).toContain('plan was already applied');
      expect(collectCalls).toBe(2);
      expect(runnerCalls).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('atomically claims a plan before running so concurrent apply cannot replay it', async () => {
    const home = await makeHome();
    const targetPath = path.join(home, 'Library', 'Caches', 'com.openai.codex', 'Installation', 'old');
    let runnerCalls = 0;
    let signalStarted: (() => void) | undefined;
    let releaseRunner: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    try {
      const collector = async () => syntheticSparklePlan(targetPath);
      const dependencies = {
        planCodexSparkleCleanup: collector,
        runCodexSparkleCleanup: async () => {
          runnerCalls += 1;
          if (runnerCalls > 1) {
            return {
              status: 'blocked' as const,
              changed: false,
              deletedBytes: 0,
              deletedEntries: 0,
              blockedReasons: ['concurrent-run-reached'],
              warnings: []
            };
          }
          signalStarted?.();
          await release;
          return {
            status: 'ok' as const,
            changed: true,
            deletedBytes: 8192,
            deletedEntries: 1,
            blockedReasons: [],
            warnings: []
          };
        }
      };
      const created = await createMaintenancePlan({
        action: 'codex-sparkle-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'concurrent',
        dependencies
      });

      const firstApply = applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        dependencies
      });
      await started;
      const secondApply = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:01.000Z'),
        dependencies
      });
      releaseRunner?.();
      const firstResult = await firstApply;

      expect(firstResult).toMatchObject({ status: 'ok', applied: true });
      expect(secondApply).toMatchObject({
        status: 'blocked',
        applied: false,
        blockedReasons: ['plan apply is already in progress']
      });
      expect(runnerCalls).toBe(1);
    } finally {
      releaseRunner?.();
      await rm(home, { recursive: true, force: true });
    }
  });

  test('keeps a non-mutating partial plan available and rejects mismatched image consent', async () => {
    const home = await makeHome();
    const targetPath = path.join(home, 'Library', 'Caches', 'com.openai.codex', 'Installation', 'old');
    let runnerCalls = 0;
    try {
      const collector = async () => syntheticSparklePlan(targetPath);
      const created = await createMaintenancePlan({
        action: 'codex-sparkle-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'sparkleretry',
        dependencies: { planCodexSparkleCleanup: collector }
      });

      const mismatch = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        confirmations: { imageLoss: true },
        dependencies: {
          planCodexSparkleCleanup: collector,
          runCodexSparkleCleanup: async () => {
            runnerCalls += 1;
            throw new Error('mismatched confirmation must block before the runner');
          }
        }
      });
      const nonMutating = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:02:00.000Z'),
        confirmations: { imageLoss: false },
        dependencies: {
          planCodexSparkleCleanup: collector,
          runCodexSparkleCleanup: async () => {
            runnerCalls += 1;
            return {
              status: 'partial' as const,
              changed: false,
              deletedBytes: 0,
              deletedEntries: 0,
              blockedReasons: ['preflight-blocked'],
              warnings: []
            };
          }
        }
      });
      const retry = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:03:00.000Z'),
        confirmations: { imageLoss: false },
        dependencies: {
          planCodexSparkleCleanup: collector,
          runCodexSparkleCleanup: async () => {
            runnerCalls += 1;
            return {
              status: 'ok' as const,
              changed: true,
              deletedBytes: 8192,
              deletedEntries: 1,
              blockedReasons: [],
              warnings: []
            };
          }
        }
      });

      expect(mismatch).toMatchObject({
        status: 'blocked',
        applied: false,
        blockedReasons: ['image loss confirmation does not match plan action']
      });
      expect(nonMutating).toMatchObject({
        status: 'blocked',
        applied: false,
        blockedReasons: ['preflight-blocked']
      });
      expect(retry).toMatchObject({ status: 'ok', applied: true });
      expect(runnerCalls).toBe(2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('redacts absolute paths from public plan and apply reasons and warnings', async () => {
    const home = await makeHome();
    const targetPath = path.join(home, 'Library', 'Caches', 'com.openai.codex', 'Installation', 'old');
    try {
      const collector = async () => ({
        ...syntheticSparklePlan(targetPath),
        warnings: [`review private target ${targetPath}`]
      });
      const created = await createMaintenancePlan({
        action: 'codex-sparkle-clean',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'redaction',
        dependencies: { planCodexSparkleCleanup: collector }
      });
      const applied = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        dependencies: {
          planCodexSparkleCleanup: collector,
          runCodexSparkleCleanup: async () => ({
            status: 'blocked' as const,
            changed: false,
            deletedBytes: 0,
            deletedEntries: 0,
            blockedReasons: [`failed to inspect ${targetPath}`],
            warnings: [`retry after reviewing ${targetPath}`]
          })
        }
      });

      expect(JSON.stringify(created)).not.toContain(home);
      expect(JSON.stringify(applied)).not.toContain(home);
      expect(created.warnings.join('\n')).toContain('<absolute-path>');
      expect(applied.blockedReasons.join('\n')).toContain('<absolute-path>');
      expect(applied.warnings.join('\n')).toContain('<absolute-path>');
      expect(await readOnlyPlanFile(home, created.planId)).toContain(targetPath);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('keeps a safe image subset private and requires matching image-loss consent', async () => {
    const home = await makeHome();
    const candidatePath = path.join(home, '.codex', 'sessions', '2026', '06', 'safe.jsonl');
    const excludedPath = path.join(home, '.codex', 'sessions', '2026', '06', 'blocked.jsonl');
    let runnerCalls = 0;
    try {
      const scan = async () => syntheticImageScan(candidatePath, excludedPath);
      const createdAt = new Date('2026-07-04T00:00:00.000Z');
      const created = await createMaintenancePlan({
        action: 'codex-session-image-prune',
        actionOptions: { olderThanDays: 45, minFileSizeBytes: 1024 },
        env: { ...process.env, HOME: home },
        now: createdAt,
        randomSuffix: () => 'images',
        dependencies: { scanCodexSessionImages: scan }
      });

      expect(created).toMatchObject({
        status: 'ready',
        blockedReasons: [],
        preview: {
          targetCount: 1,
          reclaimableBytes: 3072,
          imagesPrunable: 3,
          filesBlocked: 1,
          sourceBytes: 4096,
          projectedBytes: 1024,
          contentRead: true,
          irreversible: true
        }
      });
      expect(created.warnings).toContain('image-scan-partial-safe-subset');
      expect(Date.parse(created.expiresAt) - createdAt.getTime()).toBe(60 * 60 * 1000);
      expect(JSON.stringify(created)).not.toContain(home);
      const privatePlan = await readOnlyPlanFile(home, created.planId);
      expect(privatePlan).toContain(candidatePath);
      expect(privatePlan).toContain(excludedPath);
      expect(privatePlan).toContain('invalid-json');

      const withoutConsent = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:10:00.000Z'),
        confirmations: { imageLoss: false },
        dependencies: {
          scanCodexSessionImages: scan,
          pruneCodexSessionImages: async () => {
            runnerCalls += 1;
            throw new Error('image runner must not run without consent');
          }
        }
      });
      const applied = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:11:00.000Z'),
        confirmations: { imageLoss: true },
        dependencies: {
          scanCodexSessionImages: scan,
          pruneCodexSessionImages: async (options: {
            candidates: Array<{ path: string }>;
            excludedOutcomes: Array<{ path: string }>;
          }) => {
            runnerCalls += 1;
            expect(options.candidates.map((candidate) => candidate.path)).toEqual([candidatePath]);
            expect(options.excludedOutcomes.map((outcome) => outcome.path)).toEqual([excludedPath]);
            return {
              status: 'ok' as const,
              changed: true,
              filesSucceeded: 1,
              filesSkipped: 0,
              filesFailed: 0,
              imagesStripped: 3,
              sourceBytes: 4096,
              resultBytes: 1024,
              reclaimedBytes: 3072,
              manifestPathCategory: '<home>/.ai-dev-maintenance/manifests/<manifest-file>',
              blockedReasons: [],
              warnings: []
            };
          }
        }
      });

      expect(withoutConsent).toMatchObject({
        status: 'blocked',
        applied: false,
        blockedReasons: ['image loss confirmation required']
      });
      expect(applied).toMatchObject({
        status: 'ok',
        action: 'codex-session-image-prune',
        applied: true
      });
      expect(JSON.stringify(applied)).not.toContain(home);
      expect(runnerCalls).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('blocks an image plan when no safe candidate remains', async () => {
    const home = await makeHome();
    let runnerCalls = 0;
    try {
      const blockedPath = path.join(home, '.codex', 'sessions', 'blocked.jsonl');
      const scan = async () => syntheticImageScan(undefined, blockedPath);
      const created = await createMaintenancePlan({
        action: 'codex-session-image-prune',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'noimages',
        dependencies: { scanCodexSessionImages: scan }
      });
      const applied = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        confirmations: { imageLoss: true },
        dependencies: {
          scanCodexSessionImages: scan,
          pruneCodexSessionImages: async () => {
            runnerCalls += 1;
            throw new Error('blocked image plan must not run');
          }
        }
      });

      expect(created.status).toBe('blocked');
      expect(created.blockedReasons).toContain('no-safe-image-candidates');
      expect(created.preview).toMatchObject({ targetCount: 0, filesBlocked: 1 });
      expect(applied.status).toBe('blocked');
      expect(runnerCalls).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('blocks image target drift before the injected prune runner', async () => {
    const home = await makeHome();
    const candidatePath = path.join(home, '.codex', 'sessions', 'old.jsonl');
    let scanCalls = 0;
    let runnerCalls = 0;
    try {
      const scan = async () => {
        scanCalls += 1;
        return syntheticImageScan(candidatePath, undefined, scanCalls === 1 ? 'a' : 'b');
      };
      const created = await createMaintenancePlan({
        action: 'codex-session-image-prune',
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'imagedrift',
        dependencies: { scanCodexSessionImages: scan }
      });
      const result = await applyMaintenancePlan({
        planId: created.planId,
        env: { ...process.env, HOME: home },
        now: new Date('2026-07-04T00:01:00.000Z'),
        confirmations: { imageLoss: true },
        dependencies: {
          scanCodexSessionImages: scan,
          pruneCodexSessionImages: async () => {
            runnerCalls += 1;
            throw new Error('drifted image plan must not run');
          }
        }
      });

      expect(result.status).toBe('blocked');
      expect(result.blockedReasons).toContain('plan identity drifted');
      expect(scanCalls).toBe(2);
      expect(runnerCalls).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('plans and runs monitor install and remove without exposing program or plist paths', async () => {
    const home = await makeHome();
    const env = { ...process.env, HOME: home };
    const nodePath = path.join(home, 'bin', 'node');
    const cliScriptPath = path.join(home, 'app', 'dist', 'cli.js');
    const collectedPaths: string[] = [];
    let installs = 0;
    let removals = 0;
    try {
      const collectFileIdentity = async (filePath: string, pathCategory: string) => {
        collectedPaths.push(filePath);
        return syntheticFileIdentity(filePath, pathCategory);
      };
      const monitorInstallSpec = {
        nodePath,
        cliScriptPath,
        thresholdBytes: 8 * 1024 ** 3,
        growthThresholdBytes: 5 * 1024 ** 3,
        day: 1 as const,
        hour: 4 as const,
        minute: 30 as const
      };
      const installPlan = await createMaintenancePlan({
        action: 'codex-session-monitor-install',
        actionOptions: {
          thresholdBytes: monitorInstallSpec.thresholdBytes,
          growthThresholdBytes: monitorInstallSpec.growthThresholdBytes
        },
        monitorInstallSpec,
        env,
        now: new Date('2026-07-04T00:00:00.000Z'),
        randomSuffix: () => 'monitorinstall',
        dependencies: { collectFileIdentity }
      });

      expect(installPlan).toMatchObject({
        status: 'ready',
        preview: {
          targetCount: 1,
          thresholdBytes: 8 * 1024 ** 3,
          growthThresholdBytes: 5 * 1024 ** 3
        }
      });
      expect(Date.parse(installPlan.expiresAt) - Date.parse(installPlan.createdAt)).toBe(15 * 60 * 1000);
      expect(JSON.stringify(installPlan)).not.toContain(home);
      expect(await readOnlyPlanFile(home, installPlan.planId)).toContain(cliScriptPath);

      const installed = await applyMaintenancePlan({
        planId: installPlan.planId,
        env,
        now: new Date('2026-07-04T00:01:00.000Z'),
        dependencies: {
          collectFileIdentity,
          installCodexMonitor: async (spec: typeof monitorInstallSpec) => {
            installs += 1;
            expect(spec).toEqual(monitorInstallSpec);
            return { status: 'ok' as const, changed: true, blockedReasons: [], warnings: [] };
          }
        }
      });

      const removePlan = await createMaintenancePlan({
        action: 'codex-session-monitor-remove',
        env,
        now: new Date('2026-07-04T01:00:00.000Z'),
        randomSuffix: () => 'monitorremove',
        dependencies: { collectFileIdentity }
      });
      const removed = await applyMaintenancePlan({
        planId: removePlan.planId,
        env,
        now: new Date('2026-07-04T01:01:00.000Z'),
        dependencies: {
          collectFileIdentity,
          removeCodexMonitor: async () => {
            removals += 1;
            return { status: 'ok' as const, changed: true, blockedReasons: [], warnings: [] };
          }
        }
      });

      expect(removePlan.preview.targetCount).toBe(1);
      expect(JSON.stringify(removePlan)).not.toContain(home);
      expect(installed).toMatchObject({ status: 'ok', action: 'codex-session-monitor-install', applied: true });
      expect(removed).toMatchObject({ status: 'ok', action: 'codex-session-monitor-remove', applied: true });
      expect(JSON.stringify([installed, removed])).not.toContain(home);
      expect(collectedPaths).toContain(nodePath);
      expect(collectedPaths).toContain(cliScriptPath);
      expect(installs).toBe(1);
      expect(removals).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('extends the public plan/apply schemas additively for every new action', async () => {
    type PublicSchema = {
      properties: {
        action: { enum: string[] };
        status?: { enum: string[] };
        preview?: { properties: Record<string, { type: string }> };
      };
    };
    const planSchema = JSON.parse(
      await readFile('schemas/plan-summary.v1.schema.json', 'utf8')
    ) as PublicSchema;
    const applySchema = JSON.parse(
      await readFile('schemas/apply-result.v1.schema.json', 'utf8')
    ) as PublicSchema;
    const actions = [
      'codex-fix',
      'cursor-clean',
      'codex-sparkle-clean',
      'codex-session-image-prune',
      'codex-session-monitor-install',
      'codex-session-monitor-remove'
    ];

    expect(planSchema.properties.action.enum).toEqual(actions);
    expect(applySchema.properties.action.enum).toEqual(actions);
    expect(applySchema.properties.status?.enum).toEqual(['ok', 'partial', 'blocked']);
    expect(Object.keys(planSchema.properties.preview?.properties ?? {}).sort()).toEqual([
      'contentRead',
      'filesBlocked',
      'growthThresholdBytes',
      'imagesPrunable',
      'irreversible',
      'projectedBytes',
      'reclaimableBytes',
      'sourceBytes',
      'targetCount',
      'thresholdBytes',
      'walBytes'
    ]);
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

function syntheticSparklePlan(targetPath: string) {
  return {
    status: 'ready' as const,
    reclaimableBytes: 8192,
    targets: [{
      path: targetPath,
      pathCategory: '<home>/Library/Caches/com.openai.codex/Installation/<item>',
      bytes: 8192,
      identity: { version: 1, marker: 'stable' }
    }],
    blockedReasons: [],
    warnings: []
  };
}

function syntheticImageScan(
  candidatePath: string | undefined,
  excludedPath: string | undefined,
  hashCharacter = 'a'
) {
  const candidates = candidatePath ? [{
    path: candidatePath,
    pathCategory: '<home>/.codex/sessions/<session-file>',
    sourceBytes: 4096,
    projectedBytes: 1024,
    occurrencesSeen: 3,
    imagesPrunable: 3,
    knownPlaceholders: 0,
    belowMinimum: 0,
    lines: 1,
    sourceSha256: hashCharacter.repeat(64),
    identity: syntheticFileIdentity(
      candidatePath,
      '<home>/.codex/sessions/<session-file>'
    )
  }] : [];
  const privateOutcomes = excludedPath ? [{
    path: excludedPath,
    pathCategory: '<home>/.codex/sessions/<session-file>',
    status: 'blocked' as const,
    code: 'invalid-json' as const
  }] : [];
  return {
    status: privateOutcomes.length > 0 ? 'partial' as const : 'ok' as const,
    contentRead: true as const,
    candidates,
    privateOutcomes,
    totals: {
      filesConsidered: candidates.length + privateOutcomes.length,
      filesOpened: candidates.length + privateOutcomes.length,
      filesSkippedBySize: 0,
      filesSkippedAfterRead: 0,
      filesBlocked: privateOutcomes.length,
      sourceBytes: candidates.length > 0 ? 4096 : 0,
      projectedBytes: candidates.length > 0 ? 1024 : 0,
      reclaimableBytes: candidates.length > 0 ? 3072 : 0,
      occurrencesSeen: candidates.length > 0 ? 3 : 0,
      imagesPrunable: candidates.length > 0 ? 3 : 0,
      knownPlaceholders: 0,
      belowMinimum: 0
    },
    blockedReasons: privateOutcomes.length > 0 ? ['invalid-json'] : [],
    warnings: []
  };
}

function syntheticFileIdentity(filePath: string, pathCategory: string) {
  return {
    pathCategory,
    realpath: filePath,
    dev: 1,
    ino: filePath.length,
    mode: 0o100500,
    uid: process.getuid?.() ?? 501,
    gid: process.getgid?.() ?? 20,
    size: 1024,
    mtimeMs: 1,
    nlink: 1,
    exists: true,
    regularFile: true,
    symbolicLink: false
  };
}
