import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';

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
});

async function validatorFor(schemaPath: string) {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  return ajv.compile(schema);
}
