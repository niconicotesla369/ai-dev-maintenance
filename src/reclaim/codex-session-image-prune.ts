import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { collectFileIdentity } from '../fs-safety.js';
import type { FileIdentity } from '../types.js';
import { TOOL_VERSION } from '../version.js';
import { preflightCodexSessionMutation } from './codex-preflight.js';
import type {
  CodexSessionImageCandidate,
  CodexSessionImagePrivateOutcome
} from './codex-session-images.js';
import { readJsonlLines } from './jsonl-stream.js';
import {
  analyzeSessionImageLine,
  rewriteSessionImageLine,
  SESSION_IMAGE_PLACEHOLDER_PAYLOAD
} from './session-image-format.js';
import {
  createSessionImageManifest,
  type SessionImageManifestFileBase,
  type SessionImageManifestRecord
} from './session-image-manifest.js';

export type CodexSessionImagePruneResult = {
  status: 'ok' | 'partial' | 'blocked';
  changed: boolean;
  filesSucceeded: number;
  filesSkipped: number;
  filesFailed: number;
  imagesStripped: number;
  sourceBytes: number;
  resultBytes: number;
  reclaimedBytes: number;
  volumeFreeDeltaBytes?: number;
  manifestPathCategory: string;
  blockedReasons: string[];
  warnings: string[];
};

type PreparedFile = {
  candidate: CodexSessionImageCandidate;
  tempPath: string;
  tempIdentity: Stats;
  sourceBytes: number;
  resultBytes: number;
  occurrencesSeen: number;
  imagesStripped: number;
  knownPlaceholders: number;
  belowMinimum: number;
  lines: number;
  sourceSha256: string;
  resultSha256: string;
  nonImageSha256: string;
};

type ProcessingManifestRecord = SessionImageManifestFileBase & {
  recordType: 'file-prepared' | 'file-success';
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
};

type Aggregate = {
  changed: boolean;
  filesSucceeded: number;
  filesSkipped: number;
  filesFailed: number;
  imagesStripped: number;
  sourceBytes: number;
  resultBytes: number;
  volumeFreeDeltaBytes?: number;
  blockedReasons: string[];
  warnings: string[];
};

const MANIFEST_PATH_CATEGORY = '<home>/.ai-dev-maintenance/manifests/<manifest-file>';
const ALGORITHM_VERSION = '1.0' as const;
const PLACEHOLDER_SHA256 = createHash('sha256')
  .update(SESSION_IMAGE_PLACEHOLDER_PAYLOAD, 'utf8')
  .digest('hex');
const NON_IMAGE_SENTINEL = '\u0000AIDM-IMAGE\u0000';
const STABLE_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function pruneCodexSessionImages(options: {
  env?: NodeJS.ProcessEnv;
  planId: string;
  candidates: CodexSessionImageCandidate[];
  excludedOutcomes: CodexSessionImagePrivateOutcome[];
}): Promise<CodexSessionImagePruneResult> {
  const aggregate = emptyAggregate();
  if (options.candidates.length === 0) {
    aggregate.blockedReasons.push('no-candidates');
    return publicResult(aggregate);
  }

  let requiredTemporaryBytes: number;
  try {
    requiredTemporaryBytes = largestProjectedBytes(options.candidates);
  } catch {
    aggregate.blockedReasons.push('candidate-metrics-invalid');
    return publicResult(aggregate);
  }
  let preflight;
  try {
    preflight = await preflightCodexSessionMutation({
      env: options.env,
      targets: options.candidates.map((candidate) => ({
        path: candidate.path,
        identity: candidate.identity
      })),
      requiredTemporaryBytes
    });
  } catch {
    aggregate.blockedReasons.push('preflight-check-unavailable');
    return publicResult(aggregate);
  }
  if (!preflight.allowed) {
    aggregate.blockedReasons.push(...stableCodes(preflight.blockedReasons));
    if (aggregate.blockedReasons.length === 0) {
      aggregate.blockedReasons.push('preflight-check-unavailable');
    }
    return publicResult(aggregate);
  }

  let manifest: Awaited<ReturnType<typeof createSessionImageManifest>>;
  try {
    manifest = await createSessionImageManifest({ env: options.env, planId: options.planId });
    await manifest.append(runStartRecord(options.planId));
  } catch {
    aggregate.blockedReasons.push('manifest-write-failed');
    return publicResult(aggregate);
  }

  for (const outcome of options.excludedOutcomes) {
    const record = excludedOutcomeRecord(options.planId, outcome);
    try {
      await manifest.append(record);
    } catch {
      aggregate.blockedReasons.push('manifest-write-failed');
      return publicResult(aggregate);
    }
    if (record.recordType === 'file-skip') aggregate.filesSkipped += 1;
    else {
      aggregate.filesFailed += 1;
      aggregate.blockedReasons.push(outcome.code);
    }
  }

  let manifestFailed = false;
  for (const candidate of options.candidates) {
    let prepared: PreparedFile;
    try {
      prepared = await prepareCandidate(candidate);
    } catch (error) {
      aggregate.filesFailed += 1;
      const code = pruneErrorCode(error, 'file-prepare-failed');
      aggregate.blockedReasons.push(code);
      try {
        await manifest.append(fileFailureRecord(options.planId, candidate, code));
      } catch {
        manifestFailed = true;
        aggregate.blockedReasons.push('manifest-write-failed');
      }
      break;
    }

    try {
      await manifest.append(filePreparedRecord(options.planId, prepared));
    } catch {
      await cleanupTemporary(prepared.tempPath, prepared.tempIdentity, aggregate);
      aggregate.filesFailed += 1;
      aggregate.blockedReasons.push('manifest-write-failed');
      manifestFailed = true;
      break;
    }

    let sourceGuard: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await validatePreparedFile(prepared, prepared.tempPath);
      await finalMutationPreflight(options.env, candidate, prepared.resultBytes);
      sourceGuard = await openRevalidatedSource(candidate);
    } catch (error) {
      await cleanupTemporary(prepared.tempPath, prepared.tempIdentity, aggregate);
      aggregate.filesFailed += 1;
      const code = pruneErrorCode(error, 'source-revalidation-failed');
      aggregate.blockedReasons.push(code);
      try {
        await manifest.append(fileFailureRecord(options.planId, candidate, code));
      } catch {
        manifestFailed = true;
        aggregate.blockedReasons.push('manifest-write-failed');
      }
      break;
    }

    let renamed = false;
    let committedValidated = false;
    let parentSynced = false;
    try {
      await rename(prepared.tempPath, candidate.path);
      renamed = true;
      if (!sameRetiredSourceStats(await sourceGuard.stat(), candidate.identity)) {
        throw pruneError('source-changed-during-commit');
      }
      await validatePreparedFile(prepared, candidate.path);
      committedValidated = true;
      parentSynced = await syncParentDirectory(path.dirname(candidate.path), aggregate.warnings);
    } catch (error) {
      if (!renamed) {
        await cleanupTemporary(prepared.tempPath, prepared.tempIdentity, aggregate);
      }
      aggregate.filesFailed += 1;
      const code = renamed
        ? pruneErrorCode(error, 'post-rename-verification-failed')
        : 'atomic-rename-failed';
      aggregate.blockedReasons.push(code);
      if (renamed && committedValidated) addChangedMetrics(aggregate, prepared);
      else if (renamed) aggregate.changed = true;
      try {
        await manifest.append(fileFailureRecord(options.planId, candidate, code));
      } catch {
        manifestFailed = true;
        aggregate.blockedReasons.push('manifest-write-failed');
      }
      break;
    } finally {
      await sourceGuard?.close().catch(() => undefined);
      sourceGuard = undefined;
    }

    try {
      await manifest.append(fileSuccessRecord(options.planId, prepared, parentSynced));
    } catch {
      addChangedMetrics(aggregate, prepared);
      aggregate.filesFailed += 1;
      aggregate.blockedReasons.push('manifest-write-failed');
      manifestFailed = true;
      break;
    }

    addChangedMetrics(aggregate, prepared);
    aggregate.filesSucceeded += 1;
  }

  if (aggregate.changed && preflight.availableBytes !== undefined) {
    const measured = await availableBytesFor(options.candidates[0].path);
    if (measured === undefined) aggregate.warnings.push('volume-free-delta-unavailable');
    else aggregate.volumeFreeDeltaBytes = measured - preflight.availableBytes;
  }

  if (!manifestFailed) {
    try {
      await manifest.append(runSummaryRecord(options.planId, aggregate));
    } catch {
      aggregate.blockedReasons.push('manifest-write-failed');
    }
  }

  return publicResult(aggregate);
}

async function prepareCandidate(candidate: CodexSessionImageCandidate): Promise<PreparedFile> {
  const tempPath = path.join(
    path.dirname(candidate.path),
    `.aidm-session-image-${randomBytes(8).toString('hex')}.tmp`
  );
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let temporary: Awaited<ReturnType<typeof open>> | undefined;
  let cleanupIdentity: Stats | undefined;
  let keepTemporary = false;

  try {
    source = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceStats = await source.stat();
    if (!sameStatsAsIdentity(sourceStats, candidate.identity)) {
      throw pruneError('source-identity-changed');
    }

    temporary = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const initialTempStats = await temporary.stat();
    cleanupIdentity = initialTempStats;
    if (!safeNewTemporary(initialTempStats)) throw pruneError('temp-create-unsafe');

    const sourceHash = createHash('sha256');
    const resultHash = createHash('sha256');
    const sourceNonImageHash = createHash('sha256');
    const resultNonImageHash = createHash('sha256');
    let sourceBytes = 0;
    let resultBytes = 0;
    let occurrencesSeen = 0;
    let resultOccurrencesSeen = 0;
    let imagesStripped = 0;
    let imagesPrunable = 0;
    let knownPlaceholders = 0;
    let belowMinimum = 0;
    let resultKnownPlaceholders = 0;
    let resultBelowMinimum = 0;
    let resultPrunable = 0;
    let lines = 0;

    for await (const line of readJsonlLines(candidate.path, { fileDescriptor: source.fd })) {
      lines += 1;
      sourceBytes += line.bytes.length;
      sourceHash.update(line.bytes);
      assertJsonLine(line.text);

      const analysis = analyzeSessionImageLine(line.text);
      if (analysis.blocked) throw pruneError('ambiguous-data-url');
      occurrencesSeen += analysis.occurrences.length;
      imagesPrunable += analysis.occurrences.filter((item) => item.kind === 'replace').length;
      knownPlaceholders += analysis.occurrences.filter(
        (item) => item.kind === 'skip' && item.reason === 'known-placeholder'
      ).length;
      belowMinimum += analysis.occurrences.filter(
        (item) => item.kind === 'skip' && item.reason === 'below-min-payload'
      ).length;
      sourceNonImageHash.update(nonImageProjection(line.text, analysis));

      const rewritten = rewriteSessionImageLine(line.text, analysis);
      if (rewritten.imagesStripped === 0 && imagesPrunable > imagesStripped) {
        throw pruneError('rewrite-verification-failed');
      }
      imagesStripped += rewritten.imagesStripped;
      assertJsonLine(rewritten.output);
      const resultAnalysis = analyzeSessionImageLine(rewritten.output);
      if (resultAnalysis.blocked) throw pruneError('result-image-invalid');
      resultOccurrencesSeen += resultAnalysis.occurrences.length;
      resultKnownPlaceholders += resultAnalysis.occurrences.filter(
        (item) => item.kind === 'skip' && item.reason === 'known-placeholder'
      ).length;
      resultBelowMinimum += resultAnalysis.occurrences.filter(
        (item) => item.kind === 'skip' && item.reason === 'below-min-payload'
      ).length;
      resultPrunable += resultAnalysis.occurrences.filter((item) => item.kind === 'replace').length;
      resultNonImageHash.update(nonImageProjection(rewritten.output, resultAnalysis));

      const resultLine = Buffer.from(rewritten.output, 'utf8');
      resultBytes += resultLine.length;
      resultHash.update(resultLine);
      await temporary.writeFile(resultLine);
    }

    const sourceSha256 = sourceHash.digest('hex');
    const resultSha256 = resultHash.digest('hex');
    if (sourceSha256 !== candidate.sourceSha256) throw pruneError('source-hash-drift');
    if (
      sourceBytes !== candidate.sourceBytes
      || resultBytes !== candidate.projectedBytes
      || occurrencesSeen !== candidate.occurrencesSeen
      || resultOccurrencesSeen !== occurrencesSeen
      || imagesPrunable !== candidate.imagesPrunable
      || imagesStripped !== candidate.imagesPrunable
      || knownPlaceholders !== candidate.knownPlaceholders
      || belowMinimum !== candidate.belowMinimum
      || resultKnownPlaceholders !== knownPlaceholders + imagesStripped
      || resultBelowMinimum !== belowMinimum
      || resultPrunable !== 0
      || lines !== candidate.lines
    ) {
      throw pruneError('scan-metrics-drift');
    }
    const sourceNonImageSha256 = sourceNonImageHash.digest('hex');
    const resultNonImageSha256 = resultNonImageHash.digest('hex');
    if (sourceNonImageSha256 !== resultNonImageSha256) {
      throw pruneError('non-image-bytes-changed');
    }

    if (!sameStatsAsIdentity(await source.stat(), candidate.identity)) {
      throw pruneError('source-identity-changed');
    }
    const currentSource = await collectFileIdentity(candidate.path, candidate.pathCategory);
    if (!sameFileIdentity(currentSource, candidate.identity)) {
      throw pruneError('source-identity-changed');
    }

    await temporary.sync();
    await temporary.chmod((sourceStats.mode & 0o777));
    await temporary.utimes(sourceStats.atime, sourceStats.mtime);
    await temporary.sync();
    const completedTempStats = await temporary.stat();
    if (!sameTemporaryInode(initialTempStats, completedTempStats)) {
      throw pruneError('temp-identity-drift');
    }
    if (completedTempStats.size !== resultBytes) throw pruneError('temp-size-drift');
    if ((completedTempStats.mode & 0o777) !== (sourceStats.mode & 0o777)) {
      throw pruneError('temp-mode-drift');
    }
    if (Math.abs(completedTempStats.mtimeMs - sourceStats.mtimeMs) >= 1) {
      throw pruneError('temp-mtime-drift');
    }

    await source.close();
    source = undefined;
    await temporary.close();
    temporary = undefined;

    const validation = {
      tempPath,
      identity: completedTempStats,
      resultBytes,
      resultSha256,
      lines,
      occurrencesSeen,
      knownPlaceholders: knownPlaceholders + imagesStripped,
      belowMinimum,
      nonImageSha256: resultNonImageSha256
    };
    await validateTemporary(validation);
    keepTemporary = true;
    return {
      candidate,
      tempPath,
      tempIdentity: completedTempStats,
      sourceBytes,
      resultBytes,
      occurrencesSeen,
      imagesStripped,
      knownPlaceholders,
      belowMinimum,
      lines,
      sourceSha256,
      resultSha256,
      nonImageSha256: resultNonImageSha256
    };
  } catch (error) {
    if (isPruneError(error)) throw error;
    throw pruneError(errorCode(error) ?? 'file-prepare-failed');
  } finally {
    await source?.close().catch(() => undefined);
    await temporary?.close().catch(() => undefined);
    if (!keepTemporary) await removeExactTemporary(tempPath, cleanupIdentity);
  }
}

async function validatePreparedFile(prepared: PreparedFile, targetPath: string): Promise<void> {
  await validateTemporary({
    tempPath: targetPath,
    identity: prepared.tempIdentity,
    resultBytes: prepared.resultBytes,
    resultSha256: prepared.resultSha256,
    lines: prepared.lines,
    occurrencesSeen: prepared.occurrencesSeen,
    knownPlaceholders: prepared.knownPlaceholders + prepared.imagesStripped,
    belowMinimum: prepared.belowMinimum,
    nonImageSha256: prepared.nonImageSha256
  });
}

async function validateTemporary(options: {
  tempPath: string;
  identity: Stats;
  resultBytes: number;
  resultSha256: string;
  lines: number;
  occurrencesSeen: number;
  knownPlaceholders: number;
  belowMinimum: number;
  nonImageSha256: string;
}): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(options.tempPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameTemporaryIdentity(options.identity, await handle.stat())) {
      throw pruneError('temp-verification-failed');
    }
    const hash = createHash('sha256');
    const projectionHash = createHash('sha256');
    let bytes = 0;
    let lines = 0;
    let occurrences = 0;
    let knownPlaceholders = 0;
    let belowMinimum = 0;
    let prunable = 0;
    for await (const line of readJsonlLines(options.tempPath, { fileDescriptor: handle.fd })) {
      lines += 1;
      bytes += line.bytes.length;
      hash.update(line.bytes);
      assertJsonLine(line.text);
      const analysis = analyzeSessionImageLine(line.text);
      if (analysis.blocked) throw pruneError('temp-verification-failed');
      occurrences += analysis.occurrences.length;
      knownPlaceholders += analysis.occurrences.filter(
        (item) => item.kind === 'skip' && item.reason === 'known-placeholder'
      ).length;
      belowMinimum += analysis.occurrences.filter(
        (item) => item.kind === 'skip' && item.reason === 'below-min-payload'
      ).length;
      prunable += analysis.occurrences.filter((item) => item.kind === 'replace').length;
      projectionHash.update(nonImageProjection(line.text, analysis));
    }
    if (
      bytes !== options.resultBytes
      || lines !== options.lines
      || occurrences !== options.occurrencesSeen
      || knownPlaceholders !== options.knownPlaceholders
      || belowMinimum !== options.belowMinimum
      || prunable !== 0
      || hash.digest('hex') !== options.resultSha256
      || projectionHash.digest('hex') !== options.nonImageSha256
      || !sameTemporaryIdentity(options.identity, await handle.stat())
    ) {
      throw pruneError('temp-verification-failed');
    }
    await handle.close();
    handle = undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function finalMutationPreflight(
  env: NodeJS.ProcessEnv | undefined,
  candidate: CodexSessionImageCandidate,
  requiredTemporaryBytes: number
): Promise<void> {
  try {
    const preflight = await preflightCodexSessionMutation({
      env,
      targets: [{ path: candidate.path, identity: candidate.identity }],
      requiredTemporaryBytes
    });
    if (!preflight.allowed) {
      const code = stableCodes(preflight.blockedReasons)[0] ?? 'preflight-check-unavailable';
      throw pruneError(code);
    }
  } catch (error) {
    if (isPruneError(error)) throw error;
    throw pruneError('preflight-check-unavailable');
  }
}

async function openRevalidatedSource(
  candidate: CodexSessionImageCandidate
): Promise<Awaited<ReturnType<typeof open>>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameStatsAsIdentity(await handle.stat(), candidate.identity)) {
      throw pruneError('source-revalidation-failed');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const line of readJsonlLines(candidate.path, { fileDescriptor: handle.fd })) {
      bytes += line.bytes.length;
      hash.update(line.bytes);
    }
    if (
      bytes !== candidate.sourceBytes
      || hash.digest('hex') !== candidate.sourceSha256
      || !sameStatsAsIdentity(await handle.stat(), candidate.identity)
    ) {
      throw pruneError('source-revalidation-failed');
    }
    const current = await collectFileIdentity(candidate.path, candidate.pathCategory);
    if (!sameFileIdentity(current, candidate.identity)) {
      throw pruneError('source-revalidation-failed');
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isPruneError(error)) throw error;
    throw pruneError('source-revalidation-failed');
  }
}

async function syncParentDirectory(directory: string, warnings: string[]): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let supported = true;
  try {
    const directoryFlag = constants.O_DIRECTORY ?? 0;
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | directoryFlag);
    try {
      await handle.sync();
    } catch (error) {
      if (['EINVAL', 'ENOTSUP', 'EISDIR'].includes(errorCode(error) ?? '')) {
        warnings.push('parent-directory-sync-unsupported');
        supported = false;
      } else {
        throw error;
      }
    }
    await handle.close();
    handle = undefined;
    return supported;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function runStartRecord(planId: string): SessionImageManifestRecord {
  return {
    schemaVersion: 1,
    recordType: 'run-start',
    planId,
    toolVersion: TOOL_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    placeholderSha256: PLACEHOLDER_SHA256,
    at: now()
  };
}

function excludedOutcomeRecord(
  planId: string,
  outcome: CodexSessionImagePrivateOutcome
): SessionImageManifestRecord {
  if (outcome.status === 'skipped' && outcome.code === 'no-prunable-images') {
    return {
      ...fileBase(planId, outcome.path, outcome.pathCategory, ['scan-complete'], []),
      recordType: 'file-skip',
      reason: 'no-prunable-images'
    };
  }
  return {
    ...fileBase(planId, outcome.path, outcome.pathCategory, [], [outcome.code]),
    recordType: 'file-failed',
    code: outcome.code
  };
}

function filePreparedRecord(planId: string, prepared: PreparedFile): SessionImageManifestRecord {
  return processingRecord('file-prepared', planId, prepared, [
    'source-identity',
    'source-sha256',
    'source-json',
    'result-json',
    'line-count',
    'occurrence-count',
    'non-image-bytes',
    'result-sha256',
    'temp-identity',
    'temp-fsync'
  ]);
}

function fileSuccessRecord(
  planId: string,
  prepared: PreparedFile,
  parentSynced: boolean
): SessionImageManifestRecord {
  const passed = [
    'source-identity',
    'source-sha256',
    'source-json',
    'result-json',
    'line-count',
    'occurrence-count',
    'non-image-bytes',
    'result-sha256',
    'temp-identity',
    'temp-fsync',
    'atomic-rename'
  ];
  if (parentSynced) passed.push('parent-directory-sync');
  const record = processingRecord('file-success', planId, prepared, passed);
  if (!parentSynced) record.verificationsFailed.push('parent-directory-sync-unsupported');
  return record;
}

function processingRecord(
  recordType: 'file-prepared' | 'file-success',
  planId: string,
  prepared: PreparedFile,
  verificationsPassed: string[]
): ProcessingManifestRecord {
  return {
    ...fileBase(
      planId,
      prepared.candidate.path,
      prepared.candidate.pathCategory,
      verificationsPassed,
      []
    ),
    recordType,
    sourceBytes: prepared.sourceBytes,
    resultBytes: prepared.resultBytes,
    occurrencesSeen: prepared.occurrencesSeen,
    imagesPrunable: prepared.candidate.imagesPrunable,
    imagesStripped: prepared.imagesStripped,
    knownPlaceholders: prepared.knownPlaceholders,
    belowMinimum: prepared.belowMinimum,
    lines: prepared.lines,
    sourceSha256: prepared.sourceSha256,
    resultSha256: prepared.resultSha256
  };
}

function fileFailureRecord(
  planId: string,
  candidate: CodexSessionImageCandidate,
  code: string
): SessionImageManifestRecord {
  return {
    ...fileBase(planId, candidate.path, candidate.pathCategory, [], [code]),
    recordType: 'file-failed',
    sourceBytes: candidate.sourceBytes,
    occurrencesSeen: candidate.occurrencesSeen,
    imagesPrunable: candidate.imagesPrunable,
    knownPlaceholders: candidate.knownPlaceholders,
    belowMinimum: candidate.belowMinimum,
    lines: candidate.lines,
    sourceSha256: candidate.sourceSha256,
    code
  };
}

function fileBase(
  planId: string,
  source: string,
  pathCategory: string,
  verificationsPassed: string[],
  verificationsFailed: string[]
): SessionImageManifestFileBase {
  return {
    schemaVersion: 1,
    planId,
    toolVersion: TOOL_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    placeholderSha256: PLACEHOLDER_SHA256,
    source,
    pathCategory,
    verificationsPassed,
    verificationsFailed,
    at: now()
  };
}

function runSummaryRecord(planId: string, aggregate: Aggregate): SessionImageManifestRecord {
  const record: SessionImageManifestRecord = {
    schemaVersion: 1,
    recordType: 'run-summary',
    planId,
    status: statusFor(aggregate),
    filesSucceeded: aggregate.filesSucceeded,
    filesSkipped: aggregate.filesSkipped,
    filesFailed: aggregate.filesFailed,
    imagesStripped: aggregate.imagesStripped,
    sourceBytes: aggregate.sourceBytes,
    resultBytes: aggregate.resultBytes,
    at: now()
  };
  if (aggregate.volumeFreeDeltaBytes !== undefined) {
    record.volumeFreeDeltaBytes = aggregate.volumeFreeDeltaBytes;
  }
  return record;
}

function nonImageProjection(
  line: string,
  analysis: ReturnType<typeof analyzeSessionImageLine>
): Buffer {
  const output: string[] = [];
  let cursor = 0;
  for (const occurrence of analysis.occurrences) {
    output.push(line.slice(cursor, occurrence.start), NON_IMAGE_SENTINEL);
    cursor = occurrence.end;
  }
  output.push(line.slice(cursor));
  return Buffer.from(output.join(''), 'utf8');
}

function assertJsonLine(line: string): void {
  if (jsonWhitespaceOnly(line)) return;
  try {
    JSON.parse(line);
  } catch {
    throw pruneError('invalid-json');
  }
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

function sameStatsAsIdentity(stats: Stats, identity: FileIdentity): boolean {
  const uid = process.getuid?.();
  return stats.isFile()
    && !stats.isSymbolicLink()
    && stats.nlink === 1
    && (uid === undefined || stats.uid === uid)
    && stats.dev === identity.dev
    && stats.ino === identity.ino
    && stats.mode === identity.mode
    && stats.uid === identity.uid
    && stats.gid === identity.gid
    && stats.size === identity.size
    && stats.mtimeMs === identity.mtimeMs
    && stats.nlink === identity.nlink;
}

function sameRetiredSourceStats(stats: Stats, identity: FileIdentity): boolean {
  const uid = process.getuid?.();
  return stats.isFile()
    && !stats.isSymbolicLink()
    && stats.nlink === 0
    && (uid === undefined || stats.uid === uid)
    && stats.dev === identity.dev
    && stats.ino === identity.ino
    && stats.mode === identity.mode
    && stats.uid === identity.uid
    && stats.gid === identity.gid
    && stats.size === identity.size
    && stats.mtimeMs === identity.mtimeMs;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.exists === right.exists
    && left.regularFile === right.regularFile
    && left.symbolicLink === right.symbolicLink
    && left.realpath === right.realpath
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.nlink === right.nlink;
}

function safeNewTemporary(stats: Stats): boolean {
  const uid = process.getuid?.();
  return stats.isFile()
    && !stats.isSymbolicLink()
    && stats.nlink === 1
    && stats.size === 0
    && (stats.mode & 0o777) === 0o600
    && (uid === undefined || stats.uid === uid);
}

function sameTemporaryIdentity(left: Stats, right: Stats): boolean {
  return sameTemporaryInode(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && Math.abs(left.mtimeMs - right.mtimeMs) < 1;
}

function sameTemporaryInode(left: Stats, right: Stats): boolean {
  return right.isFile()
    && !right.isSymbolicLink()
    && right.nlink === 1
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid;
}

async function cleanupTemporary(
  tempPath: string,
  identity: Stats,
  aggregate: Aggregate
): Promise<void> {
  try {
    await removeExactTemporary(tempPath, identity);
  } catch (error) {
    aggregate.blockedReasons.push(pruneErrorCode(error, 'temp-cleanup-failed'));
  }
}

async function removeExactTemporary(tempPath: string, identity: Stats | undefined): Promise<void> {
  if (!identity) throw pruneError('temp-cleanup-unsafe');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const current = await lstat(tempPath);
    if (!sameTemporaryInode(identity, current)) throw pruneError('temp-cleanup-unsafe');
    handle = await open(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameTemporaryInode(identity, await handle.stat())) {
      throw pruneError('temp-cleanup-unsafe');
    }
    await unlink(tempPath);
    if ((await handle.stat()).nlink !== 0) throw pruneError('temp-cleanup-unsafe');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    if (isPruneError(error)) throw error;
    throw pruneError('temp-cleanup-failed');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function availableBytesFor(target: string): Promise<number | undefined> {
  try {
    const snapshot = await statfs(path.dirname(target));
    const bytes = snapshot.bavail * snapshot.bsize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function addChangedMetrics(aggregate: Aggregate, prepared: PreparedFile): void {
  aggregate.changed = true;
  aggregate.imagesStripped += prepared.imagesStripped;
  aggregate.sourceBytes += prepared.sourceBytes;
  aggregate.resultBytes += prepared.resultBytes;
}

function largestProjectedBytes(candidates: CodexSessionImageCandidate[]): number {
  let largest = 0;
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.projectedBytes) || candidate.projectedBytes < 0) {
      throw pruneError('candidate-metrics-invalid');
    }
    largest = Math.max(largest, candidate.projectedBytes);
  }
  return largest;
}

function emptyAggregate(): Aggregate {
  return {
    changed: false,
    filesSucceeded: 0,
    filesSkipped: 0,
    filesFailed: 0,
    imagesStripped: 0,
    sourceBytes: 0,
    resultBytes: 0,
    volumeFreeDeltaBytes: undefined,
    blockedReasons: [],
    warnings: []
  };
}

function publicResult(aggregate: Aggregate): CodexSessionImagePruneResult {
  const result: CodexSessionImagePruneResult = {
    status: statusFor(aggregate),
    changed: aggregate.changed,
    filesSucceeded: aggregate.filesSucceeded,
    filesSkipped: aggregate.filesSkipped,
    filesFailed: aggregate.filesFailed,
    imagesStripped: aggregate.imagesStripped,
    sourceBytes: aggregate.sourceBytes,
    resultBytes: aggregate.resultBytes,
    reclaimedBytes: Math.max(0, aggregate.sourceBytes - aggregate.resultBytes),
    manifestPathCategory: MANIFEST_PATH_CATEGORY,
    blockedReasons: uniqueStableCodes(aggregate.blockedReasons),
    warnings: uniqueStableCodes(aggregate.warnings)
  };
  if (
    aggregate.volumeFreeDeltaBytes !== undefined
    && Number.isSafeInteger(aggregate.volumeFreeDeltaBytes)
  ) {
    result.volumeFreeDeltaBytes = aggregate.volumeFreeDeltaBytes;
  }
  return result;
}

function statusFor(aggregate: Aggregate): CodexSessionImagePruneResult['status'] {
  if (aggregate.filesFailed === 0 && aggregate.blockedReasons.length === 0) return 'ok';
  return aggregate.changed ? 'partial' : 'blocked';
}

function stableCodes(values: readonly string[]): string[] {
  return values.filter((value) => STABLE_CODE_PATTERN.test(value));
}

function uniqueStableCodes(values: readonly string[]): string[] {
  return [...new Set(stableCodes(values))];
}

function now(): string {
  return new Date().toISOString();
}

class PruneError extends Error {
  override readonly name = 'CodexSessionImagePruneError';
}

function pruneError(code: string): PruneError {
  return new PruneError(STABLE_CODE_PATTERN.test(code) ? code : 'file-prepare-failed');
}

function isPruneError(error: unknown): error is PruneError {
  return error instanceof PruneError;
}

function pruneErrorCode(error: unknown, fallback: string): string {
  return isPruneError(error) ? error.message : fallback;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}
