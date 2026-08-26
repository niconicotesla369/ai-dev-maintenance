import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { collectFileIdentity } from '../src/fs-safety.js';

const preflightHooks = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  beforeReturn: undefined as (() => Promise<void>) | undefined,
  result: {
    allowed: true,
    blockedReasons: [] as string[],
    availableBytes: 10 * 1024 ** 3,
    requiredTemporaryBytes: 0
  }
}));

const manifestHooks = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  attempted: [] as Array<Record<string, unknown>>,
  persisted: [] as Array<Record<string, unknown>>,
  failRecordType: undefined as string | undefined,
  failed: false,
  onAppend: undefined as ((record: Record<string, unknown>) => Promise<void>) | undefined
}));

const fsHooks = vi.hoisted(() => ({
  openCalls: [] as Array<{ filePath: string; flags: string | number; mode?: number }>,
  renameCalls: [] as Array<{ from: string; to: string }>,
  afterRenameContent: undefined as string | undefined,
  tempReadOpens: 0,
  mutateSourceOnTempRead: undefined as { sourcePath: string; content: string } | undefined,
  swapTemporaryAfterLstat: undefined as { content: string; swappedPath?: string } | undefined
}));

const formatHooks = vi.hoisted(() => ({
  corruptToken: undefined as string | undefined,
  corruptPlaceholder: false
}));

vi.mock('../src/reclaim/codex-preflight.js', () => ({
  preflightCodexSessionMutation: async (options: Record<string, unknown>) => {
    preflightHooks.calls.push(options);
    if (preflightHooks.calls.length === 1) await preflightHooks.beforeReturn?.();
    return {
      ...preflightHooks.result,
      requiredTemporaryBytes: options.requiredTemporaryBytes as number
    };
  }
}));

vi.mock('../src/reclaim/session-image-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reclaim/session-image-manifest.js')>();
  return {
    ...actual,
    createSessionImageManifest: async (options: Record<string, unknown>) => {
      manifestHooks.createCalls.push(options);
      const writer = await actual.createSessionImageManifest(options as {
        env?: NodeJS.ProcessEnv;
        planId: string;
      });
      return {
        path: writer.path,
        append: async (record: Record<string, unknown>) => {
          manifestHooks.attempted.push(record);
          await manifestHooks.onAppend?.(record);
          if (manifestHooks.failed || record.recordType === manifestHooks.failRecordType) {
            manifestHooks.failed = true;
            throw new Error('/private/manifest/path and raw payload must not escape');
          }
          await writer.append(record as import('../src/reclaim/session-image-manifest.js').SessionImageManifestRecord);
          manifestHooks.persisted.push(record);
        }
      };
    }
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (filePath: string, flags: string | number, mode?: number) => {
      fsHooks.openCalls.push({ filePath, flags, mode });
      const handle = await actual.open(filePath, flags, mode);
      if (
        filePath.includes('.aidm-session-image-')
        && (Number(flags) & constants.O_CREAT) === 0
      ) {
        fsHooks.tempReadOpens += 1;
        if (fsHooks.mutateSourceOnTempRead && fsHooks.tempReadOpens === 2) {
          const mutation = fsHooks.mutateSourceOnTempRead;
          fsHooks.mutateSourceOnTempRead = undefined;
          await actual.writeFile(mutation.sourcePath, mutation.content);
        }
      }
      return handle;
    },
    lstat: async (filePath: string) => {
      const info = await actual.lstat(filePath);
      if (fsHooks.swapTemporaryAfterLstat && filePath.includes('.aidm-session-image-')) {
        const swap = fsHooks.swapTemporaryAfterLstat;
        fsHooks.swapTemporaryAfterLstat = undefined;
        await actual.unlink(filePath);
        await actual.writeFile(filePath, swap.content, { mode: 0o600, flag: 'wx' });
        swap.swappedPath = filePath;
      }
      return info;
    },
    rename: async (from: string, to: string) => {
      fsHooks.renameCalls.push({ from, to });
      await actual.rename(from, to);
      if (fsHooks.afterRenameContent !== undefined) {
        await actual.writeFile(to, fsHooks.afterRenameContent);
      }
    }
  };
});

vi.mock('../src/reclaim/session-image-format.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reclaim/session-image-format.js')>();
  return {
    ...actual,
    rewriteSessionImageLine: (
      line: string,
      analysis: import('../src/reclaim/session-image-format.js').SessionImageLineAnalysis
    ) => {
      const rewritten = actual.rewriteSessionImageLine(line, analysis);
      const token = formatHooks.corruptToken;
      if (!token || rewritten.imagesStripped === 0 || !rewritten.output.includes(token)) {
        if (!formatHooks.corruptPlaceholder || rewritten.imagesStripped === 0) return rewritten;
        const placeholder = actual.SESSION_IMAGE_PLACEHOLDER_PAYLOAD;
        const replacement = `${placeholder[0] === 'A' ? 'B' : 'A'}${placeholder.slice(1)}`;
        return { ...rewritten, output: rewritten.output.replace(placeholder, replacement) };
      }
      return {
        ...rewritten,
        output: rewritten.output.replace(token, 'tamper'.slice(0, token.length))
      };
    }
  };
});

import {
  pruneCodexSessionImages,
  type CodexSessionImagePruneResult
} from '../src/reclaim/codex-session-image-prune.js';
import {
  type CodexSessionImageCandidate,
  type CodexSessionImagePrivateOutcome
} from '../src/reclaim/codex-session-images.js';
import { readJsonlLines } from '../src/reclaim/jsonl-stream.js';
import {
  analyzeSessionImageLine,
  rewriteSessionImageLine,
  SESSION_IMAGE_PLACEHOLDER_URL
} from '../src/reclaim/session-image-format.js';

afterEach(() => {
  preflightHooks.calls.length = 0;
  preflightHooks.beforeReturn = undefined;
  preflightHooks.result = {
    allowed: true,
    blockedReasons: [],
    availableBytes: 10 * 1024 ** 3,
    requiredTemporaryBytes: 0
  };
  manifestHooks.createCalls.length = 0;
  manifestHooks.attempted.length = 0;
  manifestHooks.persisted.length = 0;
  manifestHooks.failRecordType = undefined;
  manifestHooks.failed = false;
  manifestHooks.onAppend = undefined;
  fsHooks.openCalls.length = 0;
  fsHooks.renameCalls.length = 0;
  fsHooks.afterRenameContent = undefined;
  fsHooks.tempReadOpens = 0;
  fsHooks.mutateSourceOnTempRead = undefined;
  fsHooks.swapTemporaryAfterLstat = undefined;
  formatHooks.corruptToken = undefined;
  formatHooks.corruptPlaceholder = false;
});

describe('pruneCodexSessionImages', () => {
  test('runs complete preflight before any write, then prepares, renames, syncs, and succeeds', async () => {
    const fixture = await makeFixture([sessionLine('before')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const original = await readFile(candidate.path, 'utf8');
      await chmod(candidate.path, 0o640);
      const preservedMtime = new Date('2026-01-02T03:04:05.000Z');
      await utimes(candidate.path, preservedMtime, preservedMtime);
      candidate.identity = await collectFileIdentity(candidate.path, candidate.pathCategory);
      preflightHooks.beforeReturn = async () => {
        expect(await readFile(candidate.path, 'utf8')).toBe(original);
        expect(fsHooks.renameCalls).toHaveLength(0);
        expect(await temporaryEntries(path.dirname(candidate.path))).toEqual([]);
        expect(manifestHooks.createCalls).toHaveLength(0);
      };
      manifestHooks.onAppend = async (record) => {
        if (record.recordType === 'file-prepared') {
          expect(await readFile(candidate.path, 'utf8')).toBe(original);
          expect(fsHooks.renameCalls).toHaveLength(0);
        }
        if (record.recordType === 'file-success') {
          expect(await readFile(candidate.path, 'utf8')).not.toBe(original);
          expect(fsHooks.renameCalls).toHaveLength(1);
        }
      };

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({
        status: 'ok',
        changed: true,
        filesSucceeded: 1,
        filesSkipped: 0,
        filesFailed: 0,
        imagesStripped: 1,
        sourceBytes: candidate.sourceBytes,
        resultBytes: candidate.projectedBytes,
        reclaimedBytes: candidate.sourceBytes - candidate.projectedBytes,
        manifestPathCategory: '<home>/.ai-dev-maintenance/manifests/<manifest-file>',
        blockedReasons: [],
        warnings: []
      });
      expect(preflightHooks.calls).toHaveLength(2);
      expect(preflightHooks.calls[0]).toMatchObject({
        env: { HOME: fixture.home },
        targets: [{ path: candidate.path, identity: candidate.identity }],
        requiredTemporaryBytes: candidate.projectedBytes
      });
      expect(preflightHooks.calls[1]).toMatchObject({
        env: { HOME: fixture.home },
        targets: [{ path: candidate.path, identity: candidate.identity }],
        requiredTemporaryBytes: candidate.projectedBytes
      });
      expect(recordTypes(manifestHooks.persisted)).toEqual([
        'run-start',
        'file-prepared',
        'file-success',
        'run-summary'
      ]);
      expect(await readFile(candidate.path, 'utf8')).toContain(SESSION_IMAGE_PLACEHOLDER_URL);
      expect(await readFile(candidate.path, 'utf8')).not.toContain(LARGE_PAYLOAD);
      expect((await stat(candidate.path)).mode & 0o777).toBe(0o640);
      expect((await stat(candidate.path)).mtimeMs).toBe(preservedMtime.getTime());
      expect(await temporaryEntries(path.dirname(candidate.path))).toEqual([]);

      const tempCreate = fsHooks.openCalls.find((call) =>
        path.dirname(call.filePath) === path.dirname(candidate.path)
        && call.filePath !== candidate.path
        && (Number(call.flags) & constants.O_EXCL) !== 0
      );
      expect(tempCreate).toBeDefined();
      expect(Number(tempCreate?.flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(tempCreate?.mode).toBe(0o600);
      expect(fsHooks.renameCalls).toEqual([{ from: tempCreate?.filePath, to: candidate.path }]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('returns blocked before manifest or temporary creation when whole-plan preflight fails', async () => {
    const fixture = await makeFixture([sessionLine('blocked')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const original = await readFile(candidate.path, 'utf8');
      preflightHooks.result = {
        allowed: false,
        blockedReasons: ['target-open'],
        availableBytes: 10 * 1024 ** 3,
        requiredTemporaryBytes: 0
      };

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({
        status: 'blocked',
        changed: false,
        blockedReasons: ['target-open']
      });
      expect(await readFile(candidate.path, 'utf8')).toBe(original);
      expect(manifestHooks.createCalls).toHaveLength(0);
      expect(fsHooks.renameCalls).toHaveLength(0);
      expect(await temporaryEntries(path.dirname(candidate.path))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('records excluded outcomes truthfully without opening their paths', async () => {
    const fixture = await makeFixture([sessionLine('candidate')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const excluded = [
        privateOutcome(path.join(fixture.home, 'never-open-skip.jsonl'), 'skipped', 'no-prunable-images'),
        privateOutcome(path.join(fixture.home, 'never-open-fail.jsonl'), 'blocked', 'invalid-json')
      ];

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: excluded
      });

      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'partial',
        changed: true,
        filesSucceeded: 1,
        filesSkipped: 1,
        filesFailed: 1
      });
      expect(recordTypes(manifestHooks.persisted)).toEqual([
        'run-start',
        'file-skip',
        'file-failed',
        'file-prepared',
        'file-success',
        'run-summary'
      ]);
      expect(fsHooks.openCalls.some((call) => excluded.some((item) => item.path === call.filePath))).toBe(false);
      const skip = manifestHooks.persisted.find((record) => record.recordType === 'file-skip');
      const failed = manifestHooks.persisted.find((record) => record.recordType === 'file-failed');
      expect(skip).toMatchObject({ reason: 'no-prunable-images', source: excluded[0].path });
      expect(failed).toMatchObject({ code: 'invalid-json', source: excluded[1].path });
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    ['invalid-json', '{"message":"data:image/png;base64,' + LARGE_PAYLOAD + ' "\n'],
    ['ambiguous-data-url', JSON.stringify({ html: '<img src=data:image/png;base64,QUFBQQ==/>' }) + '\n'],
    ['non-json-unicode-whitespace', '\u00a0\n']
  ])('leaves a %s source unchanged and removes its failed temporary', async (_label, content) => {
    const fixture = await makeFixture([content]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      candidate.imagesPrunable = 1;
      candidate.occurrencesSeen = Math.max(1, candidate.occurrencesSeen);
      const original = await readFile(candidate.path, 'utf8');

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({ status: 'blocked', changed: false, filesFailed: 1 });
      expect(await readFile(candidate.path, 'utf8')).toBe(original);
      expect(fsHooks.renameCalls).toHaveLength(0);
      expect(await temporaryEntries(path.dirname(candidate.path))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('blocks source-hash drift even when the current identity is supplied', async () => {
    const fixture = await makeFixture([sessionLine('before')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const drifted = (await readFile(candidate.path, 'utf8')).replace('before', 'beforz');
      await writeFile(candidate.path, drifted, { mode: 0o600 });
      candidate.identity = await collectFileIdentity(candidate.path, candidate.pathCategory);

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({ status: 'blocked', changed: false, filesFailed: 1 });
      expect(await readFile(candidate.path, 'utf8')).toBe(drifted);
      expect(fsHooks.renameCalls).toHaveLength(0);
      expect(await temporaryEntries(path.dirname(candidate.path))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('independent non-image-byte verification catches a valid-JSON same-size rewrite corruption', async () => {
    const fixture = await makeFixture([sessionLine('before')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const original = await readFile(candidate.path, 'utf8');
      formatHooks.corruptToken = 'before';

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({ status: 'blocked', changed: false, filesFailed: 1 });
      expect(await readFile(candidate.path, 'utf8')).toBe(original);
      expect(fsHooks.renameCalls).toHaveLength(0);
      expect(await temporaryEntries(path.dirname(candidate.path))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects a same-length valid base64 result that is not the approved placeholder', async () => {
    const fixture = await makeFixture([sessionLine('before')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const original = await readFile(candidate.path, 'utf8');
      formatHooks.corruptPlaceholder = true;

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({ status: 'blocked', changed: false, filesFailed: 1 });
      expect(await readFile(candidate.path, 'utf8')).toBe(original);
      expect(fsHooks.renameCalls).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('revalidates the prepared temporary by inode immediately before rename', async () => {
    const fixture = await makeFixture([sessionLine('before')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const original = await readFile(candidate.path, 'utf8');
      let replacementPath = '';
      manifestHooks.onAppend = async (record) => {
        if (record.recordType !== 'file-prepared') return;
        const tempPath = latestTemporaryPath(path.dirname(candidate.path));
        replacementPath = tempPath;
        await unlink(tempPath);
        await writeFile(tempPath, 'replacement', { mode: 0o600, flag: 'wx' });
      };

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({ status: 'blocked', changed: false, filesFailed: 1 });
      expect(result.blockedReasons).toContain('temp-cleanup-unsafe');
      expect(await readFile(candidate.path, 'utf8')).toBe(original);
      expect(fsHooks.renameCalls).toHaveLength(0);
      expect(await readFile(replacementPath, 'utf8')).toBe('replacement');
    } finally {
      await fixture.cleanup();
    }
  });

  test('revalidates the source after the final temporary validation', async () => {
    const fixture = await makeFixture([sessionLine('before')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const drifted = (await readFile(candidate.path, 'utf8')).replace('before', 'beforz');
      fsHooks.mutateSourceOnTempRead = { sourcePath: candidate.path, content: drifted };

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({ status: 'blocked', changed: false, filesFailed: 1 });
      expect(result.blockedReasons).toContain('source-revalidation-failed');
      expect(await readFile(candidate.path, 'utf8')).toBe(drifted);
      expect(fsHooks.renameCalls).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('preserves a replacement swapped in after cleanup lstat', async () => {
    const fixture = await makeFixture([sessionLine('before')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const drifted = (await readFile(candidate.path, 'utf8')).replace('before', 'beforz');
      manifestHooks.onAppend = async (record) => {
        if (record.recordType === 'file-prepared') await writeFile(candidate.path, drifted);
      };
      const swap: { content: string; swappedPath?: string } = {
        content: 'foreign replacement must survive'
      };
      fsHooks.swapTemporaryAfterLstat = swap;

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({ status: 'blocked', changed: false, filesFailed: 1 });
      expect(result.blockedReasons).toContain('temp-cleanup-unsafe');
      expect(swap.swappedPath).toBeTypeOf('string');
      expect(await readFile(swap.swappedPath ?? '', 'utf8')).toBe(swap.content);
      expect(await readFile(candidate.path, 'utf8')).toBe(drifted);
      expect(fsHooks.renameCalls).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('verifies the committed inode and content before appending file-success', async () => {
    const fixture = await makeFixture([sessionLine('before')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      fsHooks.afterRenameContent = 'externally-corrupted-after-rename\n';

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({
        status: 'partial',
        changed: true,
        filesSucceeded: 0,
        filesFailed: 1
      });
      expect(recordTypes(manifestHooks.persisted)).toContain('file-prepared');
      expect(recordTypes(manifestHooks.persisted)).not.toContain('file-success');
    } finally {
      await fixture.cleanup();
    }
  });

  test('keeps a prepared record reconcilable and does not count success when final append fails', async () => {
    const fixture = await makeFixture([sessionLine('before')]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      const original = await readFile(candidate.path, 'utf8');
      manifestHooks.failRecordType = 'file-success';

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result).toMatchObject({
        status: 'partial',
        changed: true,
        filesSucceeded: 0,
        filesFailed: 1,
        blockedReasons: ['manifest-write-failed']
      });
      expect(await readFile(candidate.path, 'utf8')).not.toBe(original);
      expect(recordTypes(manifestHooks.persisted)).toEqual(['run-start', 'file-prepared']);
      expect(recordTypes(manifestHooks.attempted)).toEqual(['run-start', 'file-prepared', 'file-success']);
      expect(publicResultText(result)).not.toContain(fixture.home);
      expect(publicResultText(result)).not.toContain(LARGE_PAYLOAD);
      expect(publicResultText(result)).not.toContain('/private/manifest');
    } finally {
      await fixture.cleanup();
    }
  });

  test('retains an earlier success and stops with partial when a later file fails', async () => {
    const fixture = await makeFixture([sessionLine('firstx'), sessionLine('second')]);
    try {
      const candidates = await Promise.all(fixture.files.map(makeCandidate));
      const originals = await Promise.all(fixture.files.map((file) => readFile(file, 'utf8')));
      formatHooks.corruptToken = 'second';

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates,
        excludedOutcomes: []
      });

      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'partial',
        changed: true,
        filesSucceeded: 1,
        filesFailed: 1,
        imagesStripped: 1
      });
      expect(await readFile(fixture.files[0], 'utf8')).not.toBe(originals[0]);
      expect(await readFile(fixture.files[1], 'utf8')).toBe(originals[1]);
      expect(fsHooks.renameCalls).toHaveLength(1);
      expect(await temporaryEntries(path.dirname(fixture.files[1]))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('preserves known placeholders while replacing only new large images', async () => {
    const content = `${JSON.stringify({
      text: `known ${SESSION_IMAGE_PLACEHOLDER_URL} new data:image/jpeg;base64,${LARGE_PAYLOAD} `
    })}\n`;
    const fixture = await makeFixture([content]);
    try {
      const candidate = await makeCandidate(fixture.files[0]);
      expect(candidate.knownPlaceholders).toBe(1);
      expect(candidate.imagesPrunable).toBe(1);

      const result = await pruneCodexSessionImages({
        env: { HOME: fixture.home },
        planId: fixture.planId,
        candidates: [candidate],
        excludedOutcomes: []
      });

      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'ok',
        filesSucceeded: 1,
        imagesStripped: 1
      });
      expect((await readFile(candidate.path, 'utf8')).split(SESSION_IMAGE_PLACEHOLDER_URL)).toHaveLength(3);
      const success = manifestHooks.persisted.find((record) => record.recordType === 'file-success');
      expect(success).toMatchObject({ knownPlaceholders: 1, imagesStripped: 1 });
    } finally {
      await fixture.cleanup();
    }
  });
});

const LARGE_PAYLOAD = Buffer.alloc(768, 0x41).toString('base64');
const PATH_CATEGORY = '<home>/.codex/sessions/<session-file>';

type Fixture = {
  home: string;
  planId: string;
  files: string[];
  cleanup(): Promise<void>;
};

async function makeFixture(contents: string[]): Promise<Fixture> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-prune-home-'));
  const directory = path.join(home, '.codex', 'sessions', '2026', '01');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const [index, content] of contents.entries()) {
    const file = path.join(directory, `rollout-${index}.jsonl`);
    await writeFile(file, content, { mode: 0o600 });
    files.push(file);
  }
  fsHooks.openCalls.length = 0;
  return {
    home,
    planId: 'plan-prune-test',
    files,
    cleanup: async () => rm(home, { recursive: true, force: true })
  };
}

function sessionLine(token: string): string {
  return `${JSON.stringify({ message: `${token} data:image/jpeg;base64,${LARGE_PAYLOAD} after` })}\n`;
}

async function makeCandidate(file: string): Promise<CodexSessionImageCandidate> {
  const sourceHash = createHash('sha256');
  let sourceBytes = 0;
  let projectedBytes = 0;
  let occurrencesSeen = 0;
  let imagesPrunable = 0;
  let knownPlaceholders = 0;
  let belowMinimum = 0;
  let lines = 0;
  for await (const line of readJsonlLines(file)) {
    lines += 1;
    sourceBytes += line.bytes.length;
    sourceHash.update(line.bytes);
    const analysis = analyzeSessionImageLine(line.text);
    occurrencesSeen += analysis.occurrences.length;
    imagesPrunable += analysis.occurrences.filter((item) => item.kind === 'replace').length;
    knownPlaceholders += analysis.occurrences.filter(
      (item) => item.kind === 'skip' && item.reason === 'known-placeholder'
    ).length;
    belowMinimum += analysis.occurrences.filter(
      (item) => item.kind === 'skip' && item.reason === 'below-min-payload'
    ).length;
    projectedBytes += Buffer.byteLength(rewriteSessionImageLine(line.text, analysis).output);
  }
  return {
    path: file,
    pathCategory: PATH_CATEGORY,
    sourceBytes,
    projectedBytes,
    occurrencesSeen,
    imagesPrunable,
    knownPlaceholders,
    belowMinimum,
    lines,
    sourceSha256: sourceHash.digest('hex'),
    identity: await collectFileIdentity(file, PATH_CATEGORY)
  };
}

function privateOutcome(
  outcomePath: string,
  status: CodexSessionImagePrivateOutcome['status'],
  code: CodexSessionImagePrivateOutcome['code']
): CodexSessionImagePrivateOutcome {
  return { path: outcomePath, pathCategory: PATH_CATEGORY, status, code };
}

function recordTypes(records: Array<Record<string, unknown>>): unknown[] {
  return records.map((record) => record.recordType);
}

async function temporaryEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.includes('.aidm-'));
}

function latestTemporaryPath(directory: string): string {
  const call = [...fsHooks.openCalls].reverse().find((item) =>
    path.dirname(item.filePath) === directory
    && (Number(item.flags) & constants.O_EXCL) !== 0
    && item.filePath.includes('.aidm-session-image-')
  );
  if (!call) throw new Error('synthetic temporary path was not observed');
  return call.filePath;
}

function publicResultText(result: CodexSessionImagePruneResult): string {
  return JSON.stringify(result);
}
