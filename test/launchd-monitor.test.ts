import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CommandRunResult } from '../src/types.js';

// These cases exercise macOS-only behavior; the unsupported-platform cases still run everywhere.
const macTest = process.platform === 'darwin' ? test : test.skip;

const fsHooks = vi.hoisted(() => ({
  events: [] as string[],
  beforeLstat: undefined as ((target: string) => Promise<void>) | undefined,
  failTemporaryOpen: false,
  failDirectorySyncs: 0,
  failUnlinkPath: undefined as string | undefined
}));

const DARWIN_O_EXLOCK = 0x00000020;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (target: string) => {
      await fsHooks.beforeLstat?.(target);
      return actual.lstat(target);
    },
    open: async (target: string, flags: string | number, mode?: number) => {
      fsHooks.events.push(`open:${target}`);
      if (
        fsHooks.failTemporaryOpen
        && target.includes('.codex-session-monitor.plist.')
        && target.endsWith('.tmp')
      ) {
        throw Object.assign(new Error('synthetic temporary open failure'), { code: 'EACCES' });
      }
      const handle = await actual.open(target, flags, mode);
      if (
        fsHooks.failDirectorySyncs > 0
        && typeof flags === 'number'
        && typeof constants.O_DIRECTORY === 'number'
        && (flags & constants.O_DIRECTORY) === constants.O_DIRECTORY
        && (flags & DARWIN_O_EXLOCK) === 0
      ) {
        fsHooks.failDirectorySyncs--;
        return withFailingSync(handle);
      }
      return handle;
    },
    rename: async (from: string, to: string) => {
      fsHooks.events.push(`rename:${from}->${to}`);
      return actual.rename(from, to);
    },
    unlink: async (target: string) => {
      fsHooks.events.push(`unlink:${target}`);
      if (target === fsHooks.failUnlinkPath) {
        throw Object.assign(new Error('synthetic unlink failure'), { code: 'EACCES' });
      }
      return actual.unlink(target);
    }
  };
});

import {
  buildCodexMonitorPlist,
  CODEX_MONITOR_NOTIFICATION_SCRIPT,
  installCodexMonitor,
  removeCodexMonitor,
  sendCodexSessionMonitorNotification,
  type CodexMonitorInstallSpec
} from '../src/monitor/launchd.js';
import { codexSessionMonitorLaunchAgentPath } from '../src/paths.js';

afterEach(() => {
  fsHooks.events.length = 0;
  fsHooks.beforeLstat = undefined;
  fsHooks.failTemporaryOpen = false;
  fsHooks.failDirectorySyncs = 0;
  fsHooks.failUnlinkPath = undefined;
});

describe('buildCodexMonitorPlist', () => {
  test('builds deterministic escaped XML with only the fixed metadata monitor route', () => {
    const spec: CodexMonitorInstallSpec = {
      nodePath: '/opt/Node & Tools/node',
      cliScriptPath: '/opt/AIDM <dev>/cli.js',
      thresholdBytes: 8 * 1024 ** 3,
      growthThresholdBytes: 5 * 1024 ** 3,
      day: 1,
      hour: 4,
      minute: 30
    };

    const first = buildCodexMonitorPlist(spec);
    const second = buildCodexMonitorPlist({ ...spec });

    expect(first).toBe(second);
    expect(first).toContain('<string>/opt/Node &amp; Tools/node</string>');
    expect(first).toContain('<string>/opt/AIDM &lt;dev&gt;/cli.js</string>');
    expect(first).toContain('<string>__scheduled-monitor</string>');
    expect(first).toContain('<string>codex-sessions</string>');
    expect(first).toContain('<string>--threshold-bytes</string>');
    expect(first).toContain('<string>8589934592</string>');
    expect(first).toContain('<string>--growth-threshold-bytes</string>');
    expect(first).toContain('<string>5368709120</string>');
    expect(first).toContain('<key>LowPriorityIO</key>\n  <true/>');
    expect(first).toContain('<key>Nice</key>\n  <integer>10</integer>');
    expect(first).toContain('<key>Day</key>\n      <integer>1</integer>');
    expect(first).toContain('<key>Hour</key>\n      <integer>4</integer>');
    expect(first).toContain('<key>Minute</key>\n      <integer>30</integer>');
    expect(first).not.toMatch(/<key>Shell|\/bin\/(?:ba)?sh|<string>-c<\/string>/);
    expect(first).not.toContain('<string>apply</string>');
    expect(first).not.toContain('<string>plan</string>');
    expect(first).not.toContain('--accept-image-loss');
    expect(first.endsWith('\n')).toBe(true);
  });

  test.each([
    ['relative node', { nodePath: 'node' }],
    ['invalid day', { day: 2 as 1 }],
    ['invalid hour', { hour: 5 as 4 }],
    ['invalid minute', { minute: 31 as 30 }],
    ['zero threshold', { thresholdBytes: 0 }],
    ['fractional growth', { growthThresholdBytes: 1.5 }]
  ])('rejects %s', (_label, overrides) => {
    expect(() => buildCodexMonitorPlist({
      nodePath: '/opt/node',
      cliScriptPath: '/opt/aidm/cli.js',
      thresholdBytes: 8,
      growthThresholdBytes: 5,
      day: 1,
      hour: 4,
      minute: 30,
      ...overrides
    })).toThrow('invalid Codex monitor install spec');
  });
});

describe('LaunchAgent install', () => {
  test('blocks every macOS side effect on an unsupported runtime', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      await withPlatform('linux', async () => {
        await expect(
          installCodexMonitor(fixture.spec, dependencies(fixture, commandCalls))
        ).resolves.toEqual({
          status: 'blocked',
          changed: false,
          blockedReasons: ['platform-unsupported'],
          warnings: []
        });
        await expect(removeCodexMonitor(dependencies(fixture, commandCalls))).resolves.toEqual({
          status: 'blocked',
          changed: false,
          blockedReasons: ['platform-unsupported'],
          warnings: []
        });
        await expect(sendCodexSessionMonitorNotification({
          currentBytes: 8,
          thresholdBytes: 8,
          growthThresholdBytes: 5,
          measurementComplete: true
        }, dependencies(fixture, commandCalls))).resolves.toBe(false);
      });

      expect(commandCalls).toEqual([]);
      await expect(lstat(fixture.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('durably installs the exact plist before bounded launchctl bootstrap', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      resetFsActivity();
      const result = await installCodexMonitor(fixture.spec, dependencies(fixture, commandCalls));

      expect(result).toEqual({
        status: 'ok',
        changed: true,
        blockedReasons: [],
        warnings: []
      });
      expect(commandCalls).toEqual([{
        name: 'launchctl',
        command: '/mock/launchctl',
        args: [
          'bootstrap',
          `gui/${process.getuid?.()}`,
          fixture.plistPath
        ],
        options: {
          timeoutMs: 5_000,
          maxStdoutBytes: 16 * 1024,
          maxStderrBytes: 16 * 1024
        }
      }]);
      expect(await readFile(fixture.plistPath, 'utf8')).toBe(buildCodexMonitorPlist(fixture.spec));
      expect((await lstat(fixture.plistPath)).mode & 0o777).toBe(0o600);
      const renameIndex = fsHooks.events.findIndex((event) => event.startsWith('rename:'));
      const commandIndex = fsHooks.events.indexOf('command:launchctl:bootstrap');
      expect(renameIndex).toBeGreaterThanOrEqual(0);
      expect(commandIndex).toBeGreaterThan(renameIndex);
      expect(fsHooks.events.some((event) => event.includes('/Library/LaunchAgents/'))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks concurrent install and remove operations on the same LaunchAgents directory', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
    const lock = await open(
      path.dirname(fixture.plistPath),
      constants.O_RDONLY
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK
        | directoryFlag
        | DARWIN_O_EXLOCK
    );
    try {
      resetFsActivity();

      await expect(
        installCodexMonitor(fixture.spec, dependencies(fixture, commandCalls))
      ).resolves.toEqual({
        status: 'blocked',
        changed: false,
        blockedReasons: ['monitor-operation-in-progress'],
        warnings: []
      });
      await writeInstalledPlist(fixture);
      await expect(removeCodexMonitor(dependencies(fixture, commandCalls))).resolves.toEqual({
        status: 'blocked',
        changed: false,
        blockedReasons: ['monitor-operation-in-progress'],
        warnings: []
      });

      expect(commandCalls).toEqual([]);
      await expect(lstat(fixture.plistPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await lock.close();
      await fixture.cleanup();
    }
  });

  macTest.each([
    ['unsafe node', 'node'],
    ['unsafe CLI script', 'cli']
  ])('blocks an %s before writing or invoking launchctl', async (_label, target) => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      await chmod(target === 'node' ? fixture.nodePath : fixture.cliScriptPath, 0o722);
      resetFsActivity();

      const result = await installCodexMonitor(fixture.spec, dependencies(fixture, commandCalls));

      expect(result.status).toBe('blocked');
      expect(result.changed).toBe(false);
      expect(result.blockedReasons).toContain(
        target === 'node' ? 'node-executable-untrusted' : 'cli-script-untrusted'
      );
      expect(commandCalls).toEqual([]);
      await expect(lstat(fixture.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks a current-user Node file that is executable only for another class', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      await chmod(fixture.nodePath, 0o050);
      resetFsActivity();

      const result = await installCodexMonitor(fixture.spec, dependencies(fixture, commandCalls));

      expect(result).toEqual({
        status: 'blocked',
        changed: false,
        blockedReasons: ['node-executable-untrusted'],
        warnings: []
      });
      expect(commandCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks Node identity drift before committing the plist', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    let inspections = 0;
    try {
      fsHooks.beforeLstat = async (target) => {
        if (target !== fixture.nodePath) return;
        inspections++;
        if (inspections === 2) await chmod(fixture.nodePath, 0o722);
      };
      resetFsEventsOnly();

      const result = await installCodexMonitor(fixture.spec, dependencies(fixture, commandCalls));

      expect(inspections).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ status: 'blocked', changed: false });
      expect(result.blockedReasons).toContain('program-identity-drift');
      expect(commandCalls).toEqual([]);
      await expect(lstat(fixture.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('preserves the installed plist and reports partial when bootstrap fails', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      const deps = dependencies(fixture, commandCalls, commandResult({ code: 1 }));
      resetFsActivity();

      const result = await installCodexMonitor(fixture.spec, deps);

      expect(result).toEqual({
        status: 'partial',
        changed: true,
        blockedReasons: [],
        warnings: ['launchctl-bootstrap-failed']
      });
      await expect(lstat(fixture.plistPath)).resolves.toMatchObject({ mode: expect.any(Number) });
      expect(fsHooks.events.filter((event) => event === `unlink:${fixture.plistPath}`)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('does not bootstrap when plist directory fsync fails after rename', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      fsHooks.failDirectorySyncs = 1;
      resetFsEventsOnly();

      const result = await installCodexMonitor(fixture.spec, dependencies(fixture, commandCalls));

      expect(result).toEqual({
        status: 'partial',
        changed: true,
        blockedReasons: [],
        warnings: ['monitor-plist-not-durable']
      });
      expect(commandCalls).toEqual([]);
      await expect(lstat(fixture.plistPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('does not bootstrap a plist whose identity drifts after the durable rename', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    let targetInspections = 0;
    try {
      fsHooks.beforeLstat = async (target) => {
        if (target !== fixture.plistPath) return;
        targetInspections++;
        if (targetInspections === 3) await chmod(fixture.plistPath, 0o644);
      };
      resetFsEventsOnly();

      const result = await installCodexMonitor(fixture.spec, dependencies(fixture, commandCalls));

      expect(result).toEqual({
        status: 'partial',
        changed: true,
        blockedReasons: [],
        warnings: ['monitor-plist-identity-drift']
      });
      expect(targetInspections).toBeGreaterThanOrEqual(3);
      expect(commandCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('returns blocked without a local change when temporary creation fails', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      fsHooks.failTemporaryOpen = true;
      resetFsEventsOnly();

      const result = await installCodexMonitor(fixture.spec, dependencies(fixture, commandCalls));

      expect(result).toMatchObject({ status: 'blocked', changed: false });
      expect(result.blockedReasons).toContain('monitor-plist-write-failed');
      expect(commandCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('LaunchAgent remove', () => {
  macTest('boots out before unlinking the exact pinned plist', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      await writeInstalledPlist(fixture);
      resetFsActivity();

      const result = await removeCodexMonitor(dependencies(fixture, commandCalls));

      expect(result).toEqual({
        status: 'ok',
        changed: true,
        blockedReasons: [],
        warnings: []
      });
      expect(commandCalls[0]).toMatchObject({
        name: 'launchctl',
        args: ['bootout', `gui/${process.getuid?.()}`, fixture.plistPath]
      });
      expect(fsHooks.events.indexOf('command:launchctl:bootout')).toBeLessThan(
        fsHooks.events.indexOf(`unlink:${fixture.plistPath}`)
      );
      await expect(lstat(fixture.plistPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('preserves the plist when bootout fails before any known change', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      await writeInstalledPlist(fixture);
      resetFsActivity();

      const result = await removeCodexMonitor(
        dependencies(fixture, commandCalls, commandResult({ code: 1 }))
      );

      expect(result).toMatchObject({ status: 'blocked', changed: false });
      expect(result.blockedReasons).toContain('launchctl-bootout-failed');
      await expect(lstat(fixture.plistPath)).resolves.toMatchObject({ mode: expect.any(Number) });
      expect(fsHooks.events).not.toContain(`unlink:${fixture.plistPath}`);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('does not boot out through a LaunchAgents directory whose authority drifts', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    const launchAgents = path.dirname(fixture.plistPath);
    let directoryInspections = 0;
    try {
      await writeInstalledPlist(fixture);
      fsHooks.beforeLstat = async (target) => {
        if (target !== launchAgents) return;
        directoryInspections++;
        if (directoryInspections === 2) await chmod(launchAgents, 0o777);
      };
      resetFsEventsOnly();

      const result = await removeCodexMonitor(dependencies(fixture, commandCalls));

      expect(result).toEqual({
        status: 'blocked',
        changed: false,
        blockedReasons: ['launchagents-directory-drift'],
        warnings: []
      });
      expect(directoryInspections).toBeGreaterThanOrEqual(2);
      expect(commandCalls).toEqual([]);
      await expect(lstat(fixture.plistPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await chmod(launchAgents, 0o700).catch(() => undefined);
      await fixture.cleanup();
    }
  });

  macTest('reports partial when bootout succeeds but unlink fails', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      await writeInstalledPlist(fixture);
      fsHooks.failUnlinkPath = fixture.plistPath;
      resetFsEventsOnly();

      const result = await removeCodexMonitor(dependencies(fixture, commandCalls));

      expect(result).toEqual({
        status: 'partial',
        changed: true,
        blockedReasons: [],
        warnings: ['monitor-plist-unlink-failed']
      });
      await expect(lstat(fixture.plistPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('preserves a drifted plist after successful bootout', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      await writeInstalledPlist(fixture);
      resetFsActivity();
      const deps = dependencies(fixture, commandCalls);
      deps.runCommand = async (command, args, options) => {
        commandCalls.push({ name: 'launchctl', command, args, options });
        fsHooks.events.push('command:launchctl:bootout');
        await chmod(fixture.plistPath, 0o644);
        return commandResult();
      };

      const result = await removeCodexMonitor(deps);

      expect(result).toEqual({
        status: 'partial',
        changed: true,
        blockedReasons: [],
        warnings: ['monitor-plist-identity-drift']
      });
      await expect(lstat(fixture.plistPath)).resolves.toMatchObject({ mode: expect.any(Number) });
      expect(fsHooks.events).not.toContain(`unlink:${fixture.plistPath}`);
    } finally {
      await chmod(fixture.plistPath, 0o600).catch(() => undefined);
      await fixture.cleanup();
    }
  });

  macTest('is a no-op when the exact plist is absent', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      resetFsActivity();

      const result = await removeCodexMonitor(dependencies(fixture, commandCalls));

      expect(result).toEqual({
        status: 'ok',
        changed: false,
        blockedReasons: [],
        warnings: []
      });
      expect(commandCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('fixed monitor notification', () => {
  macTest('passes one sanitized metric message separately from fixed AppleScript source', async () => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      const delivered = await sendCodexSessionMonitorNotification({
        currentBytes: 3,
        thresholdBytes: 3,
        growthThresholdBytes: 5,
        measurementComplete: false
      }, dependencies(fixture, commandCalls));

      expect(delivered).toBe(true);
      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0]).toMatchObject({
        name: 'osascript',
        command: '/mock/osascript',
        args: ['-e', CODEX_MONITOR_NOTIFICATION_SCRIPT, expect.stringContaining('at least 3 B')],
        options: {
          timeoutMs: 5_000,
          maxStdoutBytes: 4 * 1024,
          maxStderrBytes: 4 * 1024
        }
      });
      expect(CODEX_MONITOR_NOTIFICATION_SCRIPT).not.toContain('3 B');
      expect(commandCalls[0]?.args[2]).not.toContain(fixture.home);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    ['nonzero', commandResult({ code: 1 })],
    ['truncated', commandResult({ stdoutTruncated: true })],
    ['stderr', commandResult({ stderr: 'private diagnostic' })],
    ['timed out', commandResult({ timedOut: true })],
    ['signalled', commandResult({ signal: 'SIGTERM' })]
  ])('returns false for %s notification execution', async (_label, result) => {
    const fixture = await makeFixture();
    const commandCalls: CommandCall[] = [];
    try {
      await expect(sendCodexSessionMonitorNotification({
        currentBytes: 8,
        thresholdBytes: 8,
        growthThresholdBytes: 5,
        measurementComplete: true
      }, dependencies(fixture, commandCalls, result))).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});

type Fixture = {
  home: string;
  nodePath: string;
  cliScriptPath: string;
  plistPath: string;
  spec: CodexMonitorInstallSpec;
  cleanup(): Promise<void>;
};

type CommandCall = {
  name: 'launchctl' | 'osascript';
  command: string;
  args: string[];
  options?: Record<string, unknown>;
};

async function makeFixture(): Promise<Fixture> {
  const created = await mkdtemp(path.join(os.tmpdir(), 'aidm-launchd-home-'));
  const home = await realpath(created);
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  const nodePath = path.join(home, 'bin', 'node');
  const cliScriptPath = path.join(home, 'app', 'dist', 'cli.js');
  await mkdir(launchAgents, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(nodePath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(cliScriptPath), { recursive: true, mode: 0o700 });
  await writeFile(nodePath, '#!/bin/sh\nexit 0\n', { mode: 0o500 });
  await writeFile(cliScriptPath, 'export {};\n', { mode: 0o600 });
  const spec: CodexMonitorInstallSpec = {
    nodePath,
    cliScriptPath,
    thresholdBytes: 8 * 1024 ** 3,
    growthThresholdBytes: 5 * 1024 ** 3,
    day: 1,
    hour: 4,
    minute: 30
  };
  resetFsActivity();
  return {
    home,
    nodePath,
    cliScriptPath,
    plistPath: codexSessionMonitorLaunchAgentPath({ HOME: home }),
    spec,
    cleanup: async () => rm(home, { recursive: true, force: true })
  };
}

function dependencies(
  fixture: Fixture,
  calls: CommandCall[],
  result: CommandRunResult = commandResult()
) {
  return {
    env: { HOME: fixture.home },
    trustedCommandPath: async (name: 'launchctl' | 'osascript') => {
      return `/mock/${name}`;
    },
    runCommand: async (
      command: string,
      args: string[],
      options?: Record<string, unknown>
    ) => {
      const name = command.endsWith('osascript') ? 'osascript' : 'launchctl';
      calls.push({ name, command, args: [...args], options });
      fsHooks.events.push(`command:${name}:${args[0] ?? ''}`);
      return { ...result };
    }
  };
}

async function writeInstalledPlist(fixture: Fixture): Promise<void> {
  await writeFile(fixture.plistPath, buildCodexMonitorPlist(fixture.spec), {
    mode: 0o600,
    flag: 'wx'
  });
}

function commandResult(overrides: Partial<CommandRunResult> = {}): CommandRunResult {
  return {
    code: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides
  };
}

function resetFsActivity(): void {
  fsHooks.events.length = 0;
  fsHooks.beforeLstat = undefined;
  fsHooks.failTemporaryOpen = false;
  fsHooks.failDirectorySyncs = 0;
  fsHooks.failUnlinkPath = undefined;
}

function resetFsEventsOnly(): void {
  fsHooks.events.length = 0;
}

function withFailingSync(value: FileHandle): FileHandle {
  return new Proxy(value, {
    get(target, property) {
      if (property === 'sync') {
        return async () => {
          throw new Error('synthetic directory sync failure');
        };
      }
      const result: unknown = Reflect.get(target, property, target);
      return typeof result === 'function' ? result.bind(target) : result;
    }
  });
}

async function withPlatform<T>(
  platform: NodeJS.Platform,
  action: () => Promise<T>
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('process.platform descriptor is unavailable');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}
