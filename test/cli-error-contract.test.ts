import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';

const ENV = { HOME: '/nonexistent/aidm-error-contract-home' };
const LEAK = ['/Users', 'example', 'private', 'AIDM_ERROR_LEAK'].join('/');

async function validator() {
  const schema = JSON.parse(await readFile('schemas/cli-error.v1.schema.json', 'utf8'));
  return new Ajv({ allErrors: true, strict: true }).compile(schema);
}

describe('--json error contract', () => {
  test('returns schema-valid JSON on stdout when report --latest --json finds nothing', async () => {
    const validate = await validator();

    const result = await runCli(['report', '--latest', '--json'], { env: ENV, commands: { latestReport: async () => null } });

    expect(result.exitCode).toBe(1);
    expect(result.stream).not.toBe('stderr');
    const payload = JSON.parse(result.output);
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    expect(payload).toEqual({ schemaVersion: 1, status: 'error', exitCode: 1, error: 'not-found', message: 'No report found.' });
  });

  test.each([
    [['doctor', '--json', '--bogus'], 'Unknown doctor flag: --bogus'],
    [['doctor', '--json', '--html'], '--html cannot be combined with --json, --share, --show-paths, --plain, or --no-banner.'],
    [['reports', 'prune', '--json'], 'Missing required confirmation: --yes'],
    [['reclaim', 'scan', 'codex-session-images', '--older-than-days', 'abc', '--json'], 'Invalid --older-than-days: abc. Expected an integer from 1 to 3650.']
  ])('returns a usage error as JSON without the usage text: %j', async (argv, message) => {
    const validate = await validator();

    const result = await runCli(argv, { env: ENV });

    expect(result.exitCode).toBe(2);
    const payload = JSON.parse(result.output);
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    expect(payload).toMatchObject({ error: 'usage', exitCode: 2, message });
    expect(result.output).not.toContain('Usage:');
  });

  test('keeps a command JSON result unchanged when it already produced JSON', async () => {
    const result = await runCli(['apply', '--plan', '../../x', '--yes', '--json'], { env: ENV });

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({ status: 'blocked', blockedReasons: ['invalid plan id'] });
  });

  test('redacts local paths inside JSON error messages', async () => {
    const result = await runCli(['report', '--latest', '--json'], {
      env: ENV,
      commands: {
        latestReport: async () => null
      }
    });
    const pathResult = await runCli(['doctor', '--json', `--${LEAK}`], { env: ENV });

    expect(result.output).not.toContain('/Users/');
    expect(pathResult.output).not.toContain(LEAK);
  });

  test('sends human usage and not-found errors to stderr without changing the text', async () => {
    const usage = await runCli(['doctor', '--bogus'], { env: ENV });
    const missing = await runCli(['report', '--latest'], { env: ENV, commands: { latestReport: async () => null } });

    expect(usage).toMatchObject({ exitCode: 2, stream: 'stderr' });
    expect(usage.output).toContain('Unknown doctor flag: --bogus');
    expect(missing).toEqual({ exitCode: 1, output: 'No report found.\n', stream: 'stderr' });
  });

  test('keeps blocked human results on stdout', async () => {
    const result = await runCli(['apply', '--plan', '../../x', '--yes'], { env: ENV });

    expect(result.exitCode).toBe(3);
    expect(result.stream).toBeUndefined();
  });
});
