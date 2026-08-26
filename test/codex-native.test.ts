import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const BUNDLED_CODEX = '/Applications/Codex.app/Contents/Resources/codex';
const SUPPORTED_OUTPUT = 'local_thread_store_compression  under development  false\n';

const commandHooks = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; options?: Record<string, unknown> }>,
  result: commandResult({
    stdout: 'local_thread_store_compression  under development  false\n'
  }),
  beforeReturn: undefined as (() => Promise<void>) | undefined
}));

const fsHooks = vi.hoisted(() => ({
  bundledFixture: undefined as string | undefined,
  beforeOpendir: undefined as ((target: string) => Promise<void>) | undefined,
  failCloseFor: undefined as string | undefined,
  openCalls: [] as string[],
  opendirCalls: [] as string[],
  readCalls: [] as string[],
  writeCalls: [] as string[]
}));

vi.mock('../src/commands.js', () => ({
  runCommand: async (
    command: string,
    args: string[],
    options?: Record<string, unknown>
  ) => {
    commandHooks.calls.push({ command, args: [...args], options });
    await commandHooks.beforeReturn?.();
    return { ...commandHooks.result };
  }
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (target: string) => {
      const translated = translateBundledPath(target);
      const stats = await actual.lstat(translated);
      return target === BUNDLED_CODEX ? withUid(stats, 0) : stats;
    },
    realpath: async (target: string) => {
      const translated = translateBundledPath(target);
      const resolved = await actual.realpath(translated);
      return target === BUNDLED_CODEX ? target : resolved;
    },
    open: async (target: string, flags: string | number, mode?: number) => {
      fsHooks.openCalls.push(target);
      const handle = await actual.open(translateBundledPath(target), flags, mode);
      return target === BUNDLED_CODEX ? withFileHandleUid(handle, 0) : handle;
    },
    opendir: async (target: string) => {
      fsHooks.opendirCalls.push(target);
      await fsHooks.beforeOpendir?.(target);
      const handle = await actual.opendir(target);
      return target === fsHooks.failCloseFor ? withFailingClose(handle) : handle;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      fsHooks.readCalls.push(String(args[0]));
      return actual.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      fsHooks.writeCalls.push(String(args[0]));
      return actual.writeFile(...args);
    }
  };
});

import { inspectCodexNativeCompression } from '../src/reclaim/codex-native.js';
import { TOOL_VERSION } from '../src/version.js';

afterEach(() => {
  commandHooks.calls.length = 0;
  commandHooks.result = commandResult({ stdout: SUPPORTED_OUTPUT });
  commandHooks.beforeReturn = undefined;
  fsHooks.bundledFixture = undefined;
  fsHooks.beforeOpendir = undefined;
  fsHooks.failCloseFor = undefined;
  resetFsActivity();
});

describe('inspectCodexNativeCompression', () => {
  test('reports the exact bundled feature row and counts extensions without opening sessions', async () => {
    const fixture = await makeFixture();
    try {
      fsHooks.bundledFixture = fixture.executable;
      resetFsActivity();

      const result = await inspectCodexNativeCompression({ env: { HOME: fixture.home } });

      expect(result).toEqual({
        schemaVersion: 1,
        toolVersion: TOOL_VERSION,
        command: 'reclaim status codex-native-compression',
        status: 'ok',
        supported: true,
        featureStage: 'under development',
        defaultEnabled: false,
        configuredState: 'unknown',
        plainJsonlFiles: 2,
        compressedJsonlFiles: 1,
        warnings: [],
        nextActions: [
          'Prune eligible session images before enabling native compression.',
          'Use the official Codex CLI to manage this feature; AIDM will not edit configuration.'
        ]
      });
      expect(commandHooks.calls).toHaveLength(1);
      expect(commandHooks.calls[0]).toMatchObject({
        args: ['features', 'list'],
        options: {
          timeoutMs: 5_000,
          maxStdoutBytes: 256 * 1024,
          maxStderrBytes: 16 * 1024
        }
      });
      expect(commandHooks.calls[0]?.command).not.toBe(BUNDLED_CODEX);
      expect(path.basename(commandHooks.calls[0]?.command ?? '')).toBe('codex-snapshot');
      expect(commandHooks.calls[0]?.options).not.toHaveProperty('env');
      expect(fsHooks.openCalls).toContain(BUNDLED_CODEX);
      expect(fsHooks.openCalls.filter(isSessionFilePath)).toEqual([]);
      expect(fsHooks.readCalls).toEqual([]);
      expect(fsHooks.writeCalls).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(fixture.home);
      expect(JSON.stringify(result)).not.toContain(BUNDLED_CODEX);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    ['missing executable', 'missing'],
    ['group/other writable executable', 'untrusted']
  ])('returns unsupported for a %s', async (_label, variant) => {
    const fixture = await makeFixture();
    try {
      const executable = variant === 'missing'
        ? path.join(fixture.home, 'missing-codex')
        : fixture.executable;
      if (variant === 'untrusted') await chmod(executable, 0o722);
      resetFsActivity();

      const result = await inspectCodexNativeCompression({
        env: { HOME: fixture.home },
        codexExecutable: executable,
        featureOutput: SUPPORTED_OUTPUT
      });

      expect(result).toMatchObject({ status: 'unsupported', supported: false });
      expect(result.warnings).toContain('codex-executable-untrusted');
      expect(commandHooks.calls).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(executable);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    ['malformed row', 'local_thread_store_compression under development false\n', 'partial'],
    ['duplicate row', `${SUPPORTED_OUTPUT}${SUPPORTED_OUTPUT}`, 'partial'],
    ['absent row', 'another_feature  stable  true\n', 'unsupported']
  ])('fails closed for %s', async (_label, featureOutput, status) => {
    const fixture = await makeFixture();
    try {
      resetFsActivity();
      const result = await inspectCodexNativeCompression({
        env: { HOME: fixture.home },
        codexExecutable: fixture.executable,
        featureOutput
      });

      expect(result.status).toBe(status);
      expect(result.supported).toBe(false);
      expect(result).not.toHaveProperty('featureStage');
      expect(result).not.toHaveProperty('defaultEnabled');
      expect(JSON.stringify(result)).not.toContain(featureOutput.trim());
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    ['nonzero', commandResult({ code: 1, stdout: `private ${os.homedir()}` })],
    ['stdout truncated', commandResult({ stdout: SUPPORTED_OUTPUT, stdoutTruncated: true })],
    ['stderr truncated', commandResult({ stdout: SUPPORTED_OUTPUT, stderrTruncated: true })],
    ['timed out', commandResult({ stdout: SUPPORTED_OUTPUT, timedOut: true })]
  ])('returns sanitized partial output when the command is %s', async (_label, commandResult_) => {
    const fixture = await makeFixture();
    try {
      commandHooks.result = commandResult_;
      resetFsActivity();

      const result = await inspectCodexNativeCompression({
        env: { HOME: fixture.home },
        codexExecutable: fixture.executable
      });

      expect(result).toMatchObject({ status: 'partial', supported: false });
      expect(result.warnings).toContain('native-feature-check-unavailable');
      expect(JSON.stringify(result)).not.toContain(os.homedir());
      expect(JSON.stringify(result)).not.toContain(commandResult_.stdout);
    } finally {
      await fixture.cleanup();
    }
  });

  test('keeps a successful stderr diagnostic sanitized and never treats defaults as configured state', async () => {
    const fixture = await makeFixture();
    try {
      commandHooks.result = commandResult({
        stdout: 'local_thread_store_compression  stable  true\n',
        stderr: `warning about ${fixture.home}/config.toml and secret-token`
      });
      resetFsActivity();

      const result = await inspectCodexNativeCompression({
        env: { HOME: fixture.home },
        codexExecutable: fixture.executable
      });

      expect(result).toMatchObject({
        status: 'partial',
        supported: true,
        featureStage: 'stable',
        defaultEnabled: true,
        configuredState: 'unknown',
        warnings: ['native-feature-command-stderr']
      });
      expect(JSON.stringify(result)).not.toContain(fixture.home);
      expect(JSON.stringify(result)).not.toContain('secret-token');
      expect(fsHooks.readCalls.some((item) => item.endsWith('config.toml'))).toBe(false);
      expect(fsHooks.writeCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('detects executable identity drift across the feature command', async () => {
    const fixture = await makeFixture();
    try {
      commandHooks.beforeReturn = async () => chmod(fixture.executable, 0o722);
      resetFsActivity();

      const result = await inspectCodexNativeCompression({
        env: { HOME: fixture.home },
        codexExecutable: fixture.executable
      });

      expect(result).toMatchObject({ status: 'partial', supported: false });
      expect(result.warnings).toContain('codex-executable-drift');
      expect(commandHooks.calls[0]?.command).not.toBe(fixture.executable);
      expect(path.basename(commandHooks.calls[0]?.command ?? '')).toBe('codex-snapshot');
    } finally {
      await fixture.cleanup();
    }
  });

  test('keeps custom CODEX_HOME out of metadata enumeration', async () => {
    const fixture = await makeFixture();
    const custom = path.join(fixture.home, 'custom-codex-home');
    try {
      await mkdir(path.join(custom, 'sessions'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(custom, 'sessions', 'private.jsonl'), 'must-not-be-opened');
      resetFsActivity();

      const result = await inspectCodexNativeCompression({
        env: { HOME: fixture.home, CODEX_HOME: custom },
        codexExecutable: fixture.executable,
        featureOutput: SUPPORTED_OUTPUT
      });

      expect(result).toMatchObject({
        status: 'partial',
        supported: true,
        plainJsonlFiles: 0,
        compressedJsonlFiles: 0
      });
      expect(result.warnings).toContain('custom-codex-home-unsupported');
      expect(fsHooks.openCalls).toEqual([]);
      expect(fsHooks.readCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('marks a symlinked session entry as an incomplete metadata scan without following it', async () => {
    const fixture = await makeFixture();
    try {
      await symlink(fixture.executable, path.join(fixture.sessions, 'linked.jsonl'));
      resetFsActivity();

      const result = await inspectCodexNativeCompression({
        env: { HOME: fixture.home },
        codexExecutable: fixture.executable,
        featureOutput: SUPPORTED_OUTPUT
      });

      expect(result).toMatchObject({
        status: 'partial',
        supported: true,
        plainJsonlFiles: 2,
        compressedJsonlFiles: 1
      });
      expect(result.warnings).toContain('session-metadata-scan-incomplete');
      expect(fsHooks.openCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('does not enumerate a directory replaced by a symlink immediately before opening it', async () => {
    const fixture = await makeFixture();
    const year = path.join(fixture.sessions, '2026');
    const originalYear = path.join(fixture.sessions, 'original-year');
    const outside = path.join(fixture.home, 'outside');
    try {
      await mkdir(outside, { mode: 0o700 });
      await writeFile(path.join(outside, 'outside.jsonl'), '{}\n', { mode: 0o600 });
      let replaced = false;
      fsHooks.beforeOpendir = async (target) => {
        if (target !== year || replaced) return;
        replaced = true;
        await rename(year, originalYear);
        await symlink(outside, year);
      };
      resetFsActivity();

      const result = await inspectCodexNativeCompression({
        env: { HOME: fixture.home },
        codexExecutable: fixture.executable,
        featureOutput: SUPPORTED_OUTPUT
      });

      expect(replaced).toBe(true);
      expect(result).toMatchObject({
        status: 'partial',
        supported: true,
        plainJsonlFiles: 0,
        compressedJsonlFiles: 0
      });
      expect(result.warnings).toContain('session-metadata-scan-incomplete');
      expect(fsHooks.openCalls.filter(isSessionFilePath)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('reports an incomplete scan when a directory handle cannot be closed', async () => {
    const fixture = await makeFixture();
    try {
      fsHooks.failCloseFor = fixture.sessions;
      resetFsActivity();

      const result = await inspectCodexNativeCompression({
        env: { HOME: fixture.home },
        codexExecutable: fixture.executable,
        featureOutput: SUPPORTED_OUTPUT
      });

      expect(result).toMatchObject({
        status: 'partial',
        supported: true,
        plainJsonlFiles: 0,
        compressedJsonlFiles: 0
      });
      expect(result.warnings).toContain('session-metadata-scan-incomplete');
    } finally {
      await fixture.cleanup();
    }
  });
});

type Fixture = {
  home: string;
  executable: string;
  sessions: string;
  cleanup(): Promise<void>;
};

async function makeFixture(): Promise<Fixture> {
  const created = await mkdtemp(path.join(os.tmpdir(), 'aidm-native-home-'));
  const home = await realpath(created);
  const sessions = path.join(home, '.codex', 'sessions');
  const day = path.join(sessions, '2026', '08', '25');
  await mkdir(day, { recursive: true, mode: 0o700 });
  await writeFile(path.join(day, 'one.jsonl'), '{}\n', { mode: 0o600 });
  await writeFile(path.join(day, 'two.jsonl'), '{}\n', { mode: 0o600 });
  await writeFile(path.join(day, 'old.jsonl.zst'), 'synthetic', { mode: 0o600 });
  await writeFile(path.join(day, 'ignore.txt'), 'synthetic', { mode: 0o600 });
  const executable = path.join(home, 'synthetic-codex');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  resetFsActivity();
  return {
    home,
    executable,
    sessions,
    cleanup: async () => rm(home, { recursive: true, force: true })
  };
}

function resetFsActivity(): void {
  fsHooks.openCalls.length = 0;
  fsHooks.opendirCalls.length = 0;
  fsHooks.readCalls.length = 0;
  fsHooks.writeCalls.length = 0;
}

function isSessionFilePath(target: string): boolean {
  return target.endsWith('.jsonl') || target.endsWith('.jsonl.zst');
}

function translateBundledPath(target: string): string {
  if (target !== BUNDLED_CODEX) return target;
  if (!fsHooks.bundledFixture) {
    throw Object.assign(new Error('synthetic bundled Codex unavailable'), { code: 'ENOENT' });
  }
  return fsHooks.bundledFixture;
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

function withFileHandleUid(value: FileHandle, uid: number): FileHandle {
  return new Proxy(value, {
    get(target, property) {
      if (property === 'stat') return async () => withUid(await target.stat(), uid);
      const result: unknown = Reflect.get(target, property, target);
      return typeof result === 'function' ? result.bind(target) : result;
    }
  });
}

function withFailingClose(value: Dir): Dir {
  return new Proxy(value, {
    get(target, property) {
      if (property === 'close') {
        return async () => {
          await target.close();
          throw new Error('synthetic directory close failure');
        };
      }
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
