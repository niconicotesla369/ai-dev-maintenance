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
    expect(result.output).toContain('ai-dev-maintenance doctor [--json] [--show-paths] [--share] [--html] [--no-banner]');
    expect(result.output).toContain('ai-dev-maintenance report --latest [--show-paths] [--json] [--html]');
    expect(result.output).toContain('ai-dev-maintenance pressure [--json] [--share] [--no-banner] [--plain]');
    expect(result.output).not.toContain('Unknown doctor flag');
    expect(result.output).not.toContain('AI DEV MAINTENANCE');
    expect(result.output).not.toContain('AIDM SYSTEM PULSE');
    expect(calls).toEqual([]);
  });

  test('documents every approved v0.6 public route but keeps the scheduler entry point hidden', async () => {
    const result = await runCli(['--help'], runtimeThatMustNotRunCommands([]));

    expect(result.output).toContain('reclaim scan codex-session-images');
    expect(result.output).toContain('--older-than-days <days>');
    expect(result.output).toContain('--min-file-size-mb <MiB>');
    expect(result.output).toContain('reclaim status codex-native-compression [--json]');
    expect(result.output).toContain('monitor codex-sessions [--json]');
    expect(result.output).toContain('plan codex-sparkle-clean [--json]');
    expect(result.output).toContain('plan codex-session-image-prune');
    expect(result.output).toContain('plan codex-session-monitor-install');
    expect(result.output).toContain('--threshold-gib <GiB>');
    expect(result.output).toContain('--growth-gib <GiB>');
    expect(result.output).toContain('plan codex-session-monitor-remove [--json]');
    expect(result.output).toContain('apply --plan <planId> --yes [--accept-image-loss] [--json]');
    expect(result.output).not.toContain('__scheduled-monitor');
  });
});

describe('v0.6 CLI validation', () => {
  test.each([
    ['missing days value', ['reclaim', 'scan', 'codex-session-images', '--older-than-days']],
    ['zero days', ['reclaim', 'scan', 'codex-session-images', '--older-than-days', '0']],
    ['fractional days', ['reclaim', 'scan', 'codex-session-images', '--older-than-days', '1.5']],
    ['days above bound', ['reclaim', 'scan', 'codex-session-images', '--older-than-days', '3651']],
    ['overflowing days', ['reclaim', 'scan', 'codex-session-images', '--older-than-days', '9007199254740992']],
    ['duplicate days', ['reclaim', 'scan', 'codex-session-images', '--older-than-days', '30', '--older-than-days', '31']],
    ['missing MiB value', ['reclaim', 'scan', 'codex-session-images', '--min-file-size-mb']],
    ['MiB above bound', ['reclaim', 'scan', 'codex-session-images', '--min-file-size-mb', '1048577']],
    ['fractional threshold', ['plan', 'codex-session-monitor-install', '--threshold-gib', '8.5']],
    ['growth above bound', ['plan', 'codex-session-monitor-install', '--growth-gib', '1025']],
    ['duplicate threshold', ['plan', 'codex-session-monitor-install', '--threshold-gib', '8', '--threshold-gib', '9']]
  ])('rejects %s before running a command', async (_label, argv) => {
    const calls: string[] = [];
    const result = await runCli(argv, runtimeThatMustNotRunCommands(calls));

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/Missing|Invalid|Duplicate/);
    expect(calls).toEqual([]);
  });

  test.each([
    ['reclaim', 'scan', 'codex-session-images', '--delete'],
    ['reclaim', 'status', 'codex-native-compression', '--enable'],
    ['monitor', 'codex-sessions', '--persist'],
    ['plan', 'codex-sparkle-clean', '--all-updaters']
  ])('rejects unknown public-route flags: %s', async (...argv) => {
    const calls: string[] = [];
    const result = await runCli(argv, runtimeThatMustNotRunCommands(calls));

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown');
    expect(calls).toEqual([]);
  });

  test.each([
    ['wrong subcommand', ['__scheduled-monitor', 'other', '--threshold-bytes', '1', '--growth-threshold-bytes', '1']],
    ['missing threshold', ['__scheduled-monitor', 'codex-sessions', '--growth-threshold-bytes', '1']],
    ['zero threshold', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '0', '--growth-threshold-bytes', '1']],
    ['fractional growth', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1.5']],
    ['growth above byte bound', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1099511627777']],
    ['duplicate byte threshold', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--threshold-bytes', '2', '--growth-threshold-bytes', '1']],
    ['arbitrary path', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1', '/tmp/private']],
    ['plan positional', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1', 'plan']],
    ['plan id', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1', '--plan', 'plan-id']],
    ['image plan flag', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1', '--older-than-days', '30']],
    ['monitor plan flag', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1', '--threshold-gib', '8']],
    ['yes confirmation', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1', '--yes']],
    ['image-loss confirmation', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1', '--accept-image-loss']],
    ['apply positional', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1', 'apply']],
    ['json flag', ['__scheduled-monitor', 'codex-sessions', '--threshold-bytes', '1', '--growth-threshold-bytes', '1', '--json']]
  ])('keeps the hidden scheduler structurally narrow: %s', async (_label, argv) => {
    const calls: string[] = [];
    const result = await runCli(argv, runtimeThatMustNotRunCommands(calls));

    expect(result.exitCode).toBe(2);
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
      },
      scanCodexSessionImages: async () => {
        calls.push('scanCodexSessionImages');
        throw new Error('scanCodexSessionImages should not run for help or invalid input');
      },
      inspectCodexNativeCompression: async () => {
        calls.push('inspectCodexNativeCompression');
        throw new Error('inspectCodexNativeCompression should not run for help or invalid input');
      },
      measureCodexSessionState: async () => {
        calls.push('measureCodexSessionState');
        throw new Error('measureCodexSessionState should not run for help or invalid input');
      },
      sendCodexSessionMonitorNotification: async () => {
        calls.push('sendCodexSessionMonitorNotification');
        throw new Error('sendCodexSessionMonitorNotification should not run for help or invalid input');
      },
      createPlan: async () => {
        calls.push('createPlan');
        throw new Error('createPlan should not run for help or invalid input');
      },
      applyPlan: async () => {
        calls.push('applyPlan');
        throw new Error('applyPlan should not run for help or invalid input');
      }
    }
  };
}
