import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TOOL_VERSION } from '../src/version.js';

const fsHooks = vi.hoisted(() => ({
  openCalls: [] as Array<{ filePath: string; flags: string | number; mode?: number }>,
  syncCalls: 0,
  failNextSync: false
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (filePath: string, flags: string | number, mode?: number) => {
      fsHooks.openCalls.push({ filePath, flags, mode });
      const handle = await actual.open(filePath, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') {
            return async () => {
              fsHooks.syncCalls += 1;
              if (fsHooks.failNextSync) {
                fsHooks.failNextSync = false;
                throw new Error('synthetic path and content must not escape');
              }
              await target.sync();
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
});

import {
  createSessionImageManifest,
  type SessionImageManifestFileBase,
  type SessionImageManifestRecord
} from '../src/reclaim/session-image-manifest.js';

afterEach(() => {
  fsHooks.openCalls.length = 0;
  fsHooks.syncCalls = 0;
  fsHooks.failNextSync = false;
});

describe('createSessionImageManifest', () => {
  test('creates one exclusive no-follow 0600 file below private 0700 directories', async () => {
    const fixture = await makeFixture();
    try {
      const writer = await createSessionImageManifest({
        env: { HOME: fixture.home },
        planId: fixture.planId
      });

      expect(writer.path).toBe(path.join(
        fixture.home,
        '.ai-dev-maintenance',
        'manifests',
        `session-image-${fixture.planId}.jsonl`
      ));
      expect((await lstat(path.dirname(writer.path))).mode & 0o777).toBe(0o700);
      expect((await lstat(writer.path)).mode & 0o777).toBe(0o600);
      expect(fsHooks.syncCalls).toBe(1);

      const createCall = fsHooks.openCalls[0];
      expect(createCall?.flags).toEqual(expect.any(Number));
      const flags = Number(createCall?.flags);
      expect(flags & constants.O_CREAT).toBe(constants.O_CREAT);
      expect(flags & constants.O_EXCL).toBe(constants.O_EXCL);
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(createCall?.mode).toBe(0o600);

      await expect(createSessionImageManifest({
        env: { HOME: fixture.home },
        planId: fixture.planId
      })).rejects.toThrow('manifest-already-exists');
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects a non-string plan id without invoking coercion or creating app state', async () => {
    const fixture = await makeFixture();
    let coercions = 0;
    const hostilePlanId = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return coercions === 1 ? 'plan-safe' : 'x/../../../../pwn';
      }
    };
    try {
      await expect(createSessionImageManifest({
        env: { HOME: fixture.home },
        planId: hostilePlanId as unknown as string
      })).rejects.toThrow('manifest-plan-id-invalid');

      expect(coercions).toBe(0);
      await expect(lstat(path.join(fixture.home, '.ai-dev-maintenance'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test('writes every record as parseable compact JSONL in invocation order and fsyncs each append', async () => {
    const fixture = await makeFixture();
    try {
      const writer = await createSessionImageManifest({
        env: { HOME: fixture.home },
        planId: fixture.planId
      });
      const records = allRecordVariants(fixture);

      for (const [index, record] of records.entries()) {
        await writer.append(record);
        const lines = await manifestLines(writer.path);
        expect(lines).toHaveLength(index + 1);
        expect(lines.map((line) => JSON.parse(line))).toEqual(records.slice(0, index + 1));
        expect(lines.every((line) => !line.includes('\n') && !line.includes('  '))).toBe(true);
      }

      expect(fsHooks.syncCalls).toBe(1 + records.length);
      const appendFlags = fsHooks.openCalls.slice(1).map((call) => Number(call.flags));
      expect(appendFlags).toHaveLength(records.length);
      for (const flags of appendFlags) {
        expect(flags & constants.O_APPEND).toBe(constants.O_APPEND);
        expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      }

      const ordered = await createSessionImageManifest({
        env: { HOME: fixture.home },
        planId: `${fixture.planId}-ordered`
      });
      const starts = [0, 1, 2].map((index) => ordered.append({
        ...runStart(fixture, `${fixture.planId}-ordered`),
        at: `2026-08-25T00:00:0${index}.000Z`
      }));
      await Promise.all(starts);
      expect((await manifestLines(ordered.path)).map((line) => JSON.parse(line).at)).toEqual([
        '2026-08-25T00:00:00.000Z',
        '2026-08-25T00:00:01.000Z',
        '2026-08-25T00:00:02.000Z'
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  test('keeps prepared and success events distinct instead of treating durable preparation as success', async () => {
    const fixture = await makeFixture();
    try {
      const writer = await createSessionImageManifest({
        env: { HOME: fixture.home },
        planId: fixture.planId
      });
      await writer.append(prepared(fixture));

      const records = (await manifestLines(writer.path)).map((line) => JSON.parse(line));
      expect(records.filter((record) => record.recordType === 'file-prepared')).toHaveLength(1);
      expect(records.filter((record) => record.recordType === 'file-success')).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects unknown/raw fields, malformed audit values, and a mismatched plan at runtime', async () => {
    const fixture = await makeFixture();
    try {
      const invalidRecords: unknown[] = [
        { ...prepared(fixture), rawLine: 'private session text' },
        { ...prepared(fixture), payload: 'private base64 payload' },
        { ...prepared(fixture), sourceBytes: -1 },
        { ...prepared(fixture), sourceBytes: undefined },
        { ...prepared(fixture), resultSha256: 'not-a-hash' },
        { ...prepared(fixture), planId: 'plan-different' },
        { ...prepared(fixture), verificationsPassed: ['contains/a/path'] }
      ];

      for (const [index, record] of invalidRecords.entries()) {
        const writer = await createSessionImageManifest({
          env: { HOME: fixture.home },
          planId: `${fixture.planId}-invalid-${index}`
        });
        await expect(writer.append({
          ...(record as SessionImageManifestRecord),
          planId: index === 5 ? 'plan-different' : `${fixture.planId}-invalid-${index}`
        })).rejects.toThrow('manifest-record-invalid');
        expect(await readFile(writer.path, 'utf8')).toBe('');
      }

      await expect(createSessionImageManifest({
        env: { HOME: fixture.home },
        planId: '../private/path'
      })).rejects.toThrow('manifest-plan-id-invalid');
    } finally {
      await fixture.cleanup();
    }
  });

  test('serializes a validated canonical copy and rejects hidden serializers or accessor fields', async () => {
    const fixture = await makeFixture();
    try {
      const records = [
        prepared(fixture),
        prepared(fixture)
      ];
      Object.defineProperty(records[0], 'toJSON', {
        enumerable: false,
        value: () => ({ rawLine: 'SECRET' })
      });
      Object.defineProperty(records[1], 'sourceBytes', {
        enumerable: true,
        get: () => 4096
      });

      for (const [index, record] of records.entries()) {
        const planId = `${fixture.planId}-canonical-${index}`;
        (record as unknown as Record<string, unknown>).planId = planId;
        const writer = await createSessionImageManifest({
          env: { HOME: fixture.home },
          planId
        });
        await expect(writer.append(record)).rejects.toThrow('manifest-record-invalid');
        expect(await readFile(writer.path, 'utf8')).toBe('');
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test('rejects object coercion for enum-valued reason and status fields', async () => {
    const fixture = await makeFixture();
    try {
      const invalid = [
        {
          ...skipped(fixture),
          reason: { toString: () => 'known-placeholder' }
        },
        {
          ...summary(fixture),
          status: { toString: () => 'partial' }
        }
      ];
      for (const [index, record] of invalid.entries()) {
        const planId = `${fixture.planId}-enum-${index}`;
        const writer = await createSessionImageManifest({ env: { HOME: fixture.home }, planId });
        await expect(writer.append({
          ...(record as unknown as SessionImageManifestRecord),
          planId
        })).rejects.toThrow('manifest-record-invalid');
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test('latches an append failure and exposes only stable content-free errors', async () => {
    const fixture = await makeFixture();
    try {
      const writer = await createSessionImageManifest({
        env: { HOME: fixture.home },
        planId: fixture.planId
      });
      fsHooks.failNextSync = true;

      const first = await writer.append(runStart(fixture)).catch((error: unknown) => error);
      const second = await writer.append(runStart(fixture)).catch((error: unknown) => error);

      expect(first).toBeInstanceOf(Error);
      expect((first as Error).message).toBe('manifest-write-failed');
      expect((second as Error).message).toBe('manifest-writer-failed');
      expect(JSON.stringify([first, second])).not.toContain(fixture.home);
      expect(JSON.stringify([first, second])).not.toContain('synthetic path');
    } finally {
      await fixture.cleanup();
    }
  });

  test('blocks hardlinks, path replacement, and private-directory permission drift before append', async () => {
    const cases: Array<(fixture: Fixture, manifestPath: string) => Promise<void>> = [
      async (_fixture, manifestPath) => {
        await link(manifestPath, `${manifestPath}.hardlink`);
      },
      async (_fixture, manifestPath) => {
        await rename(manifestPath, `${manifestPath}.original`);
        await writeFile(manifestPath, '', { mode: 0o600, flag: 'wx' });
      },
      async (_fixture, manifestPath) => {
        await chmod(path.dirname(manifestPath), 0o755);
      }
    ];

    for (const mutate of cases) {
      const fixture = await makeFixture();
      try {
        const writer = await createSessionImageManifest({
          env: { HOME: fixture.home },
          planId: fixture.planId
        });
        await mutate(fixture, writer.path);

        await expect(writer.append(runStart(fixture))).rejects.toThrow('manifest-write-failed');
      } finally {
        await fixture.cleanup();
      }
    }
  });
});

describe('session-image-manifest.v1 schema', () => {
  test('accepts all six variants and rejects missing audit or raw content fields', async () => {
    const fixture = await makeFixture();
    try {
      const schema = JSON.parse(await readFile('schemas/session-image-manifest.v1.schema.json', 'utf8'));
      const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

      for (const record of allRecordVariants(fixture)) {
        expect(validate(record), JSON.stringify(validate.errors, null, 2)).toBe(true);
      }
      expect(validate({ ...prepared(fixture), rawLine: 'private' })).toBe(false);
      const { verificationsFailed: _omitted, ...missingAudit } = prepared(fixture);
      expect(validate(missingAudit)).toBe(false);
      expect(validate({ ...failed(fixture), code: '/private/path/error' })).toBe(false);
      expect(validate({ ...summary(fixture), at: '2026-02-31T00:00:00.000Z' })).toBe(false);
      expect(validate({ ...summary(fixture), at: '2025-02-29T00:00:00.000Z' })).toBe(false);
      expect(validate({ ...summary(fixture), at: '2024-02-29T23:59:59.999Z' })).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});

type Fixture = {
  home: string;
  planId: string;
  source: string;
  cleanup(): Promise<void>;
};

async function makeFixture(): Promise<Fixture> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aidm-manifest-home-'));
  await chmod(home, 0o700);
  return {
    home,
    planId: 'plan-manifest-test',
    source: path.join(home, '.codex', 'sessions', '2026', '08', 'rollout-test.jsonl'),
    cleanup: async () => rm(home, { recursive: true, force: true })
  };
}

function fileBase(fixture: Fixture, planId = fixture.planId): SessionImageManifestFileBase {
  return {
    schemaVersion: 1,
    planId,
    toolVersion: TOOL_VERSION,
    algorithmVersion: '1.0',
    placeholderSha256: 'a'.repeat(64),
    source: fixture.source,
    pathCategory: '<home>/.codex/sessions/<session-file>',
    verificationsPassed: ['json-parse', 'line-count'],
    verificationsFailed: [],
    at: '2026-08-25T00:00:00.000Z'
  };
}

function processingMetrics() {
  return {
    sourceBytes: 4096,
    resultBytes: 512,
    occurrencesSeen: 3,
    imagesPrunable: 2,
    imagesStripped: 2,
    knownPlaceholders: 1,
    belowMinimum: 0,
    lines: 10,
    sourceSha256: 'b'.repeat(64),
    resultSha256: 'c'.repeat(64)
  };
}

function runStart(fixture: Fixture, planId = fixture.planId): SessionImageManifestRecord {
  return {
    schemaVersion: 1,
    recordType: 'run-start',
    planId,
    toolVersion: TOOL_VERSION,
    algorithmVersion: '1.0',
    placeholderSha256: 'a'.repeat(64),
    at: '2026-08-25T00:00:00.000Z'
  };
}

function prepared(fixture: Fixture): SessionImageManifestRecord & { recordType: 'file-prepared' } {
  return {
    ...fileBase(fixture),
    ...processingMetrics(),
    recordType: 'file-prepared'
  };
}

function success(fixture: Fixture): SessionImageManifestRecord & { recordType: 'file-success' } {
  return {
    ...fileBase(fixture),
    ...processingMetrics(),
    recordType: 'file-success'
  };
}

function skipped(fixture: Fixture): SessionImageManifestRecord & { recordType: 'file-skip' } {
  return {
    ...fileBase(fixture),
    recordType: 'file-skip',
    occurrencesSeen: 1,
    knownPlaceholders: 1,
    reason: 'known-placeholder'
  };
}

function failed(fixture: Fixture): SessionImageManifestRecord & { recordType: 'file-failed' } {
  return {
    ...fileBase(fixture),
    recordType: 'file-failed',
    code: 'source-hash-drift',
    verificationsFailed: ['source-hash']
  };
}

function summary(fixture: Fixture): SessionImageManifestRecord {
  return {
    schemaVersion: 1,
    recordType: 'run-summary',
    planId: fixture.planId,
    status: 'partial',
    filesSucceeded: 1,
    filesSkipped: 1,
    filesFailed: 1,
    imagesStripped: 2,
    sourceBytes: 4096,
    resultBytes: 512,
    volumeFreeDeltaBytes: -4096,
    at: '2026-08-25T00:00:01.000Z'
  };
}

function allRecordVariants(fixture: Fixture): SessionImageManifestRecord[] {
  return [
    runStart(fixture),
    prepared(fixture),
    success(fixture),
    skipped(fixture),
    failed(fixture),
    summary(fixture)
  ];
}

async function manifestLines(manifestPath: string): Promise<string[]> {
  const content = await readFile(manifestPath, 'utf8');
  expect(content.endsWith('\n')).toBe(true);
  return content.trimEnd().split('\n');
}
