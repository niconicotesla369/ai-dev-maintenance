import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli.js';
import { TOOL_VERSION } from '../src/version.js';
import type { CliRuntimeOptions } from '../src/cli-router.js';

const RELEASE_VERSION = '0.6.0';

function readmePackageCommandLines(readme: string): string[] {
  return readme
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:npx\b|npm exec\b|npm install -g\b)/.test(line) && line.includes('ai-dev-maintenance'));
}

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

describe('v0.6.0 release metadata', () => {
  test('CLI and machine-readable metadata agree on the release version', async () => {
    const cliResult = await runCli(['--version'], runtimeThatMustNotRunCommands([]));
    const packageMetadata = JSON.parse(await readFile('package.json', 'utf8')) as { version?: unknown };
    const sampleReport = JSON.parse(await readFile('examples/sample-report.json', 'utf8')) as {
      toolVersion?: unknown;
    };

    expect(cliResult.output).toBe(`${RELEASE_VERSION}\n`);
    expect(TOOL_VERSION).toBe(RELEASE_VERSION);
    expect(packageMetadata.version).toBe(RELEASE_VERSION);
    expect(sampleReport.toolVersion).toBe(RELEASE_VERSION);
  });

  test('README package-command selection includes an unpinned invocation', () => {
    expect(readmePackageCommandLines('npx --yes ai-dev-maintenance')).toEqual([
      'npx --yes ai-dev-maintenance'
    ]);
  });

  test.each(['README.md', 'README.ja.md'])('%s pins every current package command to the release version', async (file) => {
    const readme = await readFile(file, 'utf8');
    const packageCommands = readmePackageCommandLines(readme);

    expect(packageCommands.length).toBeGreaterThan(0);
    for (const command of packageCommands) {
      expect(command).toContain(`ai-dev-maintenance@${RELEASE_VERSION}`);
    }
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
