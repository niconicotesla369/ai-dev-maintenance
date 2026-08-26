import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  rename,
  unlink
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  runCommand as defaultRunCommand,
  trustedCommandPath as defaultTrustedCommandPath
} from '../commands.js';
import {
  CODEX_SESSION_MONITOR_LABEL,
  codexSessionMonitorLaunchAgentPath,
  resolveHome
} from '../paths.js';
import type { CommandRunResult } from '../types.js';
import type { CodexSessionMonitorNotification } from './codex-sessions.js';

const GIB = 1024 ** 3;
const MAX_THRESHOLD_BYTES = 1024 * GIB;
const LAUNCHCTL_TIMEOUT_MS = 5_000;
const LAUNCHCTL_OUTPUT_LIMIT = 16 * 1024;
const NOTIFICATION_OUTPUT_LIMIT = 4 * 1024;
// Darwin exposes O_EXLOCK through open(2), but Node does not publish the constant.
const DARWIN_O_EXLOCK = 0x00000020;

export const CODEX_MONITOR_NOTIFICATION_SCRIPT = [
  'on run argv',
  '  display notification (item 1 of argv) with title "AIDM Codex session monitor"',
  'end run'
].join('\n');

export type CodexMonitorInstallSpec = {
  nodePath: string;
  cliScriptPath: string;
  thresholdBytes: number;
  growthThresholdBytes: number;
  day: 1;
  hour: 4;
  minute: 30;
};

export type LaunchdMutationResult = {
  status: 'ok' | 'partial' | 'blocked';
  changed: boolean;
  blockedReasons: string[];
  warnings: string[];
};

type CommandOptions = {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

type LaunchdDependencies = {
  env?: NodeJS.ProcessEnv;
  trustedCommandPath?: (name: 'launchctl' | 'osascript') => Promise<string>;
  runCommand?: (
    command: string,
    args: string[],
    options?: CommandOptions
  ) => Promise<CommandRunResult>;
};

type FileSnapshot = {
  realpath: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtimeMs: number;
  nlink: number;
};

type DirectorySnapshot = {
  realpath: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
};

type ProgramInspection =
  | { kind: 'safe'; identity: FileSnapshot }
  | { kind: 'unsafe' };

type DirectoryInspection =
  | { kind: 'safe'; identity: DirectorySnapshot }
  | { kind: 'unsafe' };

type TargetInspection =
  | { kind: 'missing' }
  | { kind: 'safe'; identity: Stats }
  | { kind: 'unsafe' };

export function buildCodexMonitorPlist(spec: CodexMonitorInstallSpec): string {
  if (!validInstallSpec(spec)) throw new Error('invalid Codex monitor install spec');

  const argumentsList = [
    spec.nodePath,
    spec.cliScriptPath,
    '__scheduled-monitor',
    'codex-sessions',
    '--threshold-bytes',
    String(spec.thresholdBytes),
    '--growth-threshold-bytes',
    String(spec.growthThresholdBytes)
  ];
  const argumentsXml = argumentsList
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${CODEX_SESSION_MONITOR_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argumentsXml,
    '  </array>',
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    '    <key>Day</key>',
    `      <integer>${spec.day}</integer>`,
    '    <key>Hour</key>',
    `      <integer>${spec.hour}</integer>`,
    '    <key>Minute</key>',
    `      <integer>${spec.minute}</integer>`,
    '  </dict>',
    '  <key>LowPriorityIO</key>',
    '  <true/>',
    '  <key>Nice</key>',
    '  <integer>10</integer>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

export async function installCodexMonitor(
  spec: CodexMonitorInstallSpec,
  options: LaunchdDependencies = {}
): Promise<LaunchdMutationResult> {
  if (process.platform !== 'darwin') return blocked('platform-unsupported');
  let plist: string;
  try {
    plist = buildCodexMonitorPlist(spec);
  } catch {
    return blocked('invalid-monitor-install-spec');
  }

  const uid = process.getuid?.();
  if (uid === undefined) return blocked('user-domain-unavailable');
  const env = options.env ?? process.env;
  const directory = await inspectLaunchAgentsDirectory(env);
  if (directory.kind !== 'safe') return blocked('launchagents-directory-untrusted');
  const plistPath = codexSessionMonitorLaunchAgentPath(env);
  return await withExclusiveDirectoryLock(
    path.dirname(plistPath),
    directory.identity,
    async () => {
  const targetBefore = await inspectPrivateTarget(plistPath);
  if (targetBefore.kind === 'unsafe') return blocked('monitor-plist-untrusted');

  const nodeBefore = await inspectProgram(spec.nodePath, true);
  if (nodeBefore.kind !== 'safe') return blocked('node-executable-untrusted');
  const cliBefore = await inspectProgram(spec.cliScriptPath, false);
  if (cliBefore.kind !== 'safe') return blocked('cli-script-untrusted');

  const trustedResolver = options.trustedCommandPath ?? defaultTrustedResolver;
  let launchctl: string;
  try {
    launchctl = await trustedResolver('launchctl');
  } catch {
    return blocked('launchctl-untrusted');
  }

  const temporaryPath = path.join(
    path.dirname(plistPath),
    `.${path.basename(plistPath)}.${randomUUID()}.tmp`
  );
  let handle: FileHandle | undefined;
  let temporaryIdentity: Stats | undefined;
  let temporaryCreated = false;
  let renamed = false;
  let outcome: LaunchdMutationResult | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    temporaryCreated = true;
    await handle.writeFile(plist, 'utf8');
    await handle.sync();
    temporaryIdentity = await handle.stat();
    if (!safePrivateFile(temporaryIdentity)) {
      outcome = blocked('monitor-plist-write-failed');
      return outcome;
    }
    await handle.close();
    handle = undefined;

    const temporaryCurrent = await lstat(temporaryPath);
    if (
      !safePrivateFile(temporaryCurrent)
      || !sameFileIdentity(temporaryIdentity, temporaryCurrent)
    ) {
      outcome = blocked('monitor-plist-temporary-drift');
      return outcome;
    }
    const targetCurrent = await inspectPrivateTarget(plistPath);
    if (!sameTargetInspection(targetBefore, targetCurrent)) {
      outcome = blocked('monitor-plist-target-drift');
      return outcome;
    }
    const directoryCurrent = await inspectDirectory(path.dirname(plistPath));
    if (
      directoryCurrent.kind !== 'safe'
      || !sameDirectorySnapshot(directory.identity, directoryCurrent.identity)
    ) {
      outcome = blocked('launchagents-directory-drift');
      return outcome;
    }
    if (!await programsUnchanged(spec, nodeBefore.identity, cliBefore.identity)) {
      outcome = blocked('program-identity-drift');
      return outcome;
    }

    await rename(temporaryPath, plistPath);
    renamed = true;
    const installed = await open(plistPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const installedIdentity = await installed.stat();
      if (!sameFileIdentity(temporaryIdentity, installedIdentity)) {
        outcome = partial('monitor-plist-identity-drift');
        return outcome;
      }
    } finally {
      await installed.close();
    }

    try {
      await syncDirectory(path.dirname(plistPath));
    } catch {
      outcome = partial('monitor-plist-not-durable');
      return outcome;
    }
    if (!await programsUnchanged(spec, nodeBefore.identity, cliBefore.identity)) {
      outcome = partial('program-identity-drift');
      return outcome;
    }
    const installedCurrent = await inspectPrivateTarget(plistPath);
    if (
      installedCurrent.kind !== 'safe'
      || !sameFileIdentity(temporaryIdentity, installedCurrent.identity)
    ) {
      outcome = partial('monitor-plist-identity-drift');
      return outcome;
    }
    const launchAgentsCurrent = await inspectDirectory(path.dirname(plistPath));
    if (
      launchAgentsCurrent.kind !== 'safe'
      || !sameDirectorySnapshot(directory.identity, launchAgentsCurrent.identity)
    ) {
      outcome = partial('launchagents-directory-drift');
      return outcome;
    }

    const commandRunner = options.runCommand ?? defaultRunCommand;
    let commandResult: CommandRunResult;
    try {
      commandResult = await commandRunner(
        launchctl,
        ['bootstrap', `gui/${uid}`, plistPath],
        launchctlOptions()
      );
    } catch {
      outcome = partial('launchctl-bootstrap-failed');
      return outcome;
    }
    if (!certainCommandSuccess(commandResult)) {
      outcome = partial('launchctl-bootstrap-failed');
      return outcome;
    }
    outcome = ok(true);
    return outcome;
  } catch {
    outcome = renamed
      ? partial('monitor-plist-not-durable')
      : blocked('monitor-plist-write-failed');
    return outcome;
  } finally {
    if (handle) {
      if (!temporaryIdentity) {
        try {
          temporaryIdentity = await handle.stat();
        } catch {
          // Without a pinned identity, the temporary path is preserved and reported.
        }
      }
      try {
        await handle.close();
      } catch {
        // Cleanup below still verifies the exact path identity before unlinking.
      }
    }
    if (!renamed && temporaryCreated) {
      const removed = temporaryIdentity
        ? await unlinkMatchingFile(temporaryPath, temporaryIdentity)
        : await confirmFileAbsent(temporaryPath);
      if (!removed && outcome) {
        outcome.status = 'partial';
        outcome.changed = true;
        outcome.blockedReasons = [];
        outcome.warnings = unique([
          ...outcome.warnings,
          'monitor-plist-temporary-cleanup-failed'
        ]);
      }
    }
  }
    }
  );
}

export async function removeCodexMonitor(
  options: LaunchdDependencies = {}
): Promise<LaunchdMutationResult> {
  if (process.platform !== 'darwin') return blocked('platform-unsupported');
  const uid = process.getuid?.();
  if (uid === undefined) return blocked('user-domain-unavailable');
  const env = options.env ?? process.env;
  const directory = await inspectLaunchAgentsDirectory(env);
  if (directory.kind !== 'safe') return blocked('launchagents-directory-untrusted');
  const plistPath = codexSessionMonitorLaunchAgentPath(env);
  return await withExclusiveDirectoryLock(
    path.dirname(plistPath),
    directory.identity,
    async () => {
  const target = await inspectPrivateTarget(plistPath);
  if (target.kind === 'missing') return ok(false);
  if (target.kind !== 'safe') return blocked('monitor-plist-untrusted');

  const trustedResolver = options.trustedCommandPath ?? defaultTrustedResolver;
  let launchctl: string;
  try {
    launchctl = await trustedResolver('launchctl');
  } catch {
    return blocked('launchctl-untrusted');
  }

  let handle: FileHandle;
  try {
    handle = await open(plistPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return blocked('monitor-plist-open-failed');
  }

  let knownExternalChange = false;
  let outcome: LaunchdMutationResult | undefined;
  try {
    const pinned = await handle.stat();
    if (!safePrivateFile(pinned) || !sameFileIdentity(target.identity, pinned)) {
      outcome = blocked('monitor-plist-identity-drift');
      return outcome;
    }
    const directoryCurrent = await inspectDirectory(path.dirname(plistPath));
    const targetCurrent = await inspectPrivateTarget(plistPath);
    if (
      directoryCurrent.kind !== 'safe'
      || !sameDirectorySnapshot(directory.identity, directoryCurrent.identity)
    ) {
      outcome = blocked('launchagents-directory-drift');
      return outcome;
    }
    if (
      targetCurrent.kind !== 'safe'
      || !sameFileIdentity(pinned, targetCurrent.identity)
    ) {
      outcome = blocked('monitor-plist-identity-drift');
      return outcome;
    }

    const commandRunner = options.runCommand ?? defaultRunCommand;
    let commandResult: CommandRunResult;
    try {
      commandResult = await commandRunner(
        launchctl,
        ['bootout', `gui/${uid}`, plistPath],
        launchctlOptions()
      );
    } catch {
      knownExternalChange = true;
      outcome = partial('launchctl-bootout-uncertain');
      return outcome;
    }
    if (!certainCommandSuccess(commandResult)) {
      if (certainCommandFailure(commandResult)) {
        outcome = blocked('launchctl-bootout-failed');
        return outcome;
      }
      knownExternalChange = true;
      outcome = partial('launchctl-bootout-uncertain');
      return outcome;
    }
    knownExternalChange = true;

    const current = await inspectPrivateTarget(plistPath);
    const directoryAfterBootout = await inspectDirectory(path.dirname(plistPath));
    if (
      current.kind !== 'safe'
      || !sameFileIdentity(pinned, current.identity)
    ) {
      outcome = partial('monitor-plist-identity-drift');
      return outcome;
    }
    if (
      directoryAfterBootout.kind !== 'safe'
      || !sameDirectorySnapshot(directory.identity, directoryAfterBootout.identity)
    ) {
      outcome = partial('launchagents-directory-drift');
      return outcome;
    }
    try {
      await unlink(plistPath);
    } catch {
      outcome = partial('monitor-plist-unlink-failed');
      return outcome;
    }
    const unlinked = await handle.stat();
    if (!sameUnlinkedIdentity(pinned, unlinked)) {
      outcome = partial('monitor-plist-unlink-unverified');
      return outcome;
    }
    try {
      await syncDirectory(path.dirname(plistPath));
    } catch {
      outcome = partial('monitor-plist-directory-sync-failed');
      return outcome;
    }
    outcome = ok(true);
    return outcome;
  } catch {
    outcome = knownExternalChange
      ? partial('monitor-plist-removal-uncertain')
      : blocked('monitor-plist-inspection-failed');
    return outcome;
  } finally {
    try {
      await handle.close();
    } catch {
      if (outcome) {
        outcome.status = knownExternalChange ? 'partial' : 'blocked';
        outcome.changed = knownExternalChange;
        outcome.blockedReasons = knownExternalChange ? [] : ['monitor-plist-close-failed'];
        outcome.warnings = knownExternalChange ? unique([
          ...outcome.warnings,
          'monitor-plist-close-failed'
        ]) : [];
      }
    }
  }
    }
  );
}

export async function sendCodexSessionMonitorNotification(
  notification: CodexSessionMonitorNotification,
  options: LaunchdDependencies = {}
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  if (!validNotification(notification)) return false;
  const trustedResolver = options.trustedCommandPath ?? defaultTrustedResolver;
  let osascript: string;
  try {
    osascript = await trustedResolver('osascript');
  } catch {
    return false;
  }

  const message = notification.measurementComplete
    ? `Codex sessions use ${formatBytes(notification.currentBytes)}. Open AIDM to review.`
    : `Codex sessions are at least ${formatBytes(notification.currentBytes)} (metadata scan incomplete). Open AIDM to review.`;
  const commandRunner = options.runCommand ?? defaultRunCommand;
  try {
    const result = await commandRunner(
      osascript,
      ['-e', CODEX_MONITOR_NOTIFICATION_SCRIPT, message],
      {
        timeoutMs: LAUNCHCTL_TIMEOUT_MS,
        maxStdoutBytes: NOTIFICATION_OUTPUT_LIMIT,
        maxStderrBytes: NOTIFICATION_OUTPUT_LIMIT
      }
    );
    return certainCommandSuccess(result);
  } catch {
    return false;
  }
}

function validInstallSpec(spec: CodexMonitorInstallSpec): boolean {
  return (
    validAbsolutePath(spec.nodePath)
    && validAbsolutePath(spec.cliScriptPath)
    && validThreshold(spec.thresholdBytes)
    && validThreshold(spec.growthThresholdBytes)
    && spec.day === 1
    && spec.hour === 4
    && spec.minute === 30
  );
}

function validAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string'
    && path.isAbsolute(value)
    && path.resolve(value) === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validThreshold(value: unknown): value is number {
  return (
    Number.isSafeInteger(value)
    && Number(value) >= 1
    && Number(value) <= MAX_THRESHOLD_BYTES
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function inspectProgram(
  programPath: string,
  executable: boolean
): Promise<ProgramInspection> {
  if (!validAbsolutePath(programPath)) return { kind: 'unsafe' };
  try {
    const info = await lstat(programPath);
    const resolved = info.isSymbolicLink() ? undefined : await realpath(programPath);
    const uid = process.getuid?.();
    const ownedByCurrentUser = uid !== undefined && info.uid === uid;
    const ownerSafe = info.uid === 0 || ownedByCurrentUser;
    const permissionSafe = executable
      ? (info.mode & (ownedByCurrentUser ? 0o100 : 0o001)) !== 0
      : (info.mode & (ownedByCurrentUser ? 0o400 : 0o004)) !== 0;
    if (
      info.isSymbolicLink()
      || !info.isFile()
      || info.nlink !== 1
      || resolved !== programPath
      || !ownerSafe
      || (info.mode & 0o022) !== 0
      || !permissionSafe
    ) {
      return { kind: 'unsafe' };
    }
    return {
      kind: 'safe',
      identity: fileSnapshot(resolved, info)
    };
  } catch {
    return { kind: 'unsafe' };
  }
}

async function programsUnchanged(
  spec: CodexMonitorInstallSpec,
  nodeBefore: FileSnapshot,
  cliBefore: FileSnapshot
): Promise<boolean> {
  const node = await inspectProgram(spec.nodePath, true);
  const cli = await inspectProgram(spec.cliScriptPath, false);
  return (
    node.kind === 'safe'
    && cli.kind === 'safe'
    && sameFileSnapshot(nodeBefore, node.identity)
    && sameFileSnapshot(cliBefore, cli.identity)
  );
}

async function inspectLaunchAgentsDirectory(
  env: NodeJS.ProcessEnv
): Promise<DirectoryInspection> {
  const configuredHome = env.HOME;
  if (!configuredHome || !validAbsolutePath(configuredHome)) return { kind: 'unsafe' };
  const home = resolveHome(env);
  const directories = [
    home,
    path.join(home, 'Library'),
    path.join(home, 'Library', 'LaunchAgents')
  ];
  let launchAgents: DirectoryInspection = { kind: 'unsafe' };
  for (const directory of directories) {
    const inspection = await inspectDirectory(directory);
    if (inspection.kind !== 'safe') return { kind: 'unsafe' };
    launchAgents = inspection;
  }
  return launchAgents;
}

async function inspectDirectory(directory: string): Promise<DirectoryInspection> {
  try {
    const info = await lstat(directory);
    const uid = process.getuid?.();
    if (
      info.isSymbolicLink()
      || !info.isDirectory()
      || (uid !== undefined && info.uid !== uid)
      || (info.mode & 0o022) !== 0
    ) {
      return { kind: 'unsafe' };
    }
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
        gid: info.gid
      }
    };
  } catch {
    return { kind: 'unsafe' };
  }
}

async function inspectPrivateTarget(targetPath: string): Promise<TargetInspection> {
  try {
    const info = await lstat(targetPath);
    if (!safePrivateFile(info) || await realpath(targetPath) !== targetPath) {
      return { kind: 'unsafe' };
    }
    return { kind: 'safe', identity: info };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unsafe' };
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

function fileSnapshot(resolved: string, info: Stats): FileSnapshot {
  return {
    realpath: resolved,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    mtimeMs: info.mtimeMs,
    nlink: info.nlink
  };
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.realpath === right.realpath
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

function sameDirectorySnapshot(left: DirectorySnapshot, right: DirectorySnapshot): boolean {
  return (
    left.realpath === right.realpath
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
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

function sameTargetInspection(left: TargetInspection, right: TargetInspection): boolean {
  if (left.kind === 'missing' || right.kind === 'missing') return left.kind === right.kind;
  if (left.kind !== 'safe' || right.kind !== 'safe') return false;
  return sameFileIdentity(left.identity, right.identity);
}

function sameUnlinkedIdentity(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.uid === after.uid
    && before.gid === after.gid
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.nlink === 1
    && after.nlink === 0
  );
}

async function unlinkMatchingFile(filePath: string, expected: Stats): Promise<boolean> {
  try {
    const current = await lstat(filePath);
    if (!sameFileIdentity(expected, current)) return false;
    await unlink(filePath);
    return true;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
}

async function confirmFileAbsent(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return false;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
}

async function withExclusiveDirectoryLock(
  directory: string,
  expected: DirectorySnapshot,
  action: () => Promise<LaunchdMutationResult>
): Promise<LaunchdMutationResult> {
  const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
  let handle: FileHandle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK
        | directoryFlag
        | DARWIN_O_EXLOCK
    );
  } catch (error) {
    const code = errorCode(error);
    return blocked(
      code === 'EAGAIN' || code === 'EWOULDBLOCK'
        ? 'monitor-operation-in-progress'
        : 'monitor-lock-unavailable'
    );
  }

  let result: LaunchdMutationResult;
  try {
    const pinned = await handle.stat();
    const current = await inspectDirectory(directory);
    if (
      !sameDirectoryHandleSnapshot(expected, pinned)
      || current.kind !== 'safe'
      || !sameDirectorySnapshot(expected, current.identity)
    ) {
      result = blocked('launchagents-directory-drift');
    } else {
      result = await action();
    }
  } catch {
    result = blocked('monitor-operation-failed');
  }

  try {
    await handle.close();
  } catch {
    if (result.changed) {
      result.status = 'partial';
      result.blockedReasons = [];
      result.warnings = unique([...result.warnings, 'monitor-lock-release-failed']);
    } else {
      result.status = 'blocked';
      result.blockedReasons = unique([
        ...result.blockedReasons,
        'monitor-lock-release-failed'
      ]);
      result.warnings = [];
    }
  }
  return result;
}

function sameDirectoryHandleSnapshot(expected: DirectorySnapshot, current: Stats): boolean {
  return (
    current.isDirectory()
    && expected.dev === current.dev
    && expected.ino === current.ino
    && expected.mode === current.mode
    && expected.uid === current.uid
    && expected.gid === current.gid
  );
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | directoryFlag
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function launchctlOptions(): CommandOptions {
  return {
    timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    maxStdoutBytes: LAUNCHCTL_OUTPUT_LIMIT,
    maxStderrBytes: LAUNCHCTL_OUTPUT_LIMIT
  };
}

function certainCommandSuccess(result: CommandRunResult): boolean {
  return (
    result.code === 0
    && (result.signal === undefined || result.signal === null)
    && !result.timedOut
    && !result.stdoutTruncated
    && !result.stderrTruncated
    && result.stderr.length === 0
  );
}

function certainCommandFailure(result: CommandRunResult): boolean {
  return (
    result.code !== null
    && result.code !== 0
    && (result.signal === undefined || result.signal === null)
    && !result.timedOut
    && !result.stdoutTruncated
    && !result.stderrTruncated
  );
}

function validNotification(value: CodexSessionMonitorNotification): boolean {
  return (
    validByteCount(value.currentBytes)
    && validThreshold(value.thresholdBytes)
    && validThreshold(value.growthThresholdBytes)
    && typeof value.measurementComplete === 'boolean'
    && (value.previousBytes === undefined || validByteCount(value.previousBytes))
    && (
      value.deltaBytes === undefined
      || (Number.isSafeInteger(value.deltaBytes) && Number.isFinite(value.deltaBytes))
    )
  );
}

function validByteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 'B';
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024 || candidate === units[units.length - 1]) break;
  }
  const digits = value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(digits)} ${unit}`;
}

async function defaultTrustedResolver(name: 'launchctl' | 'osascript'): Promise<string> {
  return await defaultTrustedCommandPath(name);
}

function blocked(reason: string): LaunchdMutationResult {
  return {
    status: 'blocked',
    changed: false,
    blockedReasons: [reason],
    warnings: []
  };
}

function partial(warning: string): LaunchdMutationResult {
  return {
    status: 'partial',
    changed: true,
    blockedReasons: [],
    warnings: [warning]
  };
}

function ok(changed: boolean): LaunchdMutationResult {
  return {
    status: 'ok',
    changed,
    blockedReasons: [],
    warnings: []
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
