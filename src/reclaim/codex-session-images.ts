import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { collectFileIdentity } from '../fs-safety.js';
import { defaultCodexHome, resolveHome } from '../paths.js';
import type { FileIdentity } from '../types.js';
import { TOOL_VERSION } from '../version.js';
import { readJsonlLines } from './jsonl-stream.js';
import {
  analyzeSessionImageLine,
  rewriteSessionImageLine
} from './session-image-format.js';

export type CodexSessionImageScanOptions = {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  olderThanDays?: number;
  minFileSizeBytes?: number;
  maxFiles?: number;
};

export type CodexSessionImageCandidate = {
  path: string;
  pathCategory: string;
  sourceBytes: number;
  projectedBytes: number;
  occurrencesSeen: number;
  imagesPrunable: number;
  knownPlaceholders: number;
  belowMinimum: number;
  lines: number;
  sourceSha256: string;
  identity: FileIdentity;
};

export type CodexSessionImagePrivateOutcome = {
  path: string;
  pathCategory: string;
  status: 'skipped' | 'blocked';
  code:
    | 'no-prunable-images'
    | 'ambiguous-data-url'
    | 'invalid-json'
    | 'line-too-large'
    | 'invalid-utf8'
    | 'unsafe-file';
};

type CodexSessionImageTotals = {
  filesConsidered: number;
  filesOpened: number;
  filesSkippedBySize: number;
  filesSkippedAfterRead: number;
  filesBlocked: number;
  sourceBytes: number;
  projectedBytes: number;
  reclaimableBytes: number;
  occurrencesSeen: number;
  imagesPrunable: number;
  knownPlaceholders: number;
  belowMinimum: number;
};

export type CodexSessionImageScanResult = {
  status: 'ok' | 'partial' | 'blocked';
  contentRead: true;
  candidates: CodexSessionImageCandidate[];
  privateOutcomes: CodexSessionImagePrivateOutcome[];
  totals: CodexSessionImageTotals;
  blockedReasons: string[];
  warnings: string[];
};

export type PublicCodexSessionImageScanResult = {
  schemaVersion: 1;
  toolVersion: string;
  command: 'reclaim scan codex-session-images';
  status: CodexSessionImageScanResult['status'];
  contentRead: true;
  filters: { olderThanDays: number; minFileSizeBytes: number };
  totals: CodexSessionImageScanResult['totals'] & { candidateFiles: number };
  blockedReasons: string[];
  warnings: string[];
};

const DEFAULT_OLDER_THAN_DAYS = 30;
const DEFAULT_MIN_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const SESSION_PATH_CATEGORY = '<home>/.codex/sessions/<session-file>';
const PUBLIC_BLOCKED_REASON_CODES = new Set([
  'ambiguous-data-url',
  'custom-codex-home-unsupported',
  'invalid-json',
  'invalid-utf8',
  'line-too-large',
  'platform-unsupported',
  'unsafe-codex-root',
  'unsafe-file',
  'unsafe-home-root',
  'unsafe-sessions-root'
]);
const PUBLIC_WARNING_CODES = new Set([
  'compressed-session-files-protected',
  'session-directory-unreadable',
  'session-file-limit-reached',
  'size-filtered-estimate-is-lower-bound',
  'unsafe-session-directory-skipped'
]);

export async function scanCodexSessionImages(
  options: CodexSessionImageScanOptions = {}
): Promise<CodexSessionImageScanResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const olderThanDays = nonNegativeSafeInteger(
    options.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS,
    'olderThanDays'
  );
  const minFileSizeBytes = nonNegativeSafeInteger(
    options.minFileSizeBytes ?? DEFAULT_MIN_FILE_SIZE_BYTES,
    'minFileSizeBytes'
  );
  const maxFiles = positiveSafeInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 'maxFiles');
  const warnings = minFileSizeBytes > 0
    ? ['size-filtered-estimate-is-lower-bound']
    : [];
  if (process.platform !== 'darwin') {
    return emptyScan('blocked', ['platform-unsupported'], warnings);
  }
  const home = defaultCodexHome(env);
  if (home.custom) {
    return emptyScan('blocked', ['custom-codex-home-unsupported'], warnings);
  }

  const homeRoot = resolveHome(env);
  const homeInfo = await lstat(homeRoot).catch(() => undefined);
  const canonicalHomeRoot = await realpath(homeRoot).catch(() => undefined);
  if (!homeInfo || !safeDirectoryInfo(homeInfo) || !canonicalHomeRoot) {
    return emptyScan('blocked', ['unsafe-home-root'], warnings);
  }

  const codexRootInfo = await lstat(home.codexHome).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (!codexRootInfo) return emptyScan('ok', [], warnings);
  const canonicalCodexRoot = await realpath(home.codexHome).catch(() => undefined);
  if (
    !safeDirectoryInfo(codexRootInfo)
    || !canonicalCodexRoot
    || canonicalCodexRoot !== path.join(canonicalHomeRoot, '.codex')
  ) {
    return emptyScan('blocked', ['unsafe-codex-root'], warnings);
  }

  const sessionsRoot = path.join(home.codexHome, 'sessions');
  const rootInfo = await lstat(sessionsRoot).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (!rootInfo) return emptyScan('ok', [], warnings);
  if (!safeDirectoryInfo(rootInfo)) {
    return emptyScan('blocked', ['unsafe-sessions-root'], warnings);
  }
  const canonicalSessionsRoot = await realpath(sessionsRoot).catch(() => undefined);
  if (!canonicalSessionsRoot) {
    return emptyScan('blocked', ['unsafe-sessions-root'], warnings);
  }
  if (canonicalSessionsRoot !== path.join(canonicalCodexRoot, 'sessions')) {
    return emptyScan('blocked', ['unsafe-sessions-root'], warnings);
  }

  const enumeration = await enumerateSessionFiles(sessionsRoot, maxFiles);
  warnings.push(...enumeration.warnings);
  if (enumeration.compressedFiles > 0) {
    warnings.push('compressed-session-files-protected');
  }

  const totals = emptyTotals();
  totals.filesConsidered = enumeration.plainFiles.length;
  const privateOutcomes: CodexSessionImagePrivateOutcome[] = [];
  const metadataCandidates: Array<{ path: string; identity: FileIdentity }> = [];
  const cutoffMs = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;

  for (const filePath of enumeration.plainFiles) {
    const identity = await collectFileIdentity(filePath, SESSION_PATH_CATEGORY).catch(() => undefined);
    if (!identity || !safeSessionIdentity(identity, canonicalSessionsRoot)) {
      privateOutcomes.push(privateOutcome(filePath, 'blocked', 'unsafe-file'));
      totals.filesBlocked += 1;
      continue;
    }
    if ((identity.mtimeMs ?? Number.POSITIVE_INFINITY) > cutoffMs) continue;
    if ((identity.size ?? 0) < minFileSizeBytes) {
      totals.filesSkippedBySize += 1;
      continue;
    }
    metadataCandidates.push({ path: filePath, identity });
  }

  const candidates: CodexSessionImageCandidate[] = [];
  for (const metadata of metadataCandidates) {
    totals.filesOpened += 1;
    const scanned = await scanCandidateFile(metadata.path, metadata.identity);
    if ('outcome' in scanned) {
      privateOutcomes.push(scanned.outcome);
      if (scanned.outcome.status === 'blocked') totals.filesBlocked += 1;
      else totals.filesSkippedAfterRead += 1;
      continue;
    }

    candidates.push(scanned.candidate);
    totals.sourceBytes += scanned.candidate.sourceBytes;
    totals.projectedBytes += scanned.candidate.projectedBytes;
    totals.reclaimableBytes += scanned.candidate.sourceBytes - scanned.candidate.projectedBytes;
    totals.occurrencesSeen += scanned.candidate.occurrencesSeen;
    totals.imagesPrunable += scanned.candidate.imagesPrunable;
    totals.knownPlaceholders += scanned.candidate.knownPlaceholders;
    totals.belowMinimum += scanned.candidate.belowMinimum;
  }

  const blockedReasons = uniqueSorted(
    privateOutcomes
      .filter((outcome) => outcome.status === 'blocked')
      .map((outcome) => outcome.code)
  );
  const partial = totals.filesBlocked > 0
    || enumeration.partial
    || enumeration.compressedFiles > 0;

  return {
    status: partial ? 'partial' : 'ok',
    contentRead: true,
    candidates,
    privateOutcomes,
    totals,
    blockedReasons,
    warnings: uniqueInOrder(warnings)
  };
}

export function publicCodexSessionImageScanResult(
  result: CodexSessionImageScanResult,
  filters: PublicCodexSessionImageScanResult['filters']
): PublicCodexSessionImageScanResult {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    command: 'reclaim scan codex-session-images',
    status: result.status,
    contentRead: true,
    filters: {
      olderThanDays: filters.olderThanDays,
      minFileSizeBytes: filters.minFileSizeBytes
    },
    totals: {
      filesConsidered: result.totals.filesConsidered,
      filesOpened: result.totals.filesOpened,
      filesSkippedBySize: result.totals.filesSkippedBySize,
      filesSkippedAfterRead: result.totals.filesSkippedAfterRead,
      filesBlocked: result.totals.filesBlocked,
      sourceBytes: result.totals.sourceBytes,
      projectedBytes: result.totals.projectedBytes,
      reclaimableBytes: result.totals.reclaimableBytes,
      occurrencesSeen: result.totals.occurrencesSeen,
      imagesPrunable: result.totals.imagesPrunable,
      knownPlaceholders: result.totals.knownPlaceholders,
      belowMinimum: result.totals.belowMinimum,
      candidateFiles: result.candidates.length
    },
    blockedReasons: uniqueInOrder(
      result.blockedReasons.filter((reason) => PUBLIC_BLOCKED_REASON_CODES.has(reason))
    ),
    warnings: uniqueInOrder(
      result.warnings.filter((warning) => PUBLIC_WARNING_CODES.has(warning))
    )
  };
}

async function scanCandidateFile(
  filePath: string,
  identity: FileIdentity
): Promise<
  | { candidate: CodexSessionImageCandidate }
  | { outcome: CodexSessionImagePrivateOutcome }
> {
  const sourceHash = createHash('sha256');
  let sourceBytes = 0;
  let projectedBytes = 0;
  let occurrencesSeen = 0;
  let imagesPrunable = 0;
  let knownPlaceholders = 0;
  let belowMinimum = 0;
  let lines = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedInfo = await handle.stat();
    if (!sameIdentityAsStats(identity, openedInfo)) {
      return { outcome: privateOutcome(filePath, 'blocked', 'unsafe-file') };
    }

    for await (const line of readJsonlLines(filePath, { fileDescriptor: handle.fd })) {
      lines += 1;
      sourceBytes += line.bytes.length;
      sourceHash.update(line.bytes);

      if (!jsonWhitespaceOnly(line.text)) {
        try {
          JSON.parse(line.text);
        } catch {
          return { outcome: privateOutcome(filePath, 'blocked', 'invalid-json') };
        }
      }

      const analysis = analyzeSessionImageLine(line.text);
      occurrencesSeen += analysis.occurrences.length;
      for (const occurrence of analysis.occurrences) {
        if (occurrence.kind === 'replace') imagesPrunable += 1;
        if (occurrence.kind === 'skip' && occurrence.reason === 'known-placeholder') {
          knownPlaceholders += 1;
        }
        if (occurrence.kind === 'skip' && occurrence.reason === 'below-min-payload') {
          belowMinimum += 1;
        }
      }
      if (analysis.blocked) {
        return { outcome: privateOutcome(filePath, 'blocked', 'ambiguous-data-url') };
      }

      const rewritten = rewriteSessionImageLine(line.text, analysis);
      projectedBytes += Buffer.byteLength(rewritten.output);
    }

    const completedInfo = await handle.stat();
    if (!sameIdentityAsStats(identity, completedInfo) || sourceBytes !== completedInfo.size) {
      return { outcome: privateOutcome(filePath, 'blocked', 'unsafe-file') };
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === 'line-too-large' || code === 'invalid-utf8') {
      return { outcome: privateOutcome(filePath, 'blocked', code) };
    }
    return { outcome: privateOutcome(filePath, 'blocked', 'unsafe-file') };
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const currentIdentity = await collectFileIdentity(filePath, SESSION_PATH_CATEGORY).catch(() => undefined);
  if (!currentIdentity || !sameIdentity(identity, currentIdentity) || sourceBytes !== identity.size) {
    return { outcome: privateOutcome(filePath, 'blocked', 'unsafe-file') };
  }
  if (imagesPrunable === 0) {
    return { outcome: privateOutcome(filePath, 'skipped', 'no-prunable-images') };
  }

  return {
    candidate: {
      path: filePath,
      pathCategory: SESSION_PATH_CATEGORY,
      sourceBytes,
      projectedBytes,
      occurrencesSeen,
      imagesPrunable,
      knownPlaceholders,
      belowMinimum,
      lines,
      sourceSha256: sourceHash.digest('hex'),
      identity
    }
  };
}

async function enumerateSessionFiles(
  sessionsRoot: string,
  maxFiles: number
): Promise<{
  plainFiles: string[];
  compressedFiles: number;
  partial: boolean;
  warnings: string[];
}> {
  const plainFiles: string[] = [];
  const warnings: string[] = [];
  const queue = [sessionsRoot];
  let cursor = 0;
  let compressedFiles = 0;
  let partial = false;

  while (cursor < queue.length && plainFiles.length < maxFiles) {
    const directory = queue[cursor];
    cursor += 1;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
    if (!entries) {
      partial = true;
      warnings.push('session-directory-unreadable');
      continue;
    }

    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'maintenance-archive') continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const info = await lstat(entryPath).catch(() => undefined);
        if (info && safeDirectoryInfo(info)) queue.push(entryPath);
        else {
          partial = true;
          warnings.push('unsafe-session-directory-skipped');
        }
        continue;
      }
      if (entry.name.endsWith('.jsonl.zst')) {
        compressedFiles += 1;
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      if (plainFiles.length >= maxFiles) {
        partial = true;
        warnings.push('session-file-limit-reached');
        break;
      }
      plainFiles.push(entryPath);
    }
  }

  if (cursor < queue.length || plainFiles.length >= maxFiles) {
    partial = true;
    warnings.push('session-file-limit-reached');
  }

  return {
    plainFiles: plainFiles.sort(),
    compressedFiles,
    partial,
    warnings: uniqueInOrder(warnings)
  };
}

function safeDirectoryInfo(info: Stats): boolean {
  const uid = process.getuid?.();
  return info.isDirectory()
    && !info.isSymbolicLink()
    && (uid === undefined || info.uid === uid)
    && (info.mode & 0o022) === 0;
}

function safeSessionIdentity(identity: FileIdentity, sessionsRoot: string): boolean {
  const uid = process.getuid?.();
  if (!identity.exists || !identity.regularFile || identity.symbolicLink) return false;
  if (identity.nlink !== 1) return false;
  if (uid !== undefined && identity.uid !== uid) return false;
  if (identity.mode === undefined || (identity.mode & 0o022) !== 0) return false;
  if (!identity.realpath || !containedBy(sessionsRoot, identity.realpath)) return false;
  return true;
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative);
}

function sameIdentity(before: FileIdentity, after: FileIdentity): boolean {
  const keys: Array<keyof FileIdentity> = [
    'exists',
    'regularFile',
    'symbolicLink',
    'realpath',
    'dev',
    'ino',
    'mode',
    'uid',
    'gid',
    'size',
    'mtimeMs',
    'nlink'
  ];
  return keys.every((key) => before[key] === after[key]);
}

function sameIdentityAsStats(identity: FileIdentity, info: Stats): boolean {
  const uid = process.getuid?.();
  return identity.exists
    && identity.regularFile
    && !identity.symbolicLink
    && info.isFile()
    && !info.isSymbolicLink()
    && info.nlink === 1
    && (uid === undefined || info.uid === uid)
    && (info.mode & 0o022) === 0
    && identity.dev === info.dev
    && identity.ino === info.ino
    && identity.mode === info.mode
    && identity.uid === info.uid
    && identity.gid === info.gid
    && identity.size === info.size
    && identity.mtimeMs === info.mtimeMs
    && identity.nlink === info.nlink;
}

function privateOutcome(
  filePath: string,
  status: CodexSessionImagePrivateOutcome['status'],
  code: CodexSessionImagePrivateOutcome['code']
): CodexSessionImagePrivateOutcome {
  return {
    path: filePath,
    pathCategory: SESSION_PATH_CATEGORY,
    status,
    code
  };
}

function emptyScan(
  status: CodexSessionImageScanResult['status'],
  blockedReasons: string[],
  warnings: string[]
): CodexSessionImageScanResult {
  return {
    status,
    contentRead: true,
    candidates: [],
    privateOutcomes: [],
    totals: emptyTotals(),
    blockedReasons,
    warnings: uniqueInOrder(warnings)
  };
}

function emptyTotals(): CodexSessionImageTotals {
  return {
    filesConsidered: 0,
    filesOpened: 0,
    filesSkippedBySize: 0,
    filesSkippedAfterRead: 0,
    filesBlocked: 0,
    sourceBytes: 0,
    projectedBytes: 0,
    reclaimableBytes: 0,
    occurrencesSeen: 0,
    imagesPrunable: 0,
    knownPlaceholders: 0,
    belowMinimum: 0
  };
}

function jsonWhitespaceOnly(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') {
      return false;
    }
  }
  return true;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
