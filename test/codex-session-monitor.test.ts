import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const fsHooks = vi.hoisted(() => ({
  openCalls: [] as Array<{ target: string; flags: string | number; mode?: number }>,
  failCloseFor: undefined as string | undefined,
  failDirectorySyncs: 0,
  beforeLstatTarget: undefined as ((target: string) => Promise<void>) | undefined,
  statfsCalls: [] as string[],
  statfsError: undefined as Error | undefined
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (target: string) => {
      await fsHooks.beforeLstatTarget?.(target);
      return actual.lstat(target);
    },
    open: async (target: string, flags: string | number, mode?: number) => {
      fsHooks.openCalls.push({ target, flags, mode });
      if (isSessionFilePath(target)) {
        throw new Error('session file content open is forbidden');
      }
      const handle = await actual.open(target, flags, mode);
      if (target === fsHooks.failCloseFor) return withFailingClose(handle);
      if (
        fsHooks.failDirectorySyncs > 0
        && typeof flags === 'number'
        && typeof constants.O_DIRECTORY === 'number'
        && (flags & constants.O_DIRECTORY) === constants.O_DIRECTORY
      ) {
        fsHooks.failDirectorySyncs--;
        return withFailingSync(handle);
      }
      return handle;
    },
    statfs: async (target: string) => {
      fsHooks.statfsCalls.push(target);
      if (fsHooks.statfsError) throw fsHooks.statfsError;
      return actual.statfs(target);
    }
  };
});

import { measureCodexSessionState } from '../src/monitor/codex-sessions.js';
import {
  codexSessionMonitorReportPath,
  codexSessionMonitorStatePath,
  monitorDataDir
} from '../src/paths.js';
import { TOOL_VERSION } from '../src/version.js';

const GIB = 1024 ** 3;

afterEach(() => {
  fsHooks.openCalls.length = 0;
  fsHooks.failCloseFor = undefined;
  fsHooks.failDirectorySyncs = 0;
  fsHooks.beforeLstatTarget = undefined;
  fsHooks.statfsCalls.length = 0;
  fsHooks.statfsError = undefined;
});

describe('measureCodexSessionState', () => {
  test('measures nested metadata manually without opening session files or creating state', async () => {
    const fixture = await makeFixture(['abc', 'hello']);
    try {
      resetFsActivity();

      const result = await measureCodexSessionState({ env: { HOME: fixture.home } });

      expect(result).toEqual({
        schemaVersion: 1,
        toolVersion: TOOL_VERSION,
        command: 'monitor codex-sessions',
        status: 'ok',
        currentBytes: 8,
        thresholdBytes: 8 * GIB,
        growthThresholdBytes: 5 * GIB,
        alert: false,
        statePersisted: false,
        notificationAttempted: false,
        warnings: []
      });
      expect(fsHooks.statfsCalls).toEqual([fixture.home]);
      expect(fsHooks.openCalls.filter(({ target }) => isSessionFilePath(target))).toEqual([]);
      await expect(lstat(monitorDataDir({ HOME: fixture.home }))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.stringify(result)).not.toContain(fixture.home);
    } finally {
      await fixture.cleanup();
    }
  });

  test('reads strict previous private state, computes growth, and injects notification without persisting', async () => {
    const fixture = await makeFixture(['123456789']);
    const sender = vi.fn(async () => true);
    try {
      await writePriorState(fixture.home, {
        totalBytes: 4,
        thresholdBytes: 100,
        growthThresholdBytes: 5,
        lastAlert: false
      });
      const beforeState = await readFile(codexSessionMonitorStatePath({ HOME: fixture.home }), 'utf8');
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        thresholdBytes: 100,
        growthThresholdBytes: 5,
        notify: true,
        notificationSender: sender
      });

      expect(result).toMatchObject({
        status: 'ok',
        currentBytes: 9,
        previousBytes: 4,
        deltaBytes: 5,
        alert: true,
        statePersisted: false,
        notificationAttempted: true,
        notificationDelivered: true,
        warnings: []
      });
      expect(sender).toHaveBeenCalledWith({
        currentBytes: 9,
        previousBytes: 4,
        deltaBytes: 5,
        thresholdBytes: 100,
        growthThresholdBytes: 5,
        measurementComplete: true
      });
      await expect(readFile(codexSessionMonitorStatePath({ HOME: fixture.home }), 'utf8'))
        .resolves.toBe(beforeState);
      await expect(lstat(codexSessionMonitorReportPath({ HOME: fixture.home })))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(fsHooks.openCalls.filter(({ target }) => isSessionFilePath(target))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('persists fixed private state and latest report with durable temporary writes', async () => {
    const fixture = await makeFixture(['12345678']);
    try {
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        thresholdBytes: 8,
        growthThresholdBytes: 5,
        persistState: true
      });

      expect(result).toMatchObject({
        status: 'ok',
        currentBytes: 8,
        alert: true,
        statePersisted: true,
        notificationAttempted: false,
        warnings: []
      });
      const statePath = codexSessionMonitorStatePath({ HOME: fixture.home });
      const reportPath = codexSessionMonitorReportPath({ HOME: fixture.home });
      const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(state).sort()).toEqual([
        'growthThresholdBytes',
        'lastAlert',
        'measuredAt',
        'schemaVersion',
        'thresholdBytes',
        'totalBytes'
      ]);
      expect(state).toMatchObject({
        schemaVersion: 1,
        totalBytes: 8,
        thresholdBytes: 8,
        growthThresholdBytes: 5,
        lastAlert: true,
        measuredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      });
      expect(report).toMatchObject({
        measuredAt: state.measuredAt,
        status: 'ok',
        currentBytes: 8,
        statePersisted: true
      });
      expect(JSON.stringify({ state, report })).not.toContain(fixture.home);
      expect((await lstat(monitorDataDir({ HOME: fixture.home }))).mode & 0o777).toBe(0o700);
      expect((await lstat(statePath)).mode & 0o777).toBe(0o600);
      expect((await lstat(reportPath)).mode & 0o777).toBe(0o600);
      const temporaryCreates = fsHooks.openCalls.filter(({ flags }) => (
        typeof flags === 'number'
        && (flags & constants.O_EXCL) === constants.O_EXCL
      ));
      expect(temporaryCreates).toHaveLength(2);
      expect(temporaryCreates.every(({ flags }) => (
        typeof flags === 'number'
        && (flags & constants.O_NOFOLLOW) === constants.O_NOFOLLOW
      ))).toBe(true);
      expect(fsHooks.openCalls.filter(({ target }) => isSessionFilePath(target))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('does not claim state persistence when the state rename is not durably synced', async () => {
    const fixture = await makeFixture(['abc']);
    try {
      fsHooks.failDirectorySyncs = 1;
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        persistState: true
      });

      expect(result).toMatchObject({
        status: 'partial',
        currentBytes: 3,
        statePersisted: false
      });
      expect(result.warnings).toContain('monitor-state-persist-failed');
      await expect(lstat(codexSessionMonitorStatePath({ HOME: fixture.home }))).resolves.toMatchObject({
        mode: expect.any(Number)
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test('blocks a temporary-file replacement before atomic rename', async () => {
    const fixture = await makeFixture(['abc']);
    let replaced = false;
    try {
      fsHooks.beforeLstatTarget = async (target) => {
        if (
          replaced
          || !target.includes('.codex-sessions-state.v1.json.')
          || !target.endsWith('.tmp')
        ) {
          return;
        }
        replaced = true;
        await rename(target, `${target}.verified-original`);
        await writeFile(target, 'unverified replacement', { mode: 0o600, flag: 'wx' });
      };
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        persistState: true
      });

      expect(replaced).toBe(true);
      expect(result).toMatchObject({
        status: 'partial',
        currentBytes: 3,
        statePersisted: false
      });
      expect(result.warnings).toContain('monitor-state-persist-failed');
      await expect(lstat(codexSessionMonitorStatePath({ HOME: fixture.home })))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('blocks custom CODEX_HOME before scanning or creating monitor state', async () => {
    const fixture = await makeFixture(['private-session']);
    try {
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home, CODEX_HOME: path.join(fixture.home, 'custom') },
        persistState: true,
        notify: true
      });

      expect(result).toMatchObject({
        status: 'blocked',
        currentBytes: 0,
        alert: false,
        statePersisted: false,
        notificationAttempted: false
      });
      expect(result.warnings).toContain('custom-codex-home-unsupported');
      expect(fsHooks.statfsCalls).toEqual([]);
      expect(fsHooks.openCalls).toEqual([]);
      await expect(lstat(monitorDataDir({ HOME: fixture.home }))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.stringify(result)).not.toContain(fixture.home);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    ['zero total', 0, 5],
    ['fractional growth', 8, 1.5],
    ['oversized total', 1024 * GIB + 1, 5]
  ])('blocks invalid thresholds: %s', async (_label, thresholdBytes, growthThresholdBytes) => {
    const fixture = await makeFixture(['abc']);
    try {
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        thresholdBytes,
        growthThresholdBytes,
        persistState: true
      });

      expect(result).toMatchObject({ status: 'blocked', currentBytes: 0, statePersisted: false });
      expect(result.warnings).toEqual(['invalid-monitor-thresholds']);
      expect(fsHooks.statfsCalls).toEqual([]);
      expect(fsHooks.openCalls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('treats a symlinked previous state as untrusted without following it', async () => {
    const fixture = await makeFixture(['abc']);
    const outside = path.join(fixture.home, 'outside-state.json');
    try {
      await mkdir(monitorDataDir({ HOME: fixture.home }), { recursive: true, mode: 0o700 });
      await writeFile(outside, JSON.stringify({ secret: fixture.home }), { mode: 0o600 });
      await symlink(outside, codexSessionMonitorStatePath({ HOME: fixture.home }));
      resetFsActivity();

      const result = await measureCodexSessionState({ env: { HOME: fixture.home } });

      expect(result).toMatchObject({ status: 'partial', currentBytes: 3 });
      expect(result).not.toHaveProperty('previousBytes');
      expect(result.warnings).toContain('monitor-state-untrusted');
      expect(fsHooks.openCalls.some(({ target }) => target === outside)).toBe(false);
      expect(JSON.stringify(result)).not.toContain(fixture.home);
    } finally {
      await fixture.cleanup();
    }
  });

  test('sanitizes invalid prior state instead of exposing its contents', async () => {
    const fixture = await makeFixture(['abc']);
    try {
      await mkdir(monitorDataDir({ HOME: fixture.home }), { recursive: true, mode: 0o700 });
      await writeFile(
        codexSessionMonitorStatePath({ HOME: fixture.home }),
        JSON.stringify({ schemaVersion: 1, leakedPath: fixture.home }),
        { mode: 0o600 }
      );
      resetFsActivity();

      const result = await measureCodexSessionState({ env: { HOME: fixture.home } });

      expect(result).toMatchObject({ status: 'partial', currentBytes: 3 });
      expect(result.warnings).toContain('monitor-state-invalid');
      expect(JSON.stringify(result)).not.toContain(fixture.home);
    } finally {
      await fixture.cleanup();
    }
  });

  test('discards previous state when its verified file handle cannot be closed', async () => {
    const fixture = await makeFixture(['abc']);
    try {
      await writePriorState(fixture.home, {
        totalBytes: 2,
        thresholdBytes: 100,
        growthThresholdBytes: 5,
        lastAlert: false
      });
      fsHooks.failCloseFor = codexSessionMonitorStatePath({ HOME: fixture.home });
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        thresholdBytes: 100,
        growthThresholdBytes: 5
      });

      expect(result).toMatchObject({ status: 'partial', currentBytes: 3 });
      expect(result).not.toHaveProperty('previousBytes');
      expect(result).not.toHaveProperty('deltaBytes');
      expect(result.warnings).toContain('monitor-state-untrusted');
    } finally {
      await fixture.cleanup();
    }
  });

  test('returns partial metadata when statfs is unavailable without losing the byte count', async () => {
    const fixture = await makeFixture(['abc']);
    try {
      fsHooks.statfsError = new Error(`synthetic ${fixture.home}`);
      resetOpenActivityOnly();

      const result = await measureCodexSessionState({ env: { HOME: fixture.home } });

      expect(result).toMatchObject({ status: 'partial', currentBytes: 3, alert: false });
      expect(result.warnings).toContain('volume-metadata-unavailable');
      expect(JSON.stringify(result)).not.toContain(fixture.home);
    } finally {
      await fixture.cleanup();
    }
  });

  test('reports notification failure without persisting or leaking callback errors', async () => {
    const fixture = await makeFixture(['abc']);
    try {
      const sender = vi.fn(async () => {
        throw new Error(`private callback ${fixture.home}`);
      });
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        thresholdBytes: 3,
        growthThresholdBytes: 5,
        notify: true,
        notificationSender: sender
      });

      expect(result).toMatchObject({
        status: 'partial',
        alert: true,
        statePersisted: false,
        notificationAttempted: true,
        notificationDelivered: false
      });
      expect(result.warnings).toContain('notification-failed');
      expect(JSON.stringify(result)).not.toContain(fixture.home);
      await expect(lstat(monitorDataDir({ HOME: fixture.home }))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('keeps a sound lower-bound alert but marks an incomplete measurement for notification', async () => {
    const fixture = await makeFixture(['abc']);
    const outside = path.join(fixture.home, 'outside-lower-bound.jsonl');
    const sender = vi.fn(async () => true);
    try {
      await writeFile(outside, 'unmeasured', { mode: 0o600 });
      await symlink(outside, path.join(fixture.sessions, 'linked-lower-bound.jsonl'));
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        thresholdBytes: 3,
        growthThresholdBytes: 5,
        persistState: true,
        notify: true,
        notificationSender: sender
      });

      expect(result).toMatchObject({
        status: 'partial',
        currentBytes: 3,
        alert: true,
        statePersisted: false,
        notificationAttempted: true,
        notificationDelivered: true
      });
      expect(result.warnings).toEqual(expect.arrayContaining([
        'session-metadata-scan-incomplete',
        'monitor-state-not-updated'
      ]));
      expect(sender).toHaveBeenCalledWith(expect.objectContaining({
        currentBytes: 3,
        measurementComplete: false
      }));
      await expect(lstat(codexSessionMonitorStatePath({ HOME: fixture.home })))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  test('marks a symlinked session entry as incomplete without opening its target', async () => {
    const fixture = await makeFixture(['abc']);
    const outside = path.join(fixture.home, 'outside.jsonl');
    try {
      await writeFile(outside, 'outside-private-content', { mode: 0o600 });
      await symlink(outside, path.join(fixture.sessions, 'linked.jsonl'));
      resetFsActivity();

      const result = await measureCodexSessionState({ env: { HOME: fixture.home } });

      expect(result).toMatchObject({ status: 'partial', currentBytes: 3 });
      expect(result.warnings).toContain('session-metadata-scan-incomplete');
      expect(fsHooks.openCalls.filter(({ target }) => isSessionFilePath(target))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('refuses persistence when the private app directory exposes group/other permissions', async () => {
    const fixture = await makeFixture(['abc']);
    try {
      await mkdir(path.join(fixture.home, '.ai-dev-maintenance'), { mode: 0o755 });
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        persistState: true
      });

      expect(result).toMatchObject({ status: 'partial', currentBytes: 3, statePersisted: false });
      expect(result.warnings).toContain('monitor-state-persist-failed');
      await expect(lstat(codexSessionMonitorStatePath({ HOME: fixture.home })))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await chmod(path.join(fixture.home, '.ai-dev-maintenance'), 0o700).catch(() => undefined);
      await fixture.cleanup();
    }
  });

  test('rejects an owner-only monitor directory unless its mode is exactly 0700', async () => {
    const fixture = await makeFixture(['abc']);
    try {
      await writePriorState(fixture.home, {
        totalBytes: 2,
        thresholdBytes: 100,
        growthThresholdBytes: 5,
        lastAlert: false
      });
      await chmod(monitorDataDir({ HOME: fixture.home }), 0o500);
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        thresholdBytes: 100,
        growthThresholdBytes: 5
      });

      expect(result).toMatchObject({ status: 'partial', currentBytes: 3 });
      expect(result).not.toHaveProperty('previousBytes');
      expect(result.warnings).toContain('monitor-state-untrusted');
    } finally {
      await chmod(monitorDataDir({ HOME: fixture.home }), 0o700).catch(() => undefined);
      await fixture.cleanup();
    }
  });

  test('does not alert on negative growth when the total stays below threshold', async () => {
    const fixture = await makeFixture(['abc']);
    try {
      await writePriorState(fixture.home, {
        totalBytes: 9,
        thresholdBytes: 100,
        growthThresholdBytes: 5,
        lastAlert: false
      });
      resetFsActivity();

      const result = await measureCodexSessionState({
        env: { HOME: fixture.home },
        thresholdBytes: 100,
        growthThresholdBytes: 5
      });

      expect(result).toMatchObject({
        status: 'ok',
        currentBytes: 3,
        previousBytes: 9,
        deltaBytes: -6,
        alert: false
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

type Fixture = {
  home: string;
  sessions: string;
  cleanup(): Promise<void>;
};

async function makeFixture(contents: string[]): Promise<Fixture> {
  const created = await mkdtemp(path.join(os.tmpdir(), 'aidm-monitor-home-'));
  const home = await realpath(created);
  const sessions = path.join(home, '.codex', 'sessions', '2026', '08', '25');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  for (const [index, content] of contents.entries()) {
    await writeFile(path.join(sessions, `session-${index}.jsonl`), content, { mode: 0o600 });
  }
  resetFsActivity();
  return {
    home,
    sessions,
    cleanup: async () => rm(home, { recursive: true, force: true })
  };
}

async function writePriorState(
  home: string,
  state: {
    totalBytes: number;
    thresholdBytes: number;
    growthThresholdBytes: number;
    lastAlert: boolean;
  }
): Promise<void> {
  await mkdir(monitorDataDir({ HOME: home }), { recursive: true, mode: 0o700 });
  await writeFile(
    codexSessionMonitorStatePath({ HOME: home }),
    `${JSON.stringify({
      schemaVersion: 1,
      measuredAt: '2026-08-01T04:30:00.000Z',
      ...state
    })}\n`,
    { mode: 0o600 }
  );
}

function resetFsActivity(): void {
  fsHooks.openCalls.length = 0;
  fsHooks.statfsCalls.length = 0;
}

function resetOpenActivityOnly(): void {
  fsHooks.openCalls.length = 0;
}

function isSessionFilePath(target: string): boolean {
  return target.endsWith('.jsonl') || target.endsWith('.jsonl.zst');
}

function withFailingClose(value: FileHandle): FileHandle {
  return new Proxy(value, {
    get(target, property) {
      if (property === 'close') {
        return async () => {
          await target.close();
          throw new Error('synthetic state close failure');
        };
      }
      const result: unknown = Reflect.get(target, property, target);
      return typeof result === 'function' ? result.bind(target) : result;
    }
  });
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
