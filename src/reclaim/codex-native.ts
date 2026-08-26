import { createHash } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../commands.js';
import { inspectSafeExecutable, sameExecutableIdentity } from '../fs-safety.js';
import { defaultCodexHome, resolveHome } from '../paths.js';
import type { CommandRunResult, FileIdentity } from '../types.js';
import { TOOL_VERSION } from '../version.js';

const BUNDLED_CODEX_EXECUTABLE = '/Applications/Codex.app/Contents/Resources/codex';
const FEATURE_NAME = 'local_thread_store_compression';
const MAX_FEATURE_STDOUT_BYTES = 256 * 1024;
const MAX_FEATURE_STDERR_BYTES = 16 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const MAX_SCAN_ENTRIES = 200_000;
const MAX_DIRECTORY_CHILDREN = 20_000;
const MAX_SCAN_DEPTH = 8;

export type CodexNativeCompressionStatus = {
  schemaVersion: 1;
  toolVersion: string;
  command: 'reclaim status codex-native-compression';
  status: 'ok' | 'partial' | 'unsupported';
  supported: boolean;
  featureStage?: string;
  defaultEnabled?: boolean;
  configuredState: 'unknown';
  plainJsonlFiles: number;
  compressedJsonlFiles: number;
  warnings: string[];
  nextActions: string[];
};

export async function inspectCodexNativeCompression(options: {
  env?: NodeJS.ProcessEnv;
  codexExecutable?: string;
  featureOutput?: string;
} = {}): Promise<CodexNativeCompressionStatus> {
  const env = options.env ?? process.env;
  const executable = options.codexExecutable ?? BUNDLED_CODEX_EXECUTABLE;
  const warnings: string[] = [];
  const counts = await countDefaultSessionExtensions(env, warnings);

  const before = await inspectSafeExecutable(executable, 'bundled-codex-executable');
  if (!before.safe || !before.identity) {
    warnings.push('codex-executable-untrusted');
    return buildStatus({ status: 'unsupported', supported: false, counts, warnings });
  }

  let featureOutput: string;
  if (options.featureOutput !== undefined) {
    featureOutput = options.featureOutput;
    if (!await sourceIdentityRemainsStable(executable, before.identity)) {
      warnings.push('codex-executable-drift');
      return buildStatus({ status: 'partial', supported: false, counts, warnings });
    }
  } else {
    let snapshot: ExecutableSnapshot;
    try {
      snapshot = await createExecutableSnapshot(executable, before.identity);
    } catch {
      warnings.push('native-feature-check-unavailable');
      return buildStatus({ status: 'partial', supported: false, counts, warnings });
    }

    let commandResult: CommandRunResult | undefined;
    let commandThrew = false;
    let snapshotStable = false;
    let sourceStable = false;
    const snapshotBefore = await inspectSafeExecutable(
      snapshot.executablePath,
      'private-codex-executable-snapshot'
    );
    try {
      if (snapshotBefore.safe && snapshotBefore.identity) {
        try {
          commandResult = await runCommand(snapshot.executablePath, ['features', 'list'], {
            timeoutMs: 5_000,
            maxStdoutBytes: MAX_FEATURE_STDOUT_BYTES,
            maxStderrBytes: MAX_FEATURE_STDERR_BYTES
          });
        } catch {
          commandThrew = true;
        }
        const snapshotAfter = await inspectSafeExecutable(
          snapshot.executablePath,
          'private-codex-executable-snapshot'
        );
        snapshotStable = Boolean(
          snapshotAfter.safe
          && snapshotAfter.identity
          && sameExecutableIdentity(snapshotBefore.identity, snapshotAfter.identity)
        );
      }
      sourceStable = await sourceIdentityRemainsStable(executable, before.identity);
    } finally {
      if (!await snapshot.cleanup()) warnings.push('codex-executable-snapshot-cleanup-failed');
    }

    if (!snapshotStable || !sourceStable) {
      warnings.push('codex-executable-drift');
      return buildStatus({ status: 'partial', supported: false, counts, warnings });
    }
    if (
      commandThrew
      || !commandResult
      || commandResult.code !== 0
      || commandResult.timedOut
      || commandResult.stdoutTruncated
      || commandResult.stderrTruncated
    ) {
      warnings.push('native-feature-check-unavailable');
      return buildStatus({ status: 'partial', supported: false, counts, warnings });
    }
    if (commandResult.stderr.length > 0) warnings.push('native-feature-command-stderr');
    featureOutput = commandResult.stdout;
  }

  const feature = parseFeatureOutput(featureOutput);
  if (feature.kind === 'invalid') {
    warnings.push('native-feature-output-invalid');
    return buildStatus({ status: 'partial', supported: false, counts, warnings });
  }
  if (feature.kind === 'absent') {
    warnings.push('native-feature-unavailable');
    return buildStatus({ status: 'unsupported', supported: false, counts, warnings });
  }

  return buildStatus({
    status: warnings.length === 0 ? 'ok' : 'partial',
    supported: true,
    featureStage: feature.stage,
    defaultEnabled: feature.defaultEnabled,
    counts,
    warnings
  });
}

type ExecutableSnapshot = {
  executablePath: string;
  cleanup(): Promise<boolean>;
};

async function createExecutableSnapshot(
  sourcePath: string,
  expectedIdentity: FileIdentity
): Promise<ExecutableSnapshot> {
  const createdDirectory = await mkdtemp(path.join(os.tmpdir(), 'aidm-codex-executable-'));
  let snapshotDirectory = createdDirectory;
  try {
    await chmod(createdDirectory, 0o700);
    snapshotDirectory = await realpath(createdDirectory);
  } catch (error) {
    try {
      await rm(createdDirectory, { recursive: true, force: true });
    } catch {
      throw new Error('executable snapshot directory cleanup was incomplete');
    }
    throw error;
  }
  const snapshotPath = path.join(snapshotDirectory, 'codex-snapshot');
  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;

  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceBefore = await source.stat();
    if (
      !openedFileMatchesIdentity(sourceBefore, expectedIdentity)
      || sourceBefore.size < 1
      || sourceBefore.size > MAX_EXECUTABLE_BYTES
    ) {
      throw new Error('executable source identity mismatch');
    }

    destination = await open(
      snapshotPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o500
    );
    const sourceDigest = await copyFileHandleAndHash(source, destination, sourceBefore.size);
    await destination.sync();
    await destination.chmod(0o500);

    const sourceAfter = await source.stat();
    const destinationInfo = await destination.stat();
    if (
      !sameOpenedFileIdentity(sourceBefore, sourceAfter)
      || !destinationInfo.isFile()
      || destinationInfo.nlink !== 1
      || destinationInfo.size !== sourceBefore.size
      || (destinationInfo.mode & 0o222) !== 0
    ) {
      throw new Error('executable snapshot identity mismatch');
    }
    const destinationDigest = await hashFileHandle(destination, destinationInfo.size);
    if (sourceDigest !== destinationDigest) throw new Error('executable snapshot digest mismatch');

    await destination.close();
    destination = undefined;
    await source.close();
    source = undefined;

    let cleaned = false;
    return {
      executablePath: snapshotPath,
      cleanup: async () => {
        if (cleaned) return true;
        try {
          await rm(snapshotDirectory, { recursive: true, force: true });
          cleaned = true;
          return true;
        } catch {
          return false;
        }
      }
    };
  } catch (error) {
    await Promise.allSettled([source?.close(), destination?.close()]);
    try {
      await rm(snapshotDirectory, { recursive: true, force: true });
    } catch {
      throw new Error('executable snapshot failed and cleanup was incomplete');
    }
    throw error;
  }
}

async function copyFileHandleAndHash(
  source: FileHandle,
  destination: FileHandle,
  expectedBytes: number
): Promise<string> {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, expectedBytes));
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(buffer.length, expectedBytes - position);
    const { bytesRead } = await source.read(buffer, 0, length, position);
    if (bytesRead < 1) throw new Error('unexpected executable source EOF');
    digest.update(buffer.subarray(0, bytesRead));
    await writeAll(destination, buffer, bytesRead, position);
    position += bytesRead;
  }
  return digest.digest('hex');
}

async function hashFileHandle(file: FileHandle, expectedBytes: number): Promise<string> {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, expectedBytes));
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(buffer.length, expectedBytes - position);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    if (bytesRead < 1) throw new Error('unexpected executable snapshot EOF');
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest('hex');
}

async function writeAll(
  destination: FileHandle,
  buffer: Buffer,
  bytes: number,
  position: number
): Promise<void> {
  let offset = 0;
  while (offset < bytes) {
    const { bytesWritten } = await destination.write(
      buffer,
      offset,
      bytes - offset,
      position + offset
    );
    if (bytesWritten < 1) throw new Error('executable snapshot write stalled');
    offset += bytesWritten;
  }
}

function openedFileMatchesIdentity(info: Stats, expected: FileIdentity): boolean {
  return (
    info.isFile()
    && info.dev === expected.dev
    && info.ino === expected.ino
    && info.mode === expected.mode
    && info.uid === expected.uid
    && info.gid === expected.gid
    && info.size === expected.size
    && info.mtimeMs === expected.mtimeMs
    && info.nlink === expected.nlink
  );
}

function sameOpenedFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.isFile() === right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.nlink === right.nlink
  );
}

async function sourceIdentityRemainsStable(
  executable: string,
  expected: FileIdentity
): Promise<boolean> {
  const after = await inspectSafeExecutable(executable, 'bundled-codex-executable');
  return Boolean(
    after.safe
    && after.identity
    && sameExecutableIdentity(expected, after.identity)
  );
}

type SessionExtensionCounts = {
  plainJsonlFiles: number;
  compressedJsonlFiles: number;
};

async function countDefaultSessionExtensions(
  env: NodeJS.ProcessEnv,
  warnings: string[]
): Promise<SessionExtensionCounts> {
  const empty = { plainJsonlFiles: 0, compressedJsonlFiles: 0 };
  const { codexHome, custom } = defaultCodexHome(env);
  if (custom) {
    warnings.push('custom-codex-home-unsupported');
    return empty;
  }

  const home = resolveHome(env);
  const sessions = path.join(codexHome, 'sessions');
  for (const directory of [home, codexHome]) {
    const inspection = await inspectDirectory(directory);
    if (inspection.kind === 'missing') return empty;
    if (inspection.kind !== 'safe') {
      warnings.push('session-metadata-scan-incomplete');
      return empty;
    }
  }

  const sessionsInspection = await inspectDirectory(sessions);
  if (sessionsInspection.kind === 'missing') return empty;
  if (sessionsInspection.kind !== 'safe') {
    warnings.push('session-metadata-scan-incomplete');
    return empty;
  }

  const scan = await scanSessionExtensions(sessions, sessionsInspection.identity);
  if (!scan.complete) warnings.push('session-metadata-scan-incomplete');
  return {
    plainJsonlFiles: scan.plainJsonlFiles,
    compressedJsonlFiles: scan.compressedJsonlFiles
  };
}

type DirectoryIdentity = {
  realpath: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
};

type DirectoryInspection =
  | { kind: 'safe'; identity: DirectoryIdentity }
  | { kind: 'missing' }
  | { kind: 'unsafe' };

async function inspectDirectory(directory: string): Promise<DirectoryInspection> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) return { kind: 'unsafe' };
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return { kind: 'unsafe' };
    if ((info.mode & 0o022) !== 0) return { kind: 'unsafe' };
    const resolved = await realpath(directory);
    if (resolved !== directory) return { kind: 'unsafe' };
    return {
      kind: 'safe',
      identity: {
        realpath: resolved,
        dev: info.dev,
        ino: info.ino,
        mode: info.mode,
        uid: info.uid,
        gid: info.gid,
        nlink: info.nlink
      }
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unsafe' };
  }
}

type PendingDirectory = {
  directory: string;
  depth: number;
  expectedIdentity: DirectoryIdentity;
  lineage: Array<{ directory: string; identity: DirectoryIdentity }>;
};

async function scanSessionExtensions(
  root: string,
  rootIdentity: DirectoryIdentity
): Promise<SessionExtensionCounts & { complete: boolean }> {
  const counts = { plainJsonlFiles: 0, compressedJsonlFiles: 0, complete: true };
  const pending: PendingDirectory[] = [{
    directory: root,
    depth: 0,
    expectedIdentity: rootIdentity,
    lineage: []
  }];
  const visited = new Set<string>();
  let inspectedEntries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const opened = await readDirectoryThroughHandle(current).catch(() => undefined);
    if (!opened) {
      counts.complete = false;
      continue;
    }

    const identityKey = `${opened.identity.dev}:${opened.identity.ino}`;
    if (visited.has(identityKey)) {
      counts.complete = false;
      continue;
    }
    visited.add(identityKey);

    for (const entry of opened.entries) {
      inspectedEntries++;
      if (inspectedEntries > MAX_SCAN_ENTRIES) {
        counts.complete = false;
        return counts;
      }
      if (entry.isSymbolicLink()) {
        counts.complete = false;
        continue;
      }
      if (entry.isDirectory()) {
        if (current.depth >= MAX_SCAN_DEPTH) {
          counts.complete = false;
          continue;
        }
        const child = path.join(current.directory, entry.name);
        const childInspection = await inspectDirectory(child);
        if (childInspection.kind !== 'safe') {
          counts.complete = false;
          continue;
        }
        pending.push({
          directory: child,
          depth: current.depth + 1,
          expectedIdentity: childInspection.identity,
          lineage: [
            ...current.lineage,
            { directory: current.directory, identity: opened.identity }
          ]
        });
        continue;
      }
      if (!entry.isFile()) {
        counts.complete = false;
        continue;
      }
      if (entry.name.endsWith('.jsonl.zst')) counts.compressedJsonlFiles++;
      else if (entry.name.endsWith('.jsonl')) counts.plainJsonlFiles++;
    }
  }
  return counts;
}

async function readDirectoryThroughHandle(
  target: PendingDirectory
): Promise<{ identity: DirectoryIdentity; entries: Dirent[] } | undefined> {
  if (!await lineageRemainsStable(target.lineage)) return undefined;
  const before = await inspectDirectory(target.directory);
  if (before.kind !== 'safe' || !sameDirectoryIdentity(before.identity, target.expectedIdentity)) {
    return undefined;
  }

  let handle;
  try {
    handle = await opendir(target.directory);
  } catch {
    return undefined;
  }
  try {
    if (!await lineageRemainsStable(target.lineage)) return undefined;
    const afterOpen = await inspectDirectory(target.directory);
    if (afterOpen.kind !== 'safe' || !sameDirectoryIdentity(before.identity, afterOpen.identity)) {
      return undefined;
    }

    const entries: Dirent[] = [];
    while (true) {
      const entry = await handle.read();
      if (!entry) break;
      if (entries.length >= MAX_DIRECTORY_CHILDREN) return undefined;
      entries.push(entry);
    }

    if (!await lineageRemainsStable(target.lineage)) return undefined;
    const afterRead = await inspectDirectory(target.directory);
    if (afterRead.kind !== 'safe' || !sameDirectoryIdentity(before.identity, afterRead.identity)) {
      return undefined;
    }
    return { identity: before.identity, entries };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function lineageRemainsStable(
  lineage: PendingDirectory['lineage']
): Promise<boolean> {
  for (const ancestor of lineage) {
    const current = await inspectDirectory(ancestor.directory);
    if (current.kind !== 'safe' || !sameDirectoryIdentity(current.identity, ancestor.identity)) {
      return false;
    }
  }
  return true;
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.realpath === right.realpath
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
  );
}

type ParsedFeature =
  | { kind: 'found'; stage: string; defaultEnabled: boolean }
  | { kind: 'absent' }
  | { kind: 'invalid' };

function parseFeatureOutput(output: string): ParsedFeature {
  if (Buffer.byteLength(output, 'utf8') > MAX_FEATURE_STDOUT_BYTES) return { kind: 'invalid' };
  const relevant = output
    .split('\n')
    .map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
    .filter((line) => line === FEATURE_NAME || (
      line.startsWith(FEATURE_NAME)
      && /^[ \t]/.test(line.slice(FEATURE_NAME.length, FEATURE_NAME.length + 1))
    ));
  if (relevant.length === 0) return { kind: 'absent' };
  if (relevant.length !== 1) return { kind: 'invalid' };

  const match = new RegExp(
    `^${FEATURE_NAME}(?: {2,}|\\t+)([a-z][a-z0-9_-]*(?: [a-z0-9_-]+)*?)(?: {2,}|\\t+)(true|false)$`
  ).exec(relevant[0] ?? '');
  const stage = match?.[1];
  if (!stage || Buffer.byteLength(stage, 'utf8') > 64) return { kind: 'invalid' };
  return { kind: 'found', stage, defaultEnabled: match?.[2] === 'true' };
}

function buildStatus(input: {
  status: CodexNativeCompressionStatus['status'];
  supported: boolean;
  featureStage?: string;
  defaultEnabled?: boolean;
  counts: SessionExtensionCounts;
  warnings: string[];
}): CodexNativeCompressionStatus {
  const result: CodexNativeCompressionStatus = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    command: 'reclaim status codex-native-compression',
    status: input.status,
    supported: input.supported,
    configuredState: 'unknown',
    ...input.counts,
    warnings: [...new Set(input.warnings)],
    nextActions: input.supported
      ? [
          'Prune eligible session images before enabling native compression.',
          'Use the official Codex CLI to manage this feature; AIDM will not edit configuration.'
        ]
      : input.status === 'partial'
        ? [
            'Retry after verifying the bundled Codex executable.',
            'AIDM will not edit Codex configuration.'
          ]
        : [
            'Update Codex and run this status check again.',
            'AIDM will not edit Codex configuration.'
          ]
  };
  if (input.featureStage !== undefined) result.featureStage = input.featureStage;
  if (input.defaultEnabled !== undefined) result.defaultEnabled = input.defaultEnabled;
  return result;
}
