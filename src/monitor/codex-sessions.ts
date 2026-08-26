import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  rename,
  statfs,
  unlink
} from 'node:fs/promises';
import path from 'node:path';
import {
  assertExistingPrivateDirSafe,
  assertPrivateAppDirSafe
} from '../fs-safety.js';
import { scanPathSize } from '../fs-size.js';
import {
  appDataHome,
  codexSessionMonitorReportPath,
  codexSessionMonitorStatePath,
  defaultCodexHome,
  monitorDataDir,
  resolveHome
} from '../paths.js';
import { TOOL_VERSION } from '../version.js';

const GIB = 1024 ** 3;
const DEFAULT_THRESHOLD_BYTES = 8 * GIB;
const DEFAULT_GROWTH_THRESHOLD_BYTES = 5 * GIB;
const MAX_THRESHOLD_BYTES = 1024 * GIB;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 200_000;
const MAX_CHILDREN_PER_DIRECTORY = 20_000;
const SCAN_DEADLINE_MS = 10_000;

export type CodexSessionMonitorResult = {
  schemaVersion: 1;
  toolVersion: string;
  command: 'monitor codex-sessions';
  status: 'ok' | 'partial' | 'blocked';
  currentBytes: number;
  previousBytes?: number;
  deltaBytes?: number;
  thresholdBytes: number;
  growthThresholdBytes: number;
  alert: boolean;
  statePersisted: boolean;
  notificationAttempted: boolean;
  notificationDelivered?: boolean;
  warnings: string[];
};

export type CodexSessionMonitorNotification = {
  currentBytes: number;
  previousBytes?: number;
  deltaBytes?: number;
  thresholdBytes: number;
  growthThresholdBytes: number;
  measurementComplete: boolean;
};

export type CodexSessionMonitorOptions = {
  env?: NodeJS.ProcessEnv;
  thresholdBytes?: number;
  growthThresholdBytes?: number;
  persistState?: boolean;
  notify?: boolean;
  notificationSender?: (
    notification: CodexSessionMonitorNotification
  ) => Promise<boolean>;
};

export async function measureCodexSessionState(
  options: CodexSessionMonitorOptions = {}
): Promise<CodexSessionMonitorResult> {
  const env = options.env ?? process.env;
  const thresholdBytes = options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const growthThresholdBytes = options.growthThresholdBytes ?? DEFAULT_GROWTH_THRESHOLD_BYTES;
  const base = { thresholdBytes, growthThresholdBytes };

  if (!validThreshold(thresholdBytes) || !validThreshold(growthThresholdBytes)) {
    return blockedResult(base, 'invalid-monitor-thresholds');
  }

  const codex = defaultCodexHome(env);
  if (codex.custom) return blockedResult(base, 'custom-codex-home-unsupported');

  const home = resolveHome(env);
  const root = await inspectSessionRoot(home, codex.codexHome);
  if (root.kind === 'blocked') return blockedResult(base, 'session-root-untrusted');

  const warnings: string[] = [];
  const previous = await readPreviousState(env);
  if (previous.warning) warnings.push(previous.warning);

  try {
    const volume = await statfs(home);
    if (!validStatfs(volume)) warnings.push('volume-metadata-unavailable');
  } catch {
    warnings.push('volume-metadata-unavailable');
  }

  let currentBytes = 0;
  let measurementComplete = true;
  if (root.kind === 'ready') {
    const scan = await scanPathSize(root.sessionsPath, 'codex-sessions-monitor', {
      maxDepth: MAX_SCAN_DEPTH,
      maxEntries: MAX_SCAN_ENTRIES,
      maxChildrenPerDir: MAX_CHILDREN_PER_DIRECTORY,
      deadlineMs: SCAN_DEADLINE_MS
    });
    const after = await inspectDirectory(root.sessionsPath);
    if (
      scan.sizeTruncated
      || scan.warnings.length > 0
      || after.kind !== 'safe'
      || !sameDirectoryIdentity(root.identity, after.identity)
    ) {
      warnings.push('session-metadata-scan-incomplete');
      measurementComplete = false;
    }
    if (!validByteCount(scan.bytes)) {
      return blockedResult(base, 'session-byte-count-invalid');
    }
    currentBytes = scan.bytes;
  }

  const previousBytes = previous.state?.totalBytes;
  const deltaBytes = previousBytes === undefined ? undefined : currentBytes - previousBytes;
  if (deltaBytes !== undefined && !Number.isSafeInteger(deltaBytes)) {
    return blockedResult(base, 'session-byte-count-invalid');
  }
  // Incomplete scans are conservative lower bounds, so crossing a threshold remains actionable.
  const alert = (
    currentBytes >= thresholdBytes
    || (deltaBytes !== undefined && deltaBytes >= growthThresholdBytes)
  );
  const measuredAt = new Date().toISOString();

  let statePersisted = false;
  let privateDirectoryReady = false;
  if (options.persistState) {
    const blockers = await assertPrivateAppDirSafe(monitorDataDir(env)).catch(() => [
      'private directory inspection failed'
    ]);
    privateDirectoryReady = (
      blockers.length === 0
      && await strictPrivateMonitorDirectories(env)
    );
    if (!privateDirectoryReady) {
      warnings.push('monitor-state-persist-failed');
    } else if (measurementComplete) {
      const stateWrite = await writePrivateJsonAtomically(
        codexSessionMonitorStatePath(env),
        {
          schemaVersion: 1,
          measuredAt,
          totalBytes: currentBytes,
          thresholdBytes,
          growthThresholdBytes,
          lastAlert: alert
        }
      );
      statePersisted = stateWrite.changed && stateWrite.durable;
      if (!stateWrite.durable) warnings.push('monitor-state-persist-failed');
    } else {
      warnings.push('monitor-state-not-updated');
    }
  }

  let notificationAttempted = false;
  let notificationDelivered: boolean | undefined;
  if (options.notify && alert) {
    notificationAttempted = true;
    const notification: CodexSessionMonitorNotification = {
      currentBytes,
      thresholdBytes,
      growthThresholdBytes,
      measurementComplete
    };
    if (previousBytes !== undefined) notification.previousBytes = previousBytes;
    if (deltaBytes !== undefined) notification.deltaBytes = deltaBytes;
    try {
      notificationDelivered = options.notificationSender
        ? await options.notificationSender(notification)
        : false;
    } catch {
      notificationDelivered = false;
    }
    if (!notificationDelivered) warnings.push('notification-failed');
  }

  let result = buildResult({
    currentBytes,
    previousBytes,
    deltaBytes,
    thresholdBytes,
    growthThresholdBytes,
    alert,
    statePersisted,
    notificationAttempted,
    notificationDelivered,
    warnings
  });

  if (options.persistState && privateDirectoryReady) {
    const reportWrite = await writePrivateJsonAtomically(
      codexSessionMonitorReportPath(env),
      { measuredAt, ...result }
    );
    if (!reportWrite.durable) {
      warnings.push('monitor-report-persist-failed');
      result = buildResult({
        currentBytes,
        previousBytes,
        deltaBytes,
        thresholdBytes,
        growthThresholdBytes,
        alert,
        statePersisted,
        notificationAttempted,
        notificationDelivered,
        warnings
      });
    }
  }

  return result;
}

type MonitorState = {
  schemaVersion: 1;
  measuredAt: string;
  totalBytes: number;
  thresholdBytes: number;
  growthThresholdBytes: number;
  lastAlert: boolean;
};

async function readPreviousState(
  env: NodeJS.ProcessEnv
): Promise<{ state?: MonitorState; warning?: string }> {
  const directory = monitorDataDir(env);
  let directoryInfo;
  try {
    directoryInfo = await lstat(directory);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? {} : { warning: 'monitor-state-untrusted' };
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    return { warning: 'monitor-state-untrusted' };
  }
  const blockers = await assertExistingPrivateDirSafe(directory).catch(() => [
    'private directory inspection failed'
  ]);
  if (blockers.length > 0) return { warning: 'monitor-state-untrusted' };
  if (!await strictPrivateMonitorDirectories(env)) {
    return { warning: 'monitor-state-untrusted' };
  }

  const statePath = codexSessionMonitorStatePath(env);
  let handle;
  try {
    handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? {} : { warning: 'monitor-state-untrusted' };
  }

  let outcome: { state?: MonitorState; warning?: string };
  try {
    const before = await handle.stat();
    if (!safePrivateFile(before) || before.size > MAX_STATE_BYTES) {
      outcome = { warning: 'monitor-state-untrusted' };
    } else {
      const raw = await handle.readFile('utf8');
      const after = await handle.stat();
      if (!sameFileIdentity(before, after)) {
        outcome = { warning: 'monitor-state-untrusted' };
      } else {
        const state = parseMonitorState(raw);
        outcome = state ? { state } : { warning: 'monitor-state-invalid' };
      }
    }
  } catch {
    outcome = { warning: 'monitor-state-invalid' };
  }
  try {
    await handle.close();
  } catch {
    return { warning: 'monitor-state-untrusted' };
  }
  return outcome;
}

function parseMonitorState(raw: string): MonitorState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value).sort();
  const expected = [
    'growthThresholdBytes',
    'lastAlert',
    'measuredAt',
    'schemaVersion',
    'thresholdBytes',
    'totalBytes'
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return undefined;
  }
  if (
    value.schemaVersion !== 1
    || !canonicalTimestamp(value.measuredAt)
    || !validByteCount(value.totalBytes)
    || !validThreshold(value.thresholdBytes)
    || !validThreshold(value.growthThresholdBytes)
    || typeof value.lastAlert !== 'boolean'
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    measuredAt: value.measuredAt,
    totalBytes: value.totalBytes,
    thresholdBytes: value.thresholdBytes,
    growthThresholdBytes: value.growthThresholdBytes,
    lastAlert: value.lastAlert
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

type SessionRootInspection =
  | { kind: 'ready'; sessionsPath: string; identity: DirectoryIdentity }
  | { kind: 'missing' }
  | { kind: 'blocked' };

async function inspectSessionRoot(home: string, codexHome: string): Promise<SessionRootInspection> {
  const homeInspection = await inspectDirectory(home);
  if (homeInspection.kind !== 'safe') return { kind: 'blocked' };
  const codexInspection = await inspectDirectory(codexHome);
  if (codexInspection.kind === 'missing') return { kind: 'missing' };
  if (codexInspection.kind !== 'safe') return { kind: 'blocked' };
  const sessionsPath = path.join(codexHome, 'sessions');
  const sessionsInspection = await inspectDirectory(sessionsPath);
  if (sessionsInspection.kind === 'missing') return { kind: 'missing' };
  if (sessionsInspection.kind !== 'safe') return { kind: 'blocked' };
  return { kind: 'ready', sessionsPath, identity: sessionsInspection.identity };
}

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
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unsafe' };
  }
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

type PrivateWriteResult = { changed: boolean; durable: boolean };

async function writePrivateJsonAtomically(
  targetPath: string,
  value: Record<string, unknown>
): Promise<PrivateWriteResult> {
  const before = await inspectPrivateTarget(targetPath);
  if (before.kind === 'unsafe') return { changed: false, durable: false };

  const directory = path.dirname(targetPath);
  const directoryBefore = await inspectDirectory(directory);
  if (directoryBefore.kind !== 'safe') return { changed: false, durable: false };
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`
  );
  let handle;
  let temporaryIdentity: Stats | undefined;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    temporaryIdentity = await handle.stat();
    if (!safePrivateFile(temporaryIdentity)) return { changed: false, durable: false };
    await handle.close();
    handle = undefined;

    const current = await inspectPrivateTarget(targetPath);
    if (!sameTargetState(before, current)) return { changed: false, durable: false };
    const currentTemporary = await lstat(temporaryPath);
    if (
      !safePrivateFile(currentTemporary)
      || !sameFileIdentity(temporaryIdentity, currentTemporary)
    ) {
      return { changed: false, durable: false };
    }
    const directoryCurrent = await inspectDirectory(directory);
    if (
      directoryCurrent.kind !== 'safe'
      || !sameDirectoryAuthorityIdentity(directoryBefore.identity, directoryCurrent.identity)
    ) {
      return { changed: false, durable: false };
    }
    await rename(temporaryPath, targetPath);
    renamed = true;

    const installed = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const installedInfo = await installed.stat();
      if (!sameFileIdentity(temporaryIdentity, installedInfo)) {
        return { changed: true, durable: false };
      }
    } finally {
      await installed.close();
    }

    const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
    const directoryHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_NOFOLLOW | directoryFlag
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return { changed: true, durable: true };
  } catch {
    return { changed: renamed, durable: false };
  } finally {
    if (handle) {
      try {
        temporaryIdentity ??= await handle.stat();
        await handle.close();
      } catch {
        temporaryIdentity = undefined;
      }
    }
    if (!renamed && temporaryIdentity) {
      await unlinkMatchingTemporary(temporaryPath, temporaryIdentity);
    }
  }
}

function sameDirectoryAuthorityIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.realpath === right.realpath
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
  );
}

async function strictPrivateMonitorDirectories(env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const directory of [appDataHome(env), monitorDataDir(env)]) {
    try {
      const info = await lstat(directory);
      const uid = process.getuid?.();
      if (
        info.isSymbolicLink()
        || !info.isDirectory()
        || (uid !== undefined && info.uid !== uid)
        || (info.mode & 0o777) !== 0o700
        || await realpath(directory) !== directory
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

type PrivateTargetState =
  | { kind: 'missing' }
  | { kind: 'safe'; identity: Stats }
  | { kind: 'unsafe' };

async function inspectPrivateTarget(targetPath: string): Promise<PrivateTargetState> {
  try {
    const info = await lstat(targetPath);
    return safePrivateFile(info)
      ? { kind: 'safe', identity: info }
      : { kind: 'unsafe' };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unsafe' };
  }
}

function sameTargetState(left: PrivateTargetState, right: PrivateTargetState): boolean {
  if (left.kind === 'missing' || right.kind === 'missing') return left.kind === right.kind;
  if (left.kind !== 'safe' || right.kind !== 'safe') return false;
  return sameFileIdentity(left.identity, right.identity);
}

async function unlinkMatchingTemporary(temporaryPath: string, expected: Stats): Promise<void> {
  try {
    const current = await lstat(temporaryPath);
    if (sameFileIdentity(expected, current)) await unlink(temporaryPath);
  } catch {
    // The caller already returns a stable persistence warning; never expose temporary paths.
  }
}

function safePrivateFile(info: Stats): boolean {
  const uid = process.getuid?.();
  return (
    info.isFile()
    && !info.isSymbolicLink()
    && info.nlink === 1
    && (uid === undefined || info.uid === uid)
    && (info.mode & 0o777) === 0o600
  );
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
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

function buildResult(input: {
  currentBytes: number;
  previousBytes?: number;
  deltaBytes?: number;
  thresholdBytes: number;
  growthThresholdBytes: number;
  alert: boolean;
  statePersisted: boolean;
  notificationAttempted: boolean;
  notificationDelivered?: boolean;
  warnings: string[];
}): CodexSessionMonitorResult {
  const warnings = [...new Set(input.warnings)];
  const result: CodexSessionMonitorResult = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    command: 'monitor codex-sessions',
    status: warnings.length === 0 ? 'ok' : 'partial',
    currentBytes: input.currentBytes,
    thresholdBytes: input.thresholdBytes,
    growthThresholdBytes: input.growthThresholdBytes,
    alert: input.alert,
    statePersisted: input.statePersisted,
    notificationAttempted: input.notificationAttempted,
    warnings
  };
  if (input.previousBytes !== undefined) result.previousBytes = input.previousBytes;
  if (input.deltaBytes !== undefined) result.deltaBytes = input.deltaBytes;
  if (input.notificationDelivered !== undefined) {
    result.notificationDelivered = input.notificationDelivered;
  }
  return result;
}

function blockedResult(
  thresholds: { thresholdBytes: number; growthThresholdBytes: number },
  warning: string
): CodexSessionMonitorResult {
  return {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    command: 'monitor codex-sessions',
    status: 'blocked',
    currentBytes: 0,
    thresholdBytes: thresholds.thresholdBytes,
    growthThresholdBytes: thresholds.growthThresholdBytes,
    alert: false,
    statePersisted: false,
    notificationAttempted: false,
    warnings: [warning]
  };
}

function validThreshold(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_THRESHOLD_BYTES;
}

function validByteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validStatfs(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const stats = value as {
      bsize?: unknown;
      blocks?: unknown;
      bfree?: unknown;
      bavail?: unknown;
    };
    return (
      positiveSafeInteger(stats.bsize)
      && nonNegativeSafeInteger(stats.blocks)
      && nonNegativeSafeInteger(stats.bfree)
      && nonNegativeSafeInteger(stats.bavail)
      && Number(stats.bfree) <= Number(stats.blocks)
      && Number(stats.bavail) <= Number(stats.blocks)
    );
  } catch {
    return false;
  }
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}
