import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import {
  assertExistingPrivateDirSafe,
  assertPrivateAppDirSafe
} from '../fs-safety.js';
import { appDataHome } from '../paths.js';
import { TOOL_VERSION } from '../version.js';

export type SessionImageManifestFileBase = {
  schemaVersion: 1;
  planId: string;
  toolVersion: string;
  algorithmVersion: '1.0';
  placeholderSha256: string;
  source: string;
  pathCategory: string;
  sourceBytes?: number;
  resultBytes?: number;
  occurrencesSeen?: number;
  imagesPrunable?: number;
  imagesStripped?: number;
  knownPlaceholders?: number;
  belowMinimum?: number;
  lines?: number;
  sourceSha256?: string;
  resultSha256?: string;
  verificationsPassed: string[];
  verificationsFailed: string[];
  at: string;
};

export type SessionImageManifestRecord =
  | {
      schemaVersion: 1;
      recordType: 'run-start';
      planId: string;
      toolVersion: string;
      algorithmVersion: '1.0';
      placeholderSha256: string;
      at: string;
    }
  | (SessionImageManifestFileBase & {
      recordType: 'file-prepared';
      sourceBytes: number;
      resultBytes: number;
      occurrencesSeen: number;
      imagesPrunable: number;
      imagesStripped: number;
      knownPlaceholders: number;
      belowMinimum: number;
      lines: number;
      sourceSha256: string;
      resultSha256: string;
    })
  | (SessionImageManifestFileBase & {
      recordType: 'file-success';
      sourceBytes: number;
      resultBytes: number;
      occurrencesSeen: number;
      imagesPrunable: number;
      imagesStripped: number;
      knownPlaceholders: number;
      belowMinimum: number;
      lines: number;
      sourceSha256: string;
      resultSha256: string;
    })
  | (SessionImageManifestFileBase & {
      recordType: 'file-skip';
      reason: 'known-placeholder' | 'below-min-payload' | 'no-images' | 'no-prunable-images';
    })
  | (SessionImageManifestFileBase & { recordType: 'file-failed'; code: string })
  | {
      schemaVersion: 1;
      recordType: 'run-summary';
      planId: string;
      status: 'ok' | 'partial' | 'blocked';
      filesSucceeded: number;
      filesSkipped: number;
      filesFailed: number;
      imagesStripped: number;
      sourceBytes: number;
      resultBytes: number;
      volumeFreeDeltaBytes?: number;
      at: string;
    };

type ManifestWriter = {
  path: string;
  append(record: SessionImageManifestRecord): Promise<void>;
};

type FileIdentity = {
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
  nlink: number;
};

type DirectoryIdentity = {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
};

const PLAN_ID_PATTERN = /^plan-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STABLE_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_TEXT_PATTERN = /^[^\0\r\n]+$/u;
const TIMESTAMP_PATTERN = /^(?:(?:\d{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12]\d|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8])))|(?:(?:\d{2}(?:0[48]|[2468][048]|[13579][26])|(?:00|0[48]|[2468][048]|[13579][26])00)-02-29))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const MAX_SOURCE_CHARS = 4096;
const MAX_CATEGORY_CHARS = 512;
const MAX_VERIFICATIONS = 64;

const FILE_OPTIONAL_KEYS = [
  'sourceBytes',
  'resultBytes',
  'occurrencesSeen',
  'imagesPrunable',
  'imagesStripped',
  'knownPlaceholders',
  'belowMinimum',
  'lines',
  'sourceSha256',
  'resultSha256'
] as const;

const FILE_COMMON_KEYS = [
  'schemaVersion',
  'recordType',
  'planId',
  'toolVersion',
  'algorithmVersion',
  'placeholderSha256',
  'source',
  'pathCategory',
  ...FILE_OPTIONAL_KEYS,
  'verificationsPassed',
  'verificationsFailed',
  'at'
] as const;

const REQUIRED_PROCESSING_KEYS = [
  'sourceBytes',
  'resultBytes',
  'occurrencesSeen',
  'imagesPrunable',
  'imagesStripped',
  'knownPlaceholders',
  'belowMinimum',
  'lines',
  'sourceSha256',
  'resultSha256'
] as const;

export async function createSessionImageManifest(options: {
  env?: NodeJS.ProcessEnv;
  planId: string;
}): Promise<ManifestWriter> {
  const planId = options.planId;
  if (typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId)) {
    throw manifestError('manifest-plan-id-invalid');
  }

  const manifestsDir = path.join(appDataHome(options.env), 'manifests');
  const manifestPath = path.join(manifestsDir, `session-image-${planId}.jsonl`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    const directoryIdentity = await readPrivateDirectoryIdentity(manifestsDir, true);
    handle = await open(
      manifestPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const createdStats = await handle.stat();
    const fileIdentity = checkedNewManifestIdentity(createdStats);
    await handle.sync();
    assertManifestStats(await handle.stat(), fileIdentity, 0);
    await handle.close();
    handle = undefined;

    assertManifestStats(await lstat(manifestPath), fileIdentity, 0);
    const directoryAfter = await readPrivateDirectoryIdentity(manifestsDir, false);
    if (!sameDirectoryIdentity(directoryIdentity, directoryAfter)) {
      throw manifestError('manifest-create-failed');
    }

    return createManifestWriter({
      directoryIdentity,
      fileIdentity,
      manifestPath,
      manifestsDir,
      planId
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (errnoCode(error) === 'EEXIST') throw manifestError('manifest-already-exists');
    if (isManifestError(error)) throw error;
    throw manifestError('manifest-create-failed');
  }
}

function createManifestWriter(options: {
  directoryIdentity: DirectoryIdentity;
  fileIdentity: FileIdentity;
  manifestPath: string;
  manifestsDir: string;
  planId: string;
}): ManifestWriter {
  let expectedSize = 0;
  let failed = false;
  let queue: Promise<void> = Promise.resolve();

  return {
    path: options.manifestPath,
    append(record) {
      const operation = queue.then(async () => {
        if (failed) throw manifestError('manifest-writer-failed');
        try {
          const canonicalRecord = canonicalizeRecord(record);
          assertValidRecord(canonicalRecord, options.planId);
          expectedSize = await appendRecord({
            ...options,
            expectedSize,
            record: canonicalRecord
          });
        } catch (error) {
          failed = true;
          if (isManifestError(error) && error.message === 'manifest-record-invalid') {
            throw error;
          }
          throw manifestError('manifest-write-failed');
        }
      });
      queue = operation.catch(() => undefined);
      return operation;
    }
  };
}

async function appendRecord(options: {
  directoryIdentity: DirectoryIdentity;
  fileIdentity: FileIdentity;
  manifestPath: string;
  manifestsDir: string;
  expectedSize: number;
  record: SessionImageManifestRecord;
}): Promise<number> {
  const serialized = Buffer.from(`${serializeRecord(options.record)}\n`, 'utf8');
  const resultSize = options.expectedSize + serialized.byteLength;
  if (!Number.isSafeInteger(resultSize)) throw manifestError('manifest-write-failed');

  const directoryBefore = await readPrivateDirectoryIdentity(options.manifestsDir, false);
  if (!sameDirectoryIdentity(options.directoryIdentity, directoryBefore)) {
    throw manifestError('manifest-write-failed');
  }
  assertManifestStats(await lstat(options.manifestPath), options.fileIdentity, options.expectedSize);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      options.manifestPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
    );
    assertManifestStats(await handle.stat(), options.fileIdentity, options.expectedSize);
    assertManifestStats(await lstat(options.manifestPath), options.fileIdentity, options.expectedSize);
    await handle.writeFile(serialized);
    await handle.sync();
    assertManifestStats(await handle.stat(), options.fileIdentity, resultSize);
    assertManifestStats(await lstat(options.manifestPath), options.fileIdentity, resultSize);

    const directoryAfter = await readPrivateDirectoryIdentity(options.manifestsDir, false);
    if (!sameDirectoryIdentity(options.directoryIdentity, directoryAfter)) {
      throw manifestError('manifest-write-failed');
    }
    await handle.close();
    handle = undefined;
    return resultSize;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readPrivateDirectoryIdentity(
  directory: string,
  createMissing: boolean
): Promise<DirectoryIdentity> {
  const blockers = createMissing
    ? await assertPrivateAppDirSafe(directory)
    : await assertExistingPrivateDirSafe(directory);
  if (blockers.length > 0) throw manifestError('manifest-directory-unsafe');

  const stats = await lstat(directory);
  const uid = process.getuid?.();
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || (uid !== undefined && stats.uid !== uid)
    || (stats.mode & 0o777) !== 0o700
  ) {
    throw manifestError('manifest-directory-unsafe');
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    mode: stats.mode & 0o777
  };
}

function checkedNewManifestIdentity(stats: Stats): FileIdentity {
  const identity = fileIdentity(stats);
  assertManifestStats(stats, identity, 0);
  return identity;
}

function assertManifestStats(stats: Stats, expected: FileIdentity, expectedSize: number): void {
  const uid = process.getuid?.();
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1
    || (uid !== undefined && stats.uid !== uid)
    || (stats.mode & 0o777) !== 0o600
    || stats.dev !== expected.dev
    || stats.ino !== expected.ino
    || stats.uid !== expected.uid
    || stats.gid !== expected.gid
    || (stats.mode & 0o777) !== expected.mode
    || stats.nlink !== expected.nlink
    || stats.size !== expectedSize
  ) {
    throw manifestError('manifest-file-unsafe');
  }
}

function fileIdentity(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode & 0o777,
    nlink: stats.nlink
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode;
}

function assertValidRecord(record: unknown, planId: string): asserts record is SessionImageManifestRecord {
  if (!isPlainRecord(record) || record.schemaVersion !== 1 || record.planId !== planId) {
    throw manifestError('manifest-record-invalid');
  }

  switch (record.recordType) {
    case 'run-start':
      assertExactKeys(record, [
        'schemaVersion',
        'recordType',
        'planId',
        'toolVersion',
        'algorithmVersion',
        'placeholderSha256',
        'at'
      ]);
      assertToolFields(record);
      break;
    case 'file-prepared':
    case 'file-success':
      assertExactKeys(record, FILE_COMMON_KEYS);
      assertFileFields(record);
      for (const key of REQUIRED_PROCESSING_KEYS) {
        if (!(key in record) || record[key] === undefined) {
          throw manifestError('manifest-record-invalid');
        }
      }
      break;
    case 'file-skip':
      assertExactKeys(record, [...FILE_COMMON_KEYS, 'reason']);
      assertFileFields(record);
      if (typeof record.reason !== 'string' || ![
        'known-placeholder',
        'below-min-payload',
        'no-images',
        'no-prunable-images'
      ].includes(record.reason)) {
        throw manifestError('manifest-record-invalid');
      }
      break;
    case 'file-failed':
      assertExactKeys(record, [...FILE_COMMON_KEYS, 'code']);
      assertFileFields(record);
      if (!isStableCode(record.code)) throw manifestError('manifest-record-invalid');
      break;
    case 'run-summary':
      assertExactKeys(record, [
        'schemaVersion',
        'recordType',
        'planId',
        'status',
        'filesSucceeded',
        'filesSkipped',
        'filesFailed',
        'imagesStripped',
        'sourceBytes',
        'resultBytes',
        'volumeFreeDeltaBytes',
        'at'
      ]);
      if (typeof record.status !== 'string' || !['ok', 'partial', 'blocked'].includes(record.status)) {
        throw manifestError('manifest-record-invalid');
      }
      for (const key of [
        'filesSucceeded',
        'filesSkipped',
        'filesFailed',
        'imagesStripped',
        'sourceBytes',
        'resultBytes'
      ] as const) {
        if (!isNonNegativeSafeInteger(record[key])) throw manifestError('manifest-record-invalid');
      }
      if (record.volumeFreeDeltaBytes !== undefined && !Number.isSafeInteger(record.volumeFreeDeltaBytes)) {
        throw manifestError('manifest-record-invalid');
      }
      assertTimestamp(record.at);
      break;
    default:
      throw manifestError('manifest-record-invalid');
  }
}

function assertToolFields(record: Record<string, unknown>): void {
  if (
    record.toolVersion !== TOOL_VERSION
    || record.algorithmVersion !== '1.0'
    || typeof record.placeholderSha256 !== 'string'
    || !SHA256_PATTERN.test(record.placeholderSha256)
  ) {
    throw manifestError('manifest-record-invalid');
  }
  assertTimestamp(record.at);
}

function assertFileFields(record: Record<string, unknown>): void {
  assertToolFields(record);
  if (
    typeof record.source !== 'string'
    || record.source.length > MAX_SOURCE_CHARS
    || !SAFE_TEXT_PATTERN.test(record.source)
    || !path.isAbsolute(record.source)
    || typeof record.pathCategory !== 'string'
    || record.pathCategory.length > MAX_CATEGORY_CHARS
    || !SAFE_TEXT_PATTERN.test(record.pathCategory)
  ) {
    throw manifestError('manifest-record-invalid');
  }

  for (const key of FILE_OPTIONAL_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (key === 'sourceSha256' || key === 'resultSha256') {
      if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        throw manifestError('manifest-record-invalid');
      }
    } else if (!isNonNegativeSafeInteger(value)) {
      throw manifestError('manifest-record-invalid');
    }
  }
  assertVerificationList(record.verificationsPassed);
  assertVerificationList(record.verificationsFailed);
}

function assertVerificationList(value: unknown): void {
  if (
    !Array.isArray(value)
    || value.length > MAX_VERIFICATIONS
    || new Set(value).size !== value.length
    || !value.every(isStableCode)
  ) {
    throw manifestError('manifest-record-invalid');
  }
}

function assertTimestamp(value: unknown): void {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    throw manifestError('manifest-record-invalid');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw manifestError('manifest-record-invalid');
  }
}

function canonicalizeRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw manifestError('manifest-record-invalid');
  const canonical: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw manifestError('manifest-record-invalid');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw manifestError('manifest-record-invalid');
    }
    canonical[key] = key === 'verificationsPassed' || key === 'verificationsFailed'
      ? canonicalizeVerificationArray(descriptor.value)
      : descriptor.value;
  }
  return canonical;
}

function canonicalizeVerificationArray(value: unknown): unknown {
  if (!Array.isArray(value) || value.length > MAX_VERIFICATIONS) return value;
  const allowedKeys = new Set(['length', ...value.map((_, index) => String(index))]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw manifestError('manifest-record-invalid');
  }
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw manifestError('manifest-record-invalid');
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function serializeRecord(record: SessionImageManifestRecord): string {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    const serialized = Array.isArray(value)
      ? `[${value.map((item) => JSON.stringify(item)).join(',')}]`
      : JSON.stringify(value);
    if (serialized === undefined) throw manifestError('manifest-record-invalid');
    fields.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${fields.join(',')}}`;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw manifestError('manifest-record-invalid');
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isStableCode(value: unknown): value is string {
  return typeof value === 'string' && STABLE_CODE_PATTERN.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

class ManifestError extends Error {
  override readonly name = 'SessionImageManifestError';
}

function manifestError(code: string): ManifestError {
  return new ManifestError(code);
}

function isManifestError(error: unknown): error is ManifestError {
  return error instanceof ManifestError;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}
