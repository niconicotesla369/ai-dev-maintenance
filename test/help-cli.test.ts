import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import type { CliRuntimeOptions } from '../src/cli-router.js';

describe('root help CLI', () => {
  test.each([
    ['--help'],
    ['-h']
  ])('%s prints usage and exits successfully without running diagnostics', async (arg) => {
    const calls: string[] = [];
    const result = await runCli([arg], runtimeThatMustNotRunCommands(calls));

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage:');
    expect(result.output).toContain('ai-dev-maintenance --help | -h');
    expect(result.output).toContain('ai-dev-maintenance pressure [--json] [--no-banner] [--plain]');
    expect(result.output).not.toContain('Unknown doctor flag');
    expect(result.output).not.toContain('AI DEV MAINTENANCE');
    expect(result.output).not.toContain('AIDM SYSTEM PULSE');
    expect(calls).toEqual([]);
  });
});

function runtimeThatMustNotRunCommands(calls: string[]): CliRuntimeOptions {
  return {
    env: {},
    io: {
      isInputTty: true,
      isOutputTty: true,
      columns: 120
    },
    commands: {
      runDoctor: async () => {
        calls.push('runDoctor');
        throw new Error('runDoctor should not run for help');
      },
      runFixSafe: async () => {
        calls.push('runFixSafe');
        throw new Error('runFixSafe should not run for help');
      },
      runPressureDoctor: async () => {
        calls.push('runPressureDoctor');
        throw new Error('runPressureDoctor should not run for help');
      },
      latestReport: async () => {
        calls.push('latestReport');
        throw new Error('latestReport should not run for help');
      },
      validateRestoreBackup: async () => {
        calls.push('validateRestoreBackup');
        throw new Error('validateRestoreBackup should not run for help');
      },
      pruneReports: async () => {
        calls.push('pruneReports');
        throw new Error('pruneReports should not run for help');
      },
      pruneBackups: async () => {
        calls.push('pruneBackups');
        throw new Error('pruneBackups should not run for help');
      },
      runCursorSafeCleanup: async () => {
        calls.push('runCursorSafeCleanup');
        throw new Error('runCursorSafeCleanup should not run for help');
      }
    }
  };
}
