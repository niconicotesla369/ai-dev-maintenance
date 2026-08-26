import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

type PlistValues = {
  bundleId: string;
  shortVersion: string;
  buildVersion: string;
};

const commandHooks = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; options?: Record<string, unknown> }>,
  plistValues: new Map<string, PlistValues>(),
  plistRawValues: new Map<string, string>(),
  psResult: commandResult({ stdout: `${process.pid} /usr/bin/node aidm` })
}));

const fsHooks = vi.hoisted(() => ({
  installedFixture: undefined as string | undefined,
  removeCalls: [] as Array<{ target: string; options?: Record<string, unknown> }>,
  failRemovePath: undefined as string | undefined
}));

vi.mock('../src/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/commands.js')>();
  return {
    ...actual,
    trustedCommandPath: async (name: string) => `/mock/${name}`,
    runCommand: async (
      command: string,
      args: string[],
      options?: Record<string, unknown>
    ) => {
      commandHooks.calls.push({ command, args: [...args], options });
      if (command === '/mock/ps') return { ...commandHooks.psResult };
      if (command !== '/mock/plutil') throw new Error('unexpected synthetic command');
      const key = args[1];
      const plistPath = args.at(-1) ?? '';
      const rawValue = commandHooks.plistRawValues.get(`${plistPath}:${key}`);
      if (rawValue !== undefined) return commandResult({ stdout: rawValue });
      const values = commandHooks.plistValues.get(plistPath);
      if (!values) return commandResult({ code: 1, stderr: 'synthetic plist unavailable' });
      const value = key === 'CFBundleIdentifier'
        ? values.bundleId
        : key === 'CFBundleShortVersionString'
          ? values.shortVersion
          : key === 'CFBundleVersion'
            ? values.buildVersion
            : undefined;
      return value === undefined
        ? commandResult({ code: 1, stderr: 'unexpected plist key' })
        : commandResult({ stdout: `${value}\n` });
    }
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (target: string) => {
      const translated = translateInstalledPath(target);
      const stats = await actual.lstat(translated);
      return target.startsWith('/Applications/Codex.app') ? withUid(stats, 0) : stats;
    },
    readdir: async (target: string, options?: Record<string, unknown>) =>
      actual.readdir(translateInstalledPath(target), options),
    realpath: async (target: string) => {
      const translated = translateInstalledPath(target);
      await actual.realpath(translated);
      return target.startsWith('/Applications/Codex.app') ? target : actual.realpath(target);
    },
    rm: async (target: string, options?: Record<string, unknown>) => {
      fsHooks.removeCalls.push({ target, options });
      if (target === fsHooks.failRemovePath) throw new Error('synthetic exact deletion failure');
      return actual.rm(target, options);
    }
  };
});

import {
  planCodexSparkleCleanup,
  runCodexSparkleCleanup
} from '../src/reclaim/codex-sparkle.js';

afterEach(() => {
  commandHooks.calls.length = 0;
  commandHooks.plistValues.clear();
  commandHooks.plistRawValues.clear();
  commandHooks.psResult = commandResult({ stdout: `${process.pid} /usr/bin/node aidm` });
  fsHooks.installedFixture = undefined;
  fsHooks.removeCalls.length = 0;
  fsHooks.failRemovePath = undefined;
});

describe('planCodexSparkleCleanup', () => {
  test('plans only same-or-older Installation children and keeps updater support directories out', async () => {
    const fixture = await makeFixture([
      { name: 'same', shortVersion: '3.2.0', buildVersion: '100' },
      { name: 'older', shortVersion: '3.1.9', buildVersion: '999' }
    ]);
    try {
      const plan = await planCodexSparkleCleanup({
        env: { HOME: fixture.home },
        processList: ''
      });

      expect(plan.status).toBe('ready');
      expect(plan.blockedReasons).toEqual([]);
      expect(plan.targets.map((target) => target.path).sort()).toEqual(fixture.targets.sort());
      expect(plan.targets.every((target) =>
        target.pathCategory === '<home>/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Installation/<item>'
      )).toBe(true);
      expect(plan.reclaimableBytes).toBeGreaterThan(0);
      expect(plan.targets.some((target) => /Launcher|PersistentDownloads|ShipIt/.test(target.path))).toBe(false);
      const plistCalls = commandHooks.calls.filter((call) => call.command === '/mock/plutil');
      expect(plistCalls.map((call) => call.args[1]).sort()).toEqual([
        'CFBundleIdentifier',
        'CFBundleIdentifier',
        'CFBundleIdentifier',
        'CFBundleShortVersionString',
        'CFBundleShortVersionString',
        'CFBundleShortVersionString',
        'CFBundleVersion',
        'CFBundleVersion',
        'CFBundleVersion'
      ]);
      expect(plistCalls.every((call) =>
        call.args[0] === '-extract'
        && call.args[2] === 'raw'
        && call.args[3] === '-o'
        && call.args[4] === '-'
        && call.args.length === 6
      )).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    ['newer short version', { shortVersion: '3.3.0', buildVersion: '1', bundleId: 'com.openai.codex' }],
    ['newer build', { shortVersion: '3.2.0', buildVersion: '101', bundleId: 'com.openai.codex' }],
    ['wrong bundle', { shortVersion: '3.2.0', buildVersion: '100', bundleId: 'example.invalid' }],
    ['noncanonical version', { shortVersion: '03.2.0', buildVersion: '100', bundleId: 'com.openai.codex' }]
  ])('blocks %s', async (_label, staged) => {
    const fixture = await makeFixture([{ name: 'candidate', ...staged }]);
    try {
      const plan = await planCodexSparkleCleanup({ env: { HOME: fixture.home }, processList: '' });
      expect(plan.status).toBe('blocked');
      expect(plan.targets).toEqual([]);
      expect(plan.blockedReasons).not.toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('blocks missing exact installed app and never accepts an alternate install location', async () => {
    const fixture = await makeFixture([{ name: 'candidate' }]);
    try {
      fsHooks.installedFixture = undefined;
      const plan = await planCodexSparkleCleanup({ env: { HOME: fixture.home }, processList: '' });

      expect(plan.status).toBe('blocked');
      expect(plan.targets).toEqual([]);
      expect(plan.blockedReasons).toContain('installed-codex-unavailable');
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects malformed process rows and noncanonical plist command output', async () => {
    const fixture = await makeFixture([{ name: 'candidate' }]);
    try {
      const malformedProcess = await planCodexSparkleCleanup({
        env: { HOME: fixture.home },
        processList: 'this row has no pid'
      });
      expect(malformedProcess.blockedReasons).toContain('process-check-unavailable');

      commandHooks.plistRawValues.set(
        '/Applications/Codex.app/Contents/Info.plist:CFBundleIdentifier',
        '\ncom.openai.codex\n'
      );
      const malformedPlist = await planCodexSparkleCleanup({
        env: { HOME: fixture.home },
        processList: ''
      });
      expect(malformedPlist.status).toBe('blocked');
      expect(malformedPlist.targets).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    '101 /Applications/Codex.app/Contents/MacOS/Codex',
    '102 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper',
    '103 /tmp/Codex.app/Contents/Frameworks/Autoupdate',
    '104 /tmp/ShipIt com.openai.codex',
    '105 /tmp/Sparkle.framework/Versions/B/Updater com.openai.codex'
  ])('blocks an active Codex/updater process: %s', async (processList) => {
    const fixture = await makeFixture([{ name: 'candidate' }]);
    try {
      const plan = await planCodexSparkleCleanup({ env: { HOME: fixture.home }, processList });
      expect(plan.status).toBe('blocked');
      expect(plan.blockedReasons).toContain('codex-updater-process-running');
    } finally {
      await fixture.cleanup();
    }
  });

  test('blocks zero/multiple staged apps, symlink trees, and unknown Sparkle root children', async () => {
    const cases: Array<(fixture: Fixture) => Promise<void>> = [
      async (fixture) => rm(path.join(fixture.targets[0], 'Codex.app'), { recursive: true, force: false }),
      async (fixture) => {
        const second = path.join(fixture.targets[0], 'nested', 'Codex.app');
        await createBundle(second);
        registerPlist(second, defaultVersions());
      },
      async (fixture) => symlink(fixture.home, path.join(fixture.targets[0], 'escape')),
      async (fixture) => writeFile(path.join(fixture.sparkleRoot, 'UnknownUpdaterState'), 'unknown')
    ];

    for (const mutate of cases) {
      const fixture = await makeFixture([{ name: 'candidate' }]);
      try {
        await mutate(fixture);
        const plan = await planCodexSparkleCleanup({ env: { HOME: fixture.home }, processList: '' });
        expect(plan.status).toBe('blocked');
        expect(plan.targets).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    }
  });
});

describe('runCodexSparkleCleanup', () => {
  test('deletes exact planned Installation children and preserves Launcher/PersistentDownloads', async () => {
    const fixture = await makeFixture([
      { name: 'one' },
      { name: 'two', shortVersion: '3.1.0', buildVersion: '50' }
    ]);
    try {
      const plan = await planCodexSparkleCleanup({ env: { HOME: fixture.home }, processList: '' });
      expect(plan.status).toBe('ready');

      const result = await runCodexSparkleCleanup({
        env: { HOME: fixture.home },
        expectedTargets: plan.targets
      });

      expect(result).toMatchObject({
        status: 'ok',
        changed: true,
        deletedEntries: 2,
        deletedBytes: plan.reclaimableBytes,
        blockedReasons: []
      });
      expect(await readFile(path.join(fixture.sparkleRoot, 'Launcher', 'keep'), 'utf8')).toBe('keep');
      expect(await readFile(path.join(fixture.sparkleRoot, 'PersistentDownloads', 'keep'), 'utf8')).toBe('keep');
      expect(fsHooks.removeCalls.filter((call) => fixture.targets.includes(call.target)).map((call) => call.target)).toEqual(
        fixture.targets
      );
      expect(fsHooks.removeCalls.filter((call) => fixture.targets.includes(call.target)).every((call) =>
        call.options?.recursive === true && call.options?.force === false
      )).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test('blocks identity drift before deletion', async () => {
    const fixture = await makeFixture([{ name: 'candidate' }]);
    try {
      const plan = await planCodexSparkleCleanup({ env: { HOME: fixture.home }, processList: '' });
      await writeFile(path.join(fixture.targets[0], 'drift'), 'changed');

      const result = await runCodexSparkleCleanup({
        env: { HOME: fixture.home },
        expectedTargets: plan.targets
      });

      expect(result).toMatchObject({ status: 'blocked', changed: false, deletedEntries: 0 });
      expect(result.blockedReasons).toContain('sparkle-target-drift');
      expect(fsHooks.removeCalls.some((call) => call.target === fixture.targets[0])).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test('rechecks staged versions and active updater processes before deletion', async () => {
    const fixture = await makeFixture([{ name: 'candidate' }]);
    try {
      const versionPlan = await planCodexSparkleCleanup({ env: { HOME: fixture.home }, processList: '' });
      registerPlist(path.join(fixture.targets[0], 'Codex.app'), {
        bundleId: 'com.openai.codex',
        shortVersion: '9.0.0',
        buildVersion: '1'
      });
      const versionResult = await runCodexSparkleCleanup({
        env: { HOME: fixture.home },
        expectedTargets: versionPlan.targets
      });
      expect(versionResult).toMatchObject({ status: 'blocked', changed: false, deletedEntries: 0 });
      expect(versionResult.blockedReasons).toContain('staged-codex-ineligible');

      registerPlist(path.join(fixture.targets[0], 'Codex.app'), defaultVersions());
      const processPlan = await planCodexSparkleCleanup({ env: { HOME: fixture.home }, processList: '' });
      commandHooks.psResult = commandResult({
        stdout: `${process.pid} /usr/bin/node aidm\n999 /tmp/ShipIt com.openai.codex`
      });
      const processResult = await runCodexSparkleCleanup({
        env: { HOME: fixture.home },
        expectedTargets: processPlan.targets
      });
      expect(processResult).toMatchObject({ status: 'blocked', changed: false, deletedEntries: 0 });
      expect(processResult.blockedReasons).toContain('codex-updater-process-running');
      expect(fsHooks.removeCalls.some((call) => fixture.targets.includes(call.target))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  test('returns truthful partial after a later exact target deletion fails', async () => {
    const fixture = await makeFixture([{ name: 'one' }, { name: 'two' }]);
    try {
      const plan = await planCodexSparkleCleanup({ env: { HOME: fixture.home }, processList: '' });
      fsHooks.failRemovePath = fixture.targets[1];

      const result = await runCodexSparkleCleanup({
        env: { HOME: fixture.home },
        expectedTargets: plan.targets
      });

      expect(result).toMatchObject({
        status: 'partial',
        changed: true,
        deletedEntries: 1,
        deletedBytes: plan.targets[0].bytes
      });
      expect(result.blockedReasons).toContain('sparkle-delete-failed');
      await expect(readFile(path.join(fixture.targets[0], 'Codex.app', 'payload.bin')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(fixture.targets[1], 'Codex.app', 'payload.bin'), 'utf8')).not.toBe('');
    } finally {
      await fixture.cleanup();
    }
  });
});

type Fixture = {
  home: string;
  sparkleRoot: string;
  targets: string[];
  cleanup(): Promise<void>;
};

type StagedOptions = {
  name: string;
  bundleId?: string;
  shortVersion?: string;
  buildVersion?: string;
};

async function makeFixture(staged: StagedOptions[]): Promise<Fixture> {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aidm-sparkle-home-')));
  const sparkleRoot = path.join(
    home,
    'Library',
    'Caches',
    'com.openai.codex',
    'org.sparkle-project.Sparkle'
  );
  await mkdir(path.join(sparkleRoot, 'Installation'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(sparkleRoot, 'Launcher'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(sparkleRoot, 'PersistentDownloads'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(sparkleRoot, 'Launcher', 'keep'), 'keep');
  await writeFile(path.join(sparkleRoot, 'PersistentDownloads', 'keep'), 'keep');

  const installed = path.join(home, '_installed', 'Codex.app');
  await createBundle(installed);
  fsHooks.installedFixture = installed;
  registerPlist('/Applications/Codex.app', defaultVersions());

  const targets: string[] = [];
  for (const options of staged) {
    const target = path.join(sparkleRoot, 'Installation', options.name);
    const app = path.join(target, 'Codex.app');
    await createBundle(app);
    registerPlist(app, {
      bundleId: options.bundleId ?? 'com.openai.codex',
      shortVersion: options.shortVersion ?? '3.2.0',
      buildVersion: options.buildVersion ?? '100'
    });
    targets.push(target);
  }
  return {
    home,
    sparkleRoot,
    targets,
    cleanup: async () => rm(home, { recursive: true, force: true })
  };
}

async function createBundle(appPath: string): Promise<void> {
  await mkdir(path.join(appPath, 'Contents'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(appPath, 'Contents', 'Info.plist'), 'synthetic');
  await writeFile(path.join(appPath, 'payload.bin'), 'x'.repeat(4096));
}

function registerPlist(appPath: string, values: PlistValues): void {
  commandHooks.plistValues.set(path.join(appPath, 'Contents', 'Info.plist'), values);
}

function defaultVersions(): PlistValues {
  return {
    bundleId: 'com.openai.codex',
    shortVersion: '3.2.0',
    buildVersion: '100'
  };
}

function translateInstalledPath(target: string): string {
  const fixture = fsHooks.installedFixture;
  if (!target.startsWith('/Applications/Codex.app')) return target;
  if (!fixture) {
    throw Object.assign(new Error('synthetic installed Codex is unavailable'), { code: 'ENOENT' });
  }
  return `${fixture}${target.slice('/Applications/Codex.app'.length)}`;
}

function withUid<T extends object>(value: T, uid: number): T {
  return new Proxy(value, {
    get(target, property) {
      if (property === 'uid') return uid;
      const result: unknown = Reflect.get(target, property, target);
      return typeof result === 'function' ? result.bind(target) : result;
    }
  });
}

function commandResult(overrides: Partial<{
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}> = {}) {
  return {
    code: 0 as number | null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    ...overrides
  };
}
