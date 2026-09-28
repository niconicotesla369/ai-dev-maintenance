import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';

const privatePath = (...segments: string[]) => ['', 'Users', 'example', ...segments].join('/');

const schemaCases = [
  {
    schemaPath: 'schemas/codex-report.v1.schema.json',
    fixturePath: 'test/fixtures/wire/codex-report-v1.json'
  },
  {
    schemaPath: 'schemas/doctor-report.v2.schema.json',
    fixturePath: 'test/fixtures/wire/doctor-json.json'
  },
  {
    schemaPath: 'schemas/pressure-report.v2.schema.json',
    fixturePath: 'test/fixtures/wire/pressure-json.json'
  },
  {
    schemaPath: 'schemas/report-latest.v1.schema.json',
    fixturePath: 'test/fixtures/wire/report-latest-json.json'
  },
  {
    schemaPath: 'schemas/cursor-clean-result.v1.schema.json',
    fixturePath: 'test/fixtures/wire/cursor-clean-result.json'
  },
  {
    schemaPath: 'schemas/prune-result.v1.schema.json',
    fixturePath: 'test/fixtures/wire/prune-result.json'
  },
  {
    schemaPath: 'schemas/restore-validate-result.v1.schema.json',
    fixturePath: 'test/fixtures/wire/restore-validate-result.json'
  },
  {
    schemaPath: 'schemas/history-report.v1.schema.json',
    fixturePath: 'test/fixtures/wire/history-json.json'
  },
  {
    schemaPath: 'schemas/plan-summary.v1.schema.json',
    fixturePath: 'test/fixtures/wire/plan-summary.json'
  },
  {
    schemaPath: 'schemas/apply-result.v1.schema.json',
    fixturePath: 'test/fixtures/wire/apply-result.json'
  },
  {
    schemaPath: 'schemas/trust-report.v1.schema.json',
    fixturePath: 'test/fixtures/wire/trust-json.json'
  },
  {
    schemaPath: 'schemas/reclaim-run.v1.schema.json',
    fixturePath: 'test/fixtures/wire/reclaim-run.json'
  },
  {
    schemaPath: 'schemas/cli-error.v1.schema.json',
    fixturePath: 'test/fixtures/wire/cli-error.json'
  }
] as const;

describe('published JSON schema contracts', () => {
  for (const { schemaPath, fixturePath } of schemaCases) {
    test(`${fixturePath} validates against ${schemaPath}`, async () => {
      const validate = await validatorFor(schemaPath);
      const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

      expect(validate(fixture), JSON.stringify(validate.errors, null, 2)).toBe(true);
    });
  }

  test('live plan/apply JSON output validates against the published schemas', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-schema-live-home-'));
    try {
      const cacheDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'Cache');
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await chmod(home, 0o700);
      await chmod(path.join(home, 'Library'), 0o700);
      await chmod(path.join(home, 'Library', 'Application Support'), 0o700);
      await chmod(path.join(home, 'Library', 'Application Support', 'Cursor'), 0o700);
      await chmod(cacheDir, 0o700);
      await writeFile(path.join(cacheDir, 'cache.bin'), 'cache', { mode: 0o600 });

      const planResult = await runCli(['plan', 'cursor-clean', '--json'], {
        env: { ...process.env, HOME: home },
        io: { isInputTty: false, isOutputTty: false }
      });
      expect(planResult.exitCode).toBe(0);
      const planOutput = JSON.parse(planResult.output);
      const validatePlan = await validatorFor('schemas/plan-summary.v1.schema.json');
      expect(validatePlan(planOutput), JSON.stringify(validatePlan.errors, null, 2)).toBe(true);

      const applyResult = await runCli(['apply', '--plan', planOutput.planId, '--yes', '--json'], {
        env: { ...process.env, HOME: home },
        io: { isInputTty: false, isOutputTty: false }
      });
      const applyOutput = JSON.parse(applyResult.output);
      const validateApply = await validatorFor('schemas/apply-result.v1.schema.json');
      expect(validateApply(applyOutput), JSON.stringify(validateApply.errors, null, 2)).toBe(true);
      expect(JSON.stringify(applyOutput)).not.toContain(home);
      expect(JSON.stringify(applyOutput)).not.toContain('"path"');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 20_000);

  test('standalone public result schemas validate representative redacted outputs', async () => {
    const cases = [
      {
        schemaPath: 'schemas/reclaim-scan-result.v1.schema.json',
        value: {
          schemaVersion: 1,
          toolVersion: '0.6.0',
          command: 'reclaim scan codex-session-images',
          status: 'ok',
          contentRead: true,
          filters: { olderThanDays: 30, minFileSizeBytes: 52_428_800 },
          totals: {
            filesConsidered: 3,
            filesOpened: 2,
            filesSkippedBySize: 1,
            filesSkippedAfterRead: 0,
            filesBlocked: 0,
            sourceBytes: 104_857_600,
            projectedBytes: 20_971_520,
            reclaimableBytes: 83_886_080,
            occurrencesSeen: 4,
            imagesPrunable: 3,
            knownPlaceholders: 1,
            belowMinimum: 0,
            candidateFiles: 2
          },
          blockedReasons: [],
          warnings: ['size-filtered-estimate-is-lower-bound']
        }
      },
      {
        schemaPath: 'schemas/native-compression-status.v1.schema.json',
        value: {
          schemaVersion: 1,
          toolVersion: '0.6.0',
          command: 'reclaim status codex-native-compression',
          status: 'partial',
          supported: false,
          configuredState: 'unknown',
          plainJsonlFiles: 4,
          compressedJsonlFiles: 1,
          warnings: ['native-feature-check-unavailable'],
          nextActions: ['Retry after verifying the bundled Codex executable.']
        }
      },
      {
        schemaPath: 'schemas/codex-session-monitor-result.v1.schema.json',
        value: {
          schemaVersion: 1,
          toolVersion: '0.6.0',
          command: 'monitor codex-sessions',
          status: 'blocked',
          currentBytes: 0,
          thresholdBytes: 8_589_934_592,
          growthThresholdBytes: 5_368_709_120,
          alert: false,
          statePersisted: false,
          notificationAttempted: false,
          warnings: ['session-root-untrusted']
        }
      }
    ] as const;

    for (const { schemaPath, value } of cases) {
      const validate = await validatorFor(schemaPath);
      expect(validate(value), `${schemaPath}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }
  });

  test('standalone public result schemas reject private and unexpected output fields', async () => {
    const scan = {
      schemaVersion: 1,
      toolVersion: '0.6.0',
      command: 'reclaim scan codex-session-images',
      status: 'blocked',
      contentRead: true,
      filters: { olderThanDays: 30, minFileSizeBytes: 52_428_800 },
      totals: {
        filesConsidered: 0,
        filesOpened: 0,
        filesSkippedBySize: 0,
        filesSkippedAfterRead: 0,
        filesBlocked: 0,
        sourceBytes: 0,
        projectedBytes: 0,
        reclaimableBytes: 0,
        occurrencesSeen: 0,
        imagesPrunable: 0,
        knownPlaceholders: 0,
        belowMinimum: 0,
        candidateFiles: 0
      },
      blockedReasons: ['unsafe-sessions-root'],
      warnings: []
    };
    const native = {
      schemaVersion: 1,
      toolVersion: '0.6.0',
      command: 'reclaim status codex-native-compression',
      status: 'unsupported',
      supported: false,
      configuredState: 'unknown',
      plainJsonlFiles: 0,
      compressedJsonlFiles: 0,
      warnings: ['codex-executable-untrusted'],
      nextActions: ['Update Codex and run this status check again.']
    };
    const monitor = {
      schemaVersion: 1,
      toolVersion: '0.6.0',
      command: 'monitor codex-sessions',
      status: 'partial',
      currentBytes: 8_589_934_592,
      thresholdBytes: 8_589_934_592,
      growthThresholdBytes: 5_368_709_120,
      alert: true,
      statePersisted: true,
      notificationAttempted: true,
      notificationDelivered: false,
      warnings: ['session-metadata-scan-incomplete']
    };

    const validateScan = await validatorFor('schemas/reclaim-scan-result.v1.schema.json');
    for (const privateField of [
      { path: privatePath('.codex', 'sessions', 'private.jsonl') },
      { candidates: [{ identity: { dev: 1, ino: 2 } }] },
      { sourceSha256: 'a'.repeat(64) },
      { privateOutcomes: [{ code: 'unsafe-file' }] },
      { sessionText: 'private session contents' }
    ]) {
      expect(validateScan({ ...scan, ...privateField })).toBe(false);
    }

    const validateNative = await validatorFor('schemas/native-compression-status.v1.schema.json');
    expect(validateNative({ ...native, executablePath: '/Applications/Codex.app/Contents/Resources/codex' })).toBe(false);

    const validateMonitor = await validatorFor('schemas/codex-session-monitor-result.v1.schema.json');
    expect(validateMonitor({ ...monitor, sessionText: 'private session contents' })).toBe(false);
  });

  test('standalone public result schemas reject sensitive-looking public string values', async () => {
    const validateScan = await validatorFor('schemas/reclaim-scan-result.v1.schema.json');
    const scan = {
      schemaVersion: 1,
      toolVersion: '0.6.0',
      command: 'reclaim scan codex-session-images',
      status: 'blocked',
      contentRead: true,
      filters: { olderThanDays: 30, minFileSizeBytes: 52_428_800 },
      totals: {
        filesConsidered: 0,
        filesOpened: 0,
        filesSkippedBySize: 0,
        filesSkippedAfterRead: 0,
        filesBlocked: 0,
        sourceBytes: 0,
        projectedBytes: 0,
        reclaimableBytes: 0,
        occurrencesSeen: 0,
        imagesPrunable: 0,
        knownPlaceholders: 0,
        belowMinimum: 0,
        candidateFiles: 0
      },
      blockedReasons: [],
      warnings: []
    };
    expect(validateScan({ ...scan, toolVersion: privatePath('private.jsonl') })).toBe(false);
    expect(validateScan({ ...scan, toolVersion: '1.2.3-01' })).toBe(false);
    expect(validateScan({ ...scan, blockedReasons: ['private session contents'] })).toBe(false);
    expect(validateScan({ ...scan, warnings: ['a'.repeat(64)] })).toBe(false);

    const native = {
      schemaVersion: 1,
      toolVersion: '0.6.0',
      command: 'reclaim status codex-native-compression',
      status: 'partial',
      supported: false,
      configuredState: 'unknown',
      plainJsonlFiles: 0,
      compressedJsonlFiles: 0,
      warnings: ['native-feature-check-unavailable'],
      nextActions: ['Retry after verifying the bundled Codex executable.']
    };
    const validateNative = await validatorFor('schemas/native-compression-status.v1.schema.json');
    expect(validateNative({ ...native, toolVersion: '{"dev":1,"ino":2}' })).toBe(false);
    expect(validateNative({ ...native, toolVersion: '1.2.3-01' })).toBe(false);
    expect(validateNative({ ...native, featureStage: privatePath('private.jsonl') })).toBe(false);
    expect(validateNative({ ...native, warnings: ['private session contents'] })).toBe(false);
    expect(validateNative({ ...native, nextActions: ['{"identity":{"dev":1,"ino":2}}'] })).toBe(false);

    const monitor = {
      schemaVersion: 1,
      toolVersion: '0.6.0',
      command: 'monitor codex-sessions',
      status: 'partial',
      currentBytes: 0,
      thresholdBytes: 1,
      growthThresholdBytes: 1,
      alert: false,
      statePersisted: false,
      notificationAttempted: false,
      warnings: ['session-root-untrusted']
    };
    const validateMonitor = await validatorFor('schemas/codex-session-monitor-result.v1.schema.json');
    expect(validateMonitor({ ...monitor, toolVersion: 'private session contents' })).toBe(false);
    expect(validateMonitor({ ...monitor, toolVersion: '1.2.3-01' })).toBe(false);
    expect(validateMonitor({ ...monitor, warnings: [privatePath('private.jsonl')] })).toBe(false);
  });
});

async function validatorFor(schemaPath: string) {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  return ajv.compile(schema);
}
