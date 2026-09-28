import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { collectFileIdentity } from '../src/fs-safety.js';
import type { FileIdentity } from '../src/types.js';

// These cases exercise macOS-only behavior; the unsupported-platform cases still run everywhere.
const macTest = process.platform === 'darwin' ? test : test.skip;

const GIB = 1024 ** 3;

const commandHooks = vi.hoisted(() => ({
  calls: [] as Array<{
    command: string;
    args: string[];
    options: Record<string, unknown> | undefined;
  }>,
  trustedCalls: [] as string[],
  trustedFailures: new Set<string>(),
  psResult: {
    code: 0 as number | null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false
  },
  lsofResults: [] as Array<{
    code: number | null;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    timedOut: boolean;
  }>
}));

const statfsHooks = vi.hoisted(() => ({
  calls: [] as string[],
  error: undefined as Error | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
  result: {
    bsize: 4096,
    blocks: 4_000_000,
    bfree: 3_000_000,
    bavail: (10 * 1024 ** 3) / 4096
  }
}));

vi.mock('../src/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/commands.js')>();
  return {
    ...actual,
    trustedCommandPath: async (name: string) => {
      commandHooks.trustedCalls.push(name);
      if (commandHooks.trustedFailures.has(name)) throw new Error('synthetic trust failure');
      return `/mock/${name}`;
    },
    runCommand: async (
      command: string,
      args: string[],
      options?: Record<string, unknown>
    ) => {
      commandHooks.calls.push({ command, args: [...args], options });
      if (command === '/mock/ps') return { ...commandHooks.psResult };
      if (command === '/mock/lsof') {
        return commandHooks.lsofResults.shift() ?? commandResult({ code: 1 });
      }
      throw new Error('unexpected synthetic command');
    }
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    statfs: async (target: string) => {
      statfsHooks.calls.push(target);
      if (statfsHooks.error) throw statfsHooks.error;
      await statfsHooks.afterRead?.();
      return { ...statfsHooks.result };
    }
  };
});

import { preflightCodexSessionMutation } from '../src/reclaim/codex-preflight.js';

afterEach(() => {
  commandHooks.calls.length = 0;
  commandHooks.trustedCalls.length = 0;
  commandHooks.trustedFailures.clear();
  commandHooks.psResult = commandResult();
  commandHooks.lsofResults.length = 0;
  statfsHooks.calls.length = 0;
  statfsHooks.error = undefined;
  statfsHooks.afterRead = undefined;
  statfsHooks.result = {
    bsize: 4096,
    blocks: 4_000_000,
    bfree: 3_000_000,
    bavail: (10 * GIB) / 4096
  };
});

describe('preflightCodexSessionMutation', () => {
  macTest('allows a fully safe closed target with sufficient temporary space', async () => {
    const fixture = await makeFixture();
    try {
      const result = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 256 * 1024 ** 2,
        processList: ''
      });

      expect(result).toEqual({
        allowed: true,
        blockedReasons: [],
        availableBytes: 10 * GIB,
        requiredTemporaryBytes: 256 * 1024 ** 2
      });
      expect(commandHooks.trustedCalls).toEqual(['lsof']);
      expect(statfsHooks.calls).toEqual([fixture.sessions]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('blocks unsupported platforms even when an unexpected option claims darwin', async () => {
    const fixture = await makeFixture();
    try {
      const bypassAttempt = {
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1,
        processList: '',
        platform: 'darwin' as NodeJS.Platform
      };
      const result = await withProcessPlatform('linux', () =>
        preflightCodexSessionMutation(bypassAttempt)
      );

      expect(result).toMatchObject({
        allowed: false,
        blockedReasons: ['platform-unsupported'],
        requiredTemporaryBytes: 1
      });
      expect(commandHooks.calls).toEqual([]);
      expect(statfsHooks.calls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks custom CODEX_HOME and an empty target set before external checks', async () => {
    const fixture = await makeFixture();
    try {
      const custom = await preflightCodexSessionMutation({
        env: { HOME: fixture.home, CODEX_HOME: path.join(fixture.home, 'custom') },
        targets: fixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });
      const empty = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: [],
        requiredTemporaryBytes: 1,
        processList: ''
      });

      expect(custom.blockedReasons).toEqual(['custom-codex-home-unsupported']);
      expect(empty.blockedReasons).toEqual(['no-targets']);
      expect(commandHooks.calls).toEqual([]);
      expect(statfsHooks.calls).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks Codex GUI, Helper, and CLI process lines', async () => {
    const fixture = await makeFixture();
    const processLists = [
      '101 /Applications/Codex.app/Contents/MacOS/Codex --started-from-launchd',
      '102 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=renderer',
      '103 /usr/local/bin/codex codex resume'
    ];
    try {
      for (const processList of processLists) {
        const result = await preflightCodexSessionMutation({
          env: { HOME: fixture.home },
          targets: fixture.targets,
          requiredTemporaryBytes: 1,
          processList
        });
        expect(result.blockedReasons).toContain('codex-process-running');
      }
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks unusable and truncated process discovery with bounded output', async () => {
    const fixture = await makeFixture();
    try {
      commandHooks.psResult = commandResult({ stdoutTruncated: true });
      const truncated = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1
      });
      commandHooks.psResult = commandResult({ code: 2, stderr: '/private/raw/process/error' });
      const unusable = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1
      });
      commandHooks.psResult = commandResult({ stdout: 'malformed output without a pid' });
      const malformed = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1
      });
      commandHooks.psResult = commandResult({
        stdout: `${process.pid} /usr/bin/node aidm\nmalformed-record-with-codex`
      });
      const partiallyMalformed = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1
      });

      expect(truncated.blockedReasons).toContain('process-check-unavailable');
      expect(unusable.blockedReasons).toContain('process-check-unavailable');
      expect(malformed.blockedReasons).toContain('process-check-unavailable');
      expect(partiallyMalformed.blockedReasons).toContain('process-check-unavailable');
      expect(JSON.stringify(unusable)).not.toContain('/private/raw');
      const psCalls = commandHooks.calls.filter((call) => call.command === '/mock/ps');
      expect(psCalls).toHaveLength(4);
      for (const call of psCalls) {
        expect(call.options).toMatchObject({
          timeoutMs: 5_000,
          maxStdoutBytes: expect.any(Number),
          maxStderrBytes: expect.any(Number)
        });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks unusable lsof and any reported target handle without exposing output', async () => {
    const fixture = await makeFixture();
    try {
      commandHooks.lsofResults.push(commandResult({
        code: 2,
        stderr: `/private/raw ${fixture.targets[0].path}: permission denied`
      }));
      const unusable = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });
      commandHooks.lsofResults.push(commandResult({
        code: 0,
        stdout: `p123\ncnode\nn${fixture.targets[0].path}\n`
      }));
      const open = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });

      expect(unusable.blockedReasons).toContain('open-handle-check-unavailable');
      expect(open.blockedReasons).toContain('target-open');
      expect(JSON.stringify(unusable)).not.toContain(fixture.home);
      expect(JSON.stringify(open)).not.toContain(fixture.home);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('treats lsof missing-path diagnostics as unusable for a mutation preflight', async () => {
    const fixture = await makeFixture();
    try {
      commandHooks.lsofResults.push(commandResult({
        code: 1,
        stderr: `lsof: status error on ${fixture.targets[0].path}: No such file or directory`
      }));

      const result = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });

      expect(result.allowed).toBe(false);
      expect(result.blockedReasons).toEqual(['open-handle-check-unavailable']);
      expect(JSON.stringify(result)).not.toContain(fixture.home);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('batches many lsof targets without omitting or duplicating a path', async () => {
    const fixture = await makeFixture(65);
    try {
      const result = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });

      expect(result.allowed).toBe(true);
      const lsofCalls = commandHooks.calls.filter((call) => call.command === '/mock/lsof');
      expect(lsofCalls).toHaveLength(2);
      expect(lsofCalls.flatMap((call) => call.args.slice(2))).toEqual(
        fixture.targets.map((target) => target.path)
      );
      for (const call of lsofCalls) {
        expect(call.args.length - 2).toBeLessThanOrEqual(64);
        expect(call.args.reduce(
          (bytes, argument) => bytes + Buffer.byteLength(argument) + 1,
          Buffer.byteLength(call.command) + 1
        )).toBeLessThanOrEqual(32 * 1024);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks identity drift and compressed sibling state', async () => {
    const driftFixture = await makeFixture();
    const compressedFixture = await makeFixture();
    try {
      await writeFile(driftFixture.targets[0].path, 'changed-size');
      const drift = await preflightCodexSessionMutation({
        env: { HOME: driftFixture.home },
        targets: driftFixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });
      await writeFile(`${compressedFixture.targets[0].path}.zst`, 'compressed');
      const compressed = await preflightCodexSessionMutation({
        env: { HOME: compressedFixture.home },
        targets: compressedFixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });

      expect(drift.blockedReasons).toContain('target-identity-changed');
      expect(compressed.blockedReasons).toContain('compressed-session-state');
    } finally {
      await driftFixture.cleanup();
      await compressedFixture.cleanup();
    }
  });

  macTest('blocks unsafe target mode, owner, hardlink, and symlink', async () => {
    const cases: Array<(fixture: PreflightFixture) => Promise<void>> = [
      async (fixture) => chmod(fixture.targets[0].path, 0o666),
      async (fixture) => {
        fixture.targets[0].identity.uid = (process.getuid?.() ?? 500) + 1;
      },
      async (fixture) => {
        await link(fixture.targets[0].path, `${fixture.targets[0].path}.hardlink`);
      },
      async (fixture) => {
        const saved = `${fixture.targets[0].path}.saved`;
        await rename(fixture.targets[0].path, saved);
        await symlink(saved, fixture.targets[0].path);
      }
    ];

    for (const mutate of cases) {
      const fixture = await makeFixture();
      try {
        await mutate(fixture);
        const result = await preflightCodexSessionMutation({
          env: { HOME: fixture.home },
          targets: fixture.targets,
          requiredTemporaryBytes: 1,
          processList: ''
        });
        expect(result.blockedReasons).toContain('unsafe-target');
      } finally {
        await fixture.cleanup();
      }
    }
  });

  macTest('requires both five GiB available and the temporary result plus one GiB', async () => {
    const fixture = await makeFixture();
    try {
      statfsHooks.result.bavail = (4 * GIB) / statfsHooks.result.bsize;
      const belowFloor = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });
      statfsHooks.result.bavail = (6 * GIB) / statfsHooks.result.bsize;
      const belowReserve = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 5.5 * GIB,
        processList: ''
      });

      expect(belowFloor.blockedReasons).toContain('insufficient-free-space');
      expect(belowReserve.blockedReasons).toContain('insufficient-free-space');
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks when free-space measurement is unavailable', async () => {
    const fixture = await makeFixture();
    try {
      statfsHooks.error = new Error('synthetic statfs failure');
      const result = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });

      expect(result).toEqual({
        allowed: false,
        blockedReasons: ['free-space-check-unavailable'],
        requiredTemporaryBytes: 1
      });
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('revalidates the default Codex root after external checks', async () => {
    const fixture = await makeFixture();
    try {
      statfsHooks.afterRead = async () => {
        await chmod(path.join(fixture.home, '.codex'), 0o777);
      };
      const result = await preflightCodexSessionMutation({
        env: { HOME: fixture.home },
        targets: fixture.targets,
        requiredTemporaryBytes: 1,
        processList: ''
      });

      expect(result.allowed).toBe(false);
      expect(result.blockedReasons).toContain('unsafe-target');
    } finally {
      await fixture.cleanup();
    }
  });
});

type PreflightFixture = {
  home: string;
  sessions: string;
  targets: Array<{ path: string; identity: FileIdentity }>;
  cleanup(): Promise<void>;
};

async function makeFixture(count = 1): Promise<PreflightFixture> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-codex-preflight-'));
  const sessions = path.join(home, '.codex', 'sessions');
  await mkdir(path.join(sessions, '2026', '01'), { recursive: true, mode: 0o700 });
  const targets: PreflightFixture['targets'] = [];
  for (let index = 0; index < count; index += 1) {
    const file = path.join(sessions, '2026', '01', `rollout-${String(index).padStart(3, '0')}.jsonl`);
    await writeFile(file, '{"value":1}\n', { mode: 0o600 });
    targets.push({
      path: file,
      identity: await collectFileIdentity(file, '<home>/.codex/sessions/<session-file>')
    });
  }
  return {
    home,
    sessions,
    targets,
    cleanup: () => rm(home, { recursive: true, force: true })
  };
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

async function withProcessPlatform<T>(
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
