import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { collectFileIdentity } from '../src/fs-safety.js';
import { SESSION_IMAGE_PLACEHOLDER_URL } from '../src/reclaim/session-image-format.js';

// These cases exercise macOS-only behavior; the unsupported-platform cases still run everywhere.
const macTest = process.platform === 'darwin' ? test : test.skip;

const streamHooks = vi.hoisted(() => ({
  requested: [] as string[],
  failures: new Map<string, 'line-too-large' | 'invalid-utf8'>(),
  beforeRead: new Map<string, () => Promise<() => Promise<void>>>()
}));

vi.mock('../src/reclaim/jsonl-stream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reclaim/jsonl-stream.js')>();
  return {
    ...actual,
    readJsonlLines: async function* (
      filePath: string,
      options?: { maxLineBytes?: number; highWaterMark?: number; fileDescriptor?: number }
    ) {
      streamHooks.requested.push(filePath);
      const code = streamHooks.failures.get(filePath);
      if (code) throw Object.assign(new Error('synthetic stream failure'), { code });
      const restore = await streamHooks.beforeRead.get(filePath)?.();
      try {
        yield* actual.readJsonlLines(filePath, options);
      } finally {
        await restore?.();
      }
    }
  };
});

import {
  publicCodexSessionImageScanResult,
  scanCodexSessionImages
} from '../src/reclaim/codex-session-images.js';

const NOW = new Date('2026-08-25T00:00:00.000Z');
const OLD = new Date('2026-01-01T00:00:00.000Z');
const LARGE_PAYLOAD = Buffer.alloc(768, 0x41).toString('base64');

afterEach(() => {
  streamHooks.requested.length = 0;
  streamHooks.failures.clear();
  streamHooks.beforeRead.clear();
});

describe('scanCodexSessionImages', () => {
  macTest('opens only old large plain JSONL files and admits only fully safe candidates', async () => {
    const fixture = await makeFixture();
    try {
      const safeLine = imageJsonlLine(LARGE_PAYLOAD);
      const safe = await fixture.writeSession('2026/01/rollout-safe.jsonl', safeLine, OLD);
      const noOp = await fixture.writeSession(
        '2026/01/rollout-no-op.jsonl',
        `${JSON.stringify({ message: 'x'.repeat(200) })}\n`,
        OLD
      );
      const malformed = await fixture.writeSession(
        '2026/01/rollout-malformed.jsonl',
        `{"broken":${'x'.repeat(200)}\n`,
        OLD
      );
      const ambiguous = await fixture.writeSession(
        '2026/01/rollout-ambiguous.jsonl',
        `{"image_url":"data:image/png;base64,QUFB\\/QUFB"}\n${' '.repeat(120)}`,
        OLD
      );
      const invalidUtf8 = await fixture.writeSession(
        '2026/01/rollout-invalid-utf8.jsonl',
        Buffer.concat([Buffer.from('{"message":"'), Buffer.alloc(180, 0xff), Buffer.from('"}\n')]),
        OLD
      );
      const tooLarge = await fixture.writeSession(
        '2026/01/rollout-too-large.jsonl',
        `${JSON.stringify({ message: 'x'.repeat(200) })}\n`,
        OLD
      );
      streamHooks.failures.set(tooLarge, 'line-too-large');

      const newLarge = await fixture.writeSession('2026/08/rollout-new.jsonl', safeLine, NOW);
      const small = await fixture.writeSession('2026/01/rollout-small.jsonl', '{}\n', OLD);
      const compressed = await fixture.writeSession(
        '2026/01/rollout-compressed.jsonl.zst',
        'z'.repeat(200),
        OLD
      );
      const archived = await fixture.writeArchive('rollout-archive.jsonl', safeLine, OLD);

      const hardlinkSource = await fixture.writeSession(
        '2026/01/rollout-hardlink-source.jsonl',
        safeLine,
        OLD
      );
      const hardlinkAlias = path.join(path.dirname(hardlinkSource), 'rollout-hardlink-alias.jsonl');
      await link(hardlinkSource, hardlinkAlias);
      const symlinkTarget = await fixture.writeOutside('outside-target.jsonl', safeLine, OLD);
      const symlinkPath = path.join(fixture.sessions, '2026', '01', 'rollout-link.jsonl');
      await symlink(symlinkTarget, symlinkPath);

      const safeIdentity = await collectFileIdentity(safe, 'diagnostic');
      const canonicalSessions = await realpath(fixture.sessions);
      const relativeRealpath = path.relative(canonicalSessions, safeIdentity.realpath ?? '');
      expect({
        exists: safeIdentity.exists,
        regularFile: safeIdentity.regularFile,
        symbolicLink: safeIdentity.symbolicLink,
        oneLink: safeIdentity.nlink === 1,
        ownerMatches: process.getuid?.() === undefined || safeIdentity.uid === process.getuid?.(),
        writableByGroupOrOther: ((safeIdentity.mode ?? 0) & 0o022) !== 0,
        contained: relativeRealpath.length > 0
          && !relativeRealpath.startsWith(`..${path.sep}`)
          && relativeRealpath !== '..'
          && !path.isAbsolute(relativeRealpath)
      }).toEqual({
        exists: true,
        regularFile: true,
        symbolicLink: false,
        oneLink: true,
        ownerMatches: true,
        writableByGroupOrOther: false,
        contained: true
      });

      const result = await scanCodexSessionImages({
        env: { HOME: fixture.home },
        now: NOW,
        olderThanDays: 30,
        minFileSizeBytes: 100,
        maxFiles: 100
      });

      expect(result.status).toBe('partial');
      expect(result.contentRead).toBe(true);
      expect(result.candidates, JSON.stringify({
        status: result.status,
        outcomeCodes: result.privateOutcomes.map((outcome) => outcome.code),
        totals: result.totals,
        warnings: result.warnings,
        requestedFiles: streamHooks.requested.length
      })).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({
        path: safe,
        pathCategory: '<home>/.codex/sessions/<session-file>',
        sourceBytes: Buffer.byteLength(safeLine),
        occurrencesSeen: 1,
        imagesPrunable: 1,
        knownPlaceholders: 0,
        belowMinimum: 0,
        lines: 1,
        sourceSha256: createHash('sha256').update(safeLine).digest('hex'),
        identity: {
          exists: true,
          regularFile: true,
          symbolicLink: false,
          nlink: 1
        }
      });
      const projectedLine = safeLine.replace(
        `data:image/png;base64,${LARGE_PAYLOAD}`,
        SESSION_IMAGE_PLACEHOLDER_URL
      );
      expect(result.candidates[0].projectedBytes).toBe(Buffer.byteLength(projectedLine));
      expect(result.totals).toMatchObject({
        filesOpened: 6,
        filesSkippedBySize: 1,
        sourceBytes: Buffer.byteLength(safeLine),
        projectedBytes: Buffer.byteLength(projectedLine),
        reclaimableBytes: Buffer.byteLength(safeLine) - Buffer.byteLength(projectedLine),
        occurrencesSeen: 1,
        imagesPrunable: 1,
        knownPlaceholders: 0,
        belowMinimum: 0
      });

      expect(result.privateOutcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: noOp, status: 'skipped', code: 'no-prunable-images' }),
        expect.objectContaining({ path: malformed, status: 'blocked', code: 'invalid-json' }),
        expect.objectContaining({ path: ambiguous, status: 'blocked', code: 'ambiguous-data-url' }),
        expect.objectContaining({ path: invalidUtf8, status: 'blocked', code: 'invalid-utf8' }),
        expect.objectContaining({ path: tooLarge, status: 'blocked', code: 'line-too-large' }),
        expect.objectContaining({ path: hardlinkSource, status: 'blocked', code: 'unsafe-file' }),
        expect.objectContaining({ path: hardlinkAlias, status: 'blocked', code: 'unsafe-file' }),
        expect.objectContaining({ path: symlinkPath, status: 'blocked', code: 'unsafe-file' })
      ]));
      expect(result.blockedReasons).toEqual(expect.arrayContaining([
        'ambiguous-data-url',
        'invalid-json',
        'invalid-utf8',
        'line-too-large',
        'unsafe-file'
      ]));
      expect(result.warnings).toEqual(expect.arrayContaining([
        'size-filtered-estimate-is-lower-bound',
        'compressed-session-files-protected'
      ]));

      const opened = new Set(streamHooks.requested);
      expect(opened).toEqual(new Set([safe, noOp, malformed, ambiguous, invalidUtf8, tooLarge]));
      for (const protectedPath of [
        newLarge,
        small,
        compressed,
        archived,
        hardlinkSource,
        hardlinkAlias,
        symlinkPath
      ]) {
        expect(opened.has(protectedPath)).toBe(false);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks a custom CODEX_HOME before reading files', async () => {
    const fixture = await makeFixture();
    try {
      const custom = path.join(fixture.home, 'custom-codex');
      await mkdir(path.join(custom, 'sessions'), { recursive: true });
      await writeFile(path.join(custom, 'sessions', 'rollout.jsonl'), imageJsonlLine(LARGE_PAYLOAD));

      const result = await scanCodexSessionImages({
        env: { HOME: fixture.home, CODEX_HOME: custom },
        now: NOW,
        minFileSizeBytes: 1
      });

      expect(result).toMatchObject({
        status: 'blocked',
        contentRead: true,
        candidates: [],
        privateOutcomes: [],
        blockedReasons: ['custom-codex-home-unsupported'],
        totals: { filesOpened: 0, sourceBytes: 0, projectedBytes: 0 }
      });
      expect(streamHooks.requested).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('blocks an unsafe sessions-root symlink before reading files', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-session-scan-root-'));
    const outside = path.join(home, 'outside');
    try {
      await mkdir(path.join(home, '.codex'), { recursive: true });
      await mkdir(outside);
      await writeFile(path.join(outside, 'rollout.jsonl'), imageJsonlLine(LARGE_PAYLOAD));
      await symlink(outside, path.join(home, '.codex', 'sessions'));

      const result = await scanCodexSessionImages({
        env: { HOME: home },
        now: NOW,
        minFileSizeBytes: 1
      });

      expect(result).toMatchObject({
        status: 'blocked',
        candidates: [],
        privateOutcomes: [],
        blockedReasons: ['unsafe-sessions-root'],
        totals: { filesOpened: 0 }
      });
      expect(streamHooks.requested).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  macTest('blocks a symlinked default Codex root before reading files', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-session-scan-home-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'aidm-session-scan-outside-'));
    try {
      await mkdir(path.join(outside, 'sessions'), { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(outside, 'sessions', 'rollout.jsonl'),
        imageJsonlLine(LARGE_PAYLOAD),
        { mode: 0o600 }
      );
      await symlink(outside, path.join(home, '.codex'));

      const result = await scanCodexSessionImages({
        env: { HOME: home },
        now: NOW,
        minFileSizeBytes: 1
      });

      expect(result).toMatchObject({
        status: 'blocked',
        candidates: [],
        privateOutcomes: [],
        blockedReasons: ['unsafe-codex-root'],
        totals: { filesOpened: 0 }
      });
      expect(streamHooks.requested).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('blocks before reading on unsupported platforms', async () => {
    const fixture = await makeFixture();
    try {
      await fixture.writeSession('2026/01/rollout.jsonl', imageJsonlLine(LARGE_PAYLOAD), OLD);
      const bypassAttempt = {
        env: { HOME: fixture.home },
        platform: 'darwin' as NodeJS.Platform,
        now: NOW,
        minFileSizeBytes: 1
      };

      const result = await withProcessPlatform('linux', () =>
        scanCodexSessionImages(bypassAttempt)
      );

      expect(result).toMatchObject({
        status: 'blocked',
        candidates: [],
        privateOutcomes: [],
        blockedReasons: ['platform-unsupported'],
        totals: { filesOpened: 0 }
      });
      expect(streamHooks.requested).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('uses one verified descriptor when the path is swapped and restored during scanning', async () => {
    const fixture = await makeFixture();
    try {
      const originalLine = imageJsonlLine(Buffer.alloc(768, 0x41).toString('base64'));
      const replacementLine = imageJsonlLine(Buffer.alloc(768, 0x42).toString('base64'));
      const target = await fixture.writeSession('2026/01/rollout-race.jsonl', originalLine, OLD);
      const replacement = await fixture.writeOutside('replacement.jsonl', replacementLine, OLD);
      const savedOriginal = `${target}.saved`;
      streamHooks.beforeRead.set(target, async () => {
        await rename(target, savedOriginal);
        await rename(replacement, target);
        return async () => {
          await rename(target, replacement);
          await rename(savedOriginal, target);
        };
      });

      const result = await scanCodexSessionImages({
        env: { HOME: fixture.home },
        now: NOW,
        olderThanDays: 30,
        minFileSizeBytes: 1
      });

      expect(result.status).toBe('ok');
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].sourceSha256).toBe(
        createHash('sha256').update(originalLine).digest('hex')
      );
      expect(result.candidates[0].sourceSha256).not.toBe(
        createHash('sha256').update(replacementLine).digest('hex')
      );
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('does not admit a file whose data URLs are only embedded in text', async () => {
    const fixture = await makeFixture();
    try {
      const embeddedOnly = await fixture.writeSession(
        '2026/01/rollout-embedded.jsonl',
        `${JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: `.logo{background:url(data:image/png;base64,${LARGE_PAYLOAD})}`
          }
        })}\n`,
        OLD
      );

      const result = await scanCodexSessionImages({
        env: { HOME: fixture.home },
        now: NOW,
        olderThanDays: 30,
        minFileSizeBytes: 1
      });

      expect(result.candidates).toEqual([]);
      expect(result.totals).toMatchObject({ occurrencesSeen: 0, imagesPrunable: 0, reclaimableBytes: 0 });
      expect(result.privateOutcomes).toEqual([
        expect.objectContaining({ path: embeddedOnly, status: 'skipped', code: 'no-prunable-images' })
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  macTest('returns an empty successful scan when the default sessions root is absent', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-session-scan-empty-'));
    try {
      const result = await scanCodexSessionImages({
        env: { HOME: home },
        now: NOW,
        minFileSizeBytes: 1
      });

      expect(result).toMatchObject({
        status: 'ok',
        candidates: [],
        privateOutcomes: [],
        blockedReasons: [],
        totals: { filesConsidered: 0, filesOpened: 0 }
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('publicCodexSessionImageScanResult', () => {
  macTest('projects aggregate redacted data without paths, hashes, identities, or per-file records', async () => {
    const fixture = await makeFixture();
    try {
      const privatePath = await fixture.writeSession(
        '2026/01/private-rollout-name.jsonl',
        imageJsonlLine(LARGE_PAYLOAD),
        OLD
      );
      const scan = await scanCodexSessionImages({
        env: { HOME: fixture.home },
        now: NOW,
        olderThanDays: 30,
        minFileSizeBytes: 1
      });
      Object.assign(scan.totals, { privatePath });
      scan.blockedReasons.push(privatePath);
      scan.warnings.push(privatePath);
      const filters = {
        olderThanDays: 30,
        minFileSizeBytes: 1,
        privatePath
      };
      const result = publicCodexSessionImageScanResult(scan, filters);
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({
        schemaVersion: 1,
        command: 'reclaim scan codex-session-images',
        status: 'ok',
        contentRead: true,
        filters: { olderThanDays: 30, minFileSizeBytes: 1 },
        totals: { candidateFiles: 1, imagesPrunable: 1 }
      });
      expect(Object.keys(result).sort()).toEqual([
        'blockedReasons',
        'command',
        'contentRead',
        'filters',
        'schemaVersion',
        'status',
        'toolVersion',
        'totals',
        'warnings'
      ]);
      for (const secret of [
        fixture.home,
        privatePath,
        'private-rollout-name',
        'privatePath',
        scan.candidates[0].sourceSha256,
        'identity',
        'privateOutcomes',
        'candidates'
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

// Rollout-shaped synthetic fixture; field names mirror Codex response items but are not captured data.
function imageJsonlLine(payload: string): string {
  return `${JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'before after' },
        { type: 'input_image', image_url: `data:image/png;base64,${payload}` }
      ]
    }
  })}\n`;
}

async function makeFixture(): Promise<{
  home: string;
  sessions: string;
  writeSession(relative: string, data: string | Buffer, mtime: Date): Promise<string>;
  writeArchive(relative: string, data: string | Buffer, mtime: Date): Promise<string>;
  writeOutside(relative: string, data: string | Buffer, mtime: Date): Promise<string>;
  cleanup(): Promise<void>;
}> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-session-scan-'));
  const sessions = path.join(home, '.codex', 'sessions');
  const archive = path.join(home, '.codex', 'maintenance-archive', 'sessions');
  const outside = path.join(home, 'outside');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await mkdir(outside, { recursive: true, mode: 0o700 });
  await chmod(sessions, 0o700);

  const write = async (
    root: string,
    relative: string,
    data: string | Buffer,
    mtime: Date
  ): Promise<string> => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, data, { mode: 0o600 });
    await utimes(file, mtime, mtime);
    return file;
  };

  return {
    home,
    sessions,
    writeSession: (relative, data, mtime) => write(sessions, relative, data, mtime),
    writeArchive: (relative, data, mtime) => write(archive, relative, data, mtime),
    writeOutside: (relative, data, mtime) => write(outside, relative, data, mtime),
    cleanup: () => rm(home, { recursive: true, force: true })
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
