import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import { TOOL_VERSION } from '../src/version.js';
import type { CliRuntimeOptions } from '../src/cli-router.js';

describe('root version CLI', () => {
  test.each([
    ['--version'],
    ['-v'],
    ['version']
  ])('%s prints only the package version and exits successfully', async (arg) => {
    const calls: string[] = [];
    const result = await runCli([arg], runtimeThatMustNotRunCommands(calls));

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`${TOOL_VERSION}\n`);
    expect(result.output).not.toContain('AI DEV MAINTENANCE');
    expect(result.output).not.toContain('AIDM SYSTEM PULSE');
    expect(calls).toEqual([]);
  });

  test('--version is intercepted before default doctor flag validation', async () => {
    const result = await runCli(['--version'], runtimeThatMustNotRunCommands([]));

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('Unknown doctor flag');
    expect(result.output).not.toContain('Usage:');
  });

  test('command-specific version flags remain rejected by existing validation', async () => {
    const result = await runCli(['pressure', '--version'], runtimeThatMustNotRunCommands([]));

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown pressure flag: --version');
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
        throw new Error('runDoctor should not run for version');
      },
      runFixSafe: async () => {
        calls.push('runFixSafe');
        throw new Error('runFixSafe should not run for version');
      },
      runPressureDoctor: async () => {
        calls.push('runPressureDoctor');
        throw new Error('runPressureDoctor should not run for version');
      },
      latestReport: async () => {
        calls.push('latestReport');
        throw new Error('latestReport should not run for version');
      },
      validateRestoreBackup: async () => {
        calls.push('validateRestoreBackup');
        throw new Error('validateRestoreBackup should not run for version');
      },
      pruneReports: async () => {
        calls.push('pruneReports');
        throw new Error('pruneReports should not run for version');
      },
      pruneBackups: async () => {
        calls.push('pruneBackups');
        throw new Error('pruneBackups should not run for version');
      },
      runCursorSafeCleanup: async () => {
        calls.push('runCursorSafeCleanup');
        throw new Error('runCursorSafeCleanup should not run for version');
      }
    }
  };
}
